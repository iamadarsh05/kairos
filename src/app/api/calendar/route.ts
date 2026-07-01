// POST /api/calendar
//
// Executes a calendar tool call on the server (where the service-account
// credentials live). The browser receives a tool call from Gemini Live, forwards
// it here as { tool, args }, and relays the JSON result back to the model.
//
// Returning a structured { ok, ... } shape — including human-friendly summaries —
// helps the model speak naturally about the outcome without re-deriving times.

import { NextResponse } from "next/server";
import { DateTime } from "luxon";
import { getConfig } from "@/lib/config";
import {
  findFreeSlots,
  listEvents,
  createEvent,
  updateEvent,
  deleteEvent,
} from "@/lib/calendar";
import { sendConfirmationEmail } from "@/lib/email";

export const dynamic = "force-dynamic";

type ToolRequest = {
  tool: string;
  args: Record<string, unknown>;
};

export async function POST(req: Request) {
  let body: ToolRequest;
  try {
    body = (await req.json()) as ToolRequest;
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON body." }, { status: 400 });
  }

  const { tool, args } = body;
  const cfg = getConfig();

  try {
    switch (tool) {
      case "find_free_slots": {
        const durationMinutes = Number(args.duration_minutes);
        const timeOfDay = args.time_of_day as
          | "morning"
          | "afternoon"
          | "evening"
          | "any"
          | undefined;
        const slots = await findFreeSlots({
          rangeStartISO: String(args.range_start),
          rangeEndISO: String(args.range_end),
          durationMinutes,
          timeOfDay,
          earliestHour:
            args.earliest_hour != null ? Number(args.earliest_hour) : undefined,
          latestHour:
            args.latest_hour != null ? Number(args.latest_hour) : undefined,
        });

        if (slots.length > 0) {
          return NextResponse.json({
            ok: true,
            count: slots.length,
            slots,
            summary: `Found ${slots.length} option(s): ${slots
              .map((s) => s.label)
              .join("; ")}.`,
          });
        }

        // CONFLICT RESOLUTION (deterministic): the requested window is full, so
        // proactively compute the nearest real alternatives — first the same
        // days ignoring the time-of-day filter, then a widened 14-day window —
        // and hand them to the agent so it never dead-ends.
        const sameDaysAnyTime =
          timeOfDay && timeOfDay !== "any"
            ? await findFreeSlots({
                rangeStartISO: String(args.range_start),
                rangeEndISO: String(args.range_end),
                durationMinutes,
                maxResults: 3,
              })
            : [];
        const widenedEnd = DateTime.fromISO(String(args.range_start), {
          zone: cfg.timezone,
        })
          .plus({ days: 14 })
          .toISO()!;
        const widened =
          sameDaysAnyTime.length > 0
            ? []
            : await findFreeSlots({
                rangeStartISO: String(args.range_start),
                rangeEndISO: widenedEnd,
                durationMinutes,
                maxResults: 3,
              });
        const alternatives = sameDaysAnyTime.length ? sameDaysAnyTime : widened;

        return NextResponse.json({
          ok: true,
          count: 0,
          slots: [],
          alternatives,
          summary:
            alternatives.length > 0
              ? `That exact window is fully booked. Do NOT give up — offer these nearest alternatives conversationally and ask which works: ${alternatives
                  .map((s) => s.label)
                  .join("; ")}.`
              : "That window is full and no nearby openings were found in the next two weeks. Ask the user for a different week or a shorter duration.",
        });
      }

      case "list_events": {
        const events = await listEvents({
          timeMinISO: String(args.time_min),
          timeMaxISO: String(args.time_max),
          query: args.query ? String(args.query) : undefined,
        });
        return NextResponse.json({
          ok: true,
          count: events.length,
          events,
          summary:
            events.length === 0
              ? "No matching events found in that window."
              : `Found ${events.length} event(s): ${events
                  .map((e) => e.label)
                  .join("; ")}.`,
        });
      }

      case "create_event": {
        const startISO = String(args.start);
        const endISO = String(args.end);
        const summaryText = String(args.summary ?? "Meeting");
        const attendees = Array.isArray(args.attendees)
          ? (args.attendees as unknown[]).map(String)
          : [];
        const created = await createEvent({
          summary: summaryText,
          startISO,
          endISO,
          description: args.description ? String(args.description) : undefined,
          attendees,
        });

        const email = await sendConfirmationEmail({
          summary: summaryText,
          startISO,
          endISO,
          htmlLink: created.htmlLink,
          attendees,
          kind: "booked",
        });

        return NextResponse.json({
          ok: true,
          event: { ...created, kind: "booked" },
          emailed: email.sent,
          summary:
            `Booked: ${created.label}.` +
            (attendees.length ? ` Guests: ${attendees.join(", ")}.` : "") +
            (email.sent ? " A confirmation email has been sent." : ""),
        });
      }

      case "reschedule_event": {
        const newStart = String(args.new_start);
        const newEnd = String(args.new_end);
        const updated = await updateEvent({
          eventId: String(args.event_id),
          startISO: newStart,
          endISO: newEnd,
        });

        const email = await sendConfirmationEmail({
          summary: updated.summary,
          startISO: newStart,
          endISO: newEnd,
          htmlLink: updated.htmlLink,
          kind: "updated",
        });

        return NextResponse.json({
          ok: true,
          event: { ...updated, kind: "updated" },
          emailed: email.sent,
          summary:
            `Rescheduled: ${updated.label}.` +
            (email.sent ? " An updated confirmation was emailed." : ""),
        });
      }

      case "cancel_event": {
        const removed = await deleteEvent({ eventId: String(args.event_id) });

        let emailed = false;
        if (removed.startISO && removed.endISO) {
          const email = await sendConfirmationEmail({
            summary: removed.summary,
            startISO: removed.startISO,
            endISO: removed.endISO,
            kind: "cancelled",
          });
          emailed = email.sent;
        }

        return NextResponse.json({
          ok: true,
          event: {
            label: removed.summary,
            kind: "cancelled",
          },
          emailed,
          summary: `Cancelled: ${removed.summary}.`,
        });
      }

      default:
        return NextResponse.json(
          { ok: false, error: `Unknown tool: ${tool}` },
          { status: 400 }
        );
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Unknown error";
    // Surface a clean message the model can relay, plus debug context server-side.
    console.error(`[calendar] tool=${tool} failed:`, message);
    return NextResponse.json({
      ok: false,
      error: message,
      summary: `The calendar operation failed: ${message}. Apologize briefly and offer to try again.`,
      now: DateTime.now().setZone(cfg.timezone).toISO(),
    });
  }
}
