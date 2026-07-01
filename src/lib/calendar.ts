// Google Calendar integration via a service account.
//
// Why a service account (not OAuth)? It needs no interactive consent screen, so
// the deployed agent can read/write a calendar with zero user clicks. The user
// shares their calendar with the service-account email once, and we're done.
//
// The three capabilities the agent's tools map onto:
//   - findFreeSlots: the core "where can this meeting go?" search
//   - listEvents:    lets the agent resolve references like "my 5 PM meeting"
//   - createEvent:   books the chosen slot
//
// All time math is timezone-aware via luxon so vague requests ("Tuesday
// afternoon", "last weekday of the month") resolve to the right wall-clock time.

import { google, calendar_v3 } from "googleapis";
import { DateTime, Interval } from "luxon";
import { getConfig } from "./config";

function getCalendarClient(): calendar_v3.Calendar {
  const cfg = getConfig();
  if (!cfg.clientEmail || !cfg.privateKey) {
    throw new Error(
      "Google service account not configured. Set GOOGLE_CLIENT_EMAIL and GOOGLE_PRIVATE_KEY."
    );
  }
  const auth = new google.auth.JWT({
    email: cfg.clientEmail,
    key: cfg.privateKey,
    scopes: ["https://www.googleapis.com/auth/calendar"],
  });
  return google.calendar({ version: "v3", auth });
}

export interface FreeSlot {
  /** ISO 8601 with timezone offset, e.g. 2026-07-07T14:00:00-04:00 */
  start: string;
  end: string;
  /** Human label in the agent's timezone, e.g. "Tue, Jul 7, 2:00 PM". */
  label: string;
}

export interface CalendarEvent {
  id: string;
  summary: string;
  start: string;
  end: string;
  label: string;
}

type TimeOfDay = "morning" | "afternoon" | "evening" | "any";

const TIME_OF_DAY_BOUNDS: Record<
  Exclude<TimeOfDay, "any">,
  { startHour: number; endHour: number }
> = {
  morning: { startHour: 6, endHour: 12 },
  afternoon: { startHour: 12, endHour: 17 },
  evening: { startHour: 17, endHour: 22 },
};

function fmtLabel(dt: DateTime): string {
  return dt.toFormat("ccc, LLL d, h:mm a");
}

/**
 * Find concrete free slots of `durationMinutes` between `rangeStartISO` and
 * `rangeEndISO`, restricted to working hours and (optionally) a time-of-day.
 *
 * Strategy: ask Calendar's freebusy API for busy intervals, subtract them from
 * the working-hour windows of each day in range, then slice the leftover gaps
 * into candidate start times. Returns at most `maxResults` slots.
 */
export async function findFreeSlots(params: {
  rangeStartISO: string;
  rangeEndISO: string;
  durationMinutes: number;
  timeOfDay?: TimeOfDay;
  earliestHour?: number; // hard lower bound, e.g. "after 7 PM" => 19
  latestHour?: number; // hard upper bound
  maxResults?: number;
}): Promise<FreeSlot[]> {
  const cfg = getConfig();
  const cal = getCalendarClient();
  const zone = cfg.timezone;
  const maxResults = params.maxResults ?? 4;
  const duration = Math.max(1, Math.round(params.durationMinutes));

  const rangeStart = DateTime.fromISO(params.rangeStartISO, { zone });
  const rangeEnd = DateTime.fromISO(params.rangeEndISO, { zone });
  if (!rangeStart.isValid || !rangeEnd.isValid || rangeEnd <= rangeStart) {
    throw new Error("Invalid date range supplied to findFreeSlots.");
  }

  // 1. Pull busy intervals from Calendar.
  const fb = await cal.freebusy.query({
    requestBody: {
      timeMin: rangeStart.toISO()!,
      timeMax: rangeEnd.toISO()!,
      timeZone: zone,
      items: [{ id: cfg.calendarId }],
    },
  });
  const busyRaw = fb.data.calendars?.[cfg.calendarId]?.busy ?? [];
  const busy: Interval[] = busyRaw
    .map((b) =>
      Interval.fromDateTimes(
        DateTime.fromISO(b.start!, { zone }),
        DateTime.fromISO(b.end!, { zone })
      )
    )
    .filter((iv) => iv.isValid);

  // 2. Determine the per-day allowed window (working hours ∩ time-of-day ∩ bounds).
  let dayStartHour = cfg.workDayStart;
  let dayEndHour = cfg.workDayEnd;
  if (params.timeOfDay && params.timeOfDay !== "any") {
    const tod = TIME_OF_DAY_BOUNDS[params.timeOfDay];
    dayStartHour = Math.max(dayStartHour, tod.startHour);
    dayEndHour = Math.min(dayEndHour, tod.endHour);
  }
  if (typeof params.earliestHour === "number")
    dayStartHour = Math.max(dayStartHour, params.earliestHour);
  if (typeof params.latestHour === "number")
    dayEndHour = Math.min(dayEndHour, params.latestHour);

  if (dayEndHour <= dayStartHour) return []; // window collapsed — nothing to offer

  const now = DateTime.now().setZone(zone);
  if (!now.isValid) {
    throw new Error(`Invalid AGENT_TIMEZONE: "${zone}".`);
  }
  const slots: FreeSlot[] = [];

  // 3. Walk each calendar day in the range.
  let cursorDay = rangeStart.startOf("day");
  const lastDay = rangeEnd.startOf("day");
  while (cursorDay <= lastDay && slots.length < maxResults) {
    let windowStart = cursorDay.set({
      hour: dayStartHour,
      minute: 0,
      second: 0,
      millisecond: 0,
    });
    let windowEnd = cursorDay.set({
      hour: dayEndHour,
      minute: 0,
      second: 0,
      millisecond: 0,
    });

    // Clamp the window to the overall requested range and to "not in the past".
    if (windowStart < rangeStart) windowStart = rangeStart;
    if (windowEnd > rangeEnd) windowEnd = rangeEnd;
    if (windowStart < now) windowStart = now.plus({ minutes: 1 });

    // 4. Probe candidate starts at 15-min granularity within the window.
    let probe = ceilToQuarterHour(windowStart);
    while (
      probe.plus({ minutes: duration }) <= windowEnd &&
      slots.length < maxResults
    ) {
      const candidate = Interval.fromDateTimes(
        probe,
        probe.plus({ minutes: duration })
      );
      const conflicts = busy.some((b) => b.overlaps(candidate));
      if (!conflicts) {
        slots.push({
          start: probe.toISO()!,
          end: probe.plus({ minutes: duration }).toISO()!,
          label: fmtLabel(probe),
        });
        // Jump past this slot so we don't return ten back-to-back options.
        probe = probe.plus({ minutes: duration });
      } else {
        probe = probe.plus({ minutes: 15 });
      }
    }

    cursorDay = cursorDay.plus({ days: 1 });
  }

  return slots;
}

function ceilToQuarterHour(dt: DateTime): DateTime {
  const minute = dt.minute;
  const add = (15 - (minute % 15)) % 15;
  const rounded = dt.plus({ minutes: add }).set({ second: 0, millisecond: 0 });
  return rounded;
}

/**
 * List events between two ISO timestamps. Lets the agent resolve references
 * like "the Project Alpha Kick-off" or "my last meeting of the day".
 */
export async function listEvents(params: {
  timeMinISO: string;
  timeMaxISO: string;
  query?: string;
  maxResults?: number;
}): Promise<CalendarEvent[]> {
  const cfg = getConfig();
  const cal = getCalendarClient();
  const zone = cfg.timezone;

  const res = await cal.events.list({
    calendarId: cfg.calendarId,
    timeMin: params.timeMinISO,
    timeMax: params.timeMaxISO,
    q: params.query,
    singleEvents: true,
    orderBy: "startTime",
    maxResults: params.maxResults ?? 25,
  });

  const items = res.data.items ?? [];
  return items
    .filter((e) => e.start?.dateTime || e.start?.date)
    .map((e) => {
      const startISO = e.start!.dateTime ?? e.start!.date!;
      const endISO = e.end?.dateTime ?? e.end?.date ?? startISO;
      const startDt = DateTime.fromISO(startISO, { zone });
      return {
        id: e.id ?? "",
        summary: e.summary ?? "(no title)",
        start: startISO,
        end: endISO,
        label: `${e.summary ?? "(no title)"} — ${fmtLabel(startDt)}`,
      };
    });
}

/**
 * Create (book) an event. Returns the created event's id and a human label.
 */
export async function createEvent(params: {
  summary: string;
  startISO: string;
  endISO: string;
  description?: string;
  attendees?: string[];
}): Promise<{
  id: string;
  htmlLink: string;
  label: string;
  attendees: string[];
}> {
  const cfg = getConfig();
  const cal = getCalendarClient();
  const zone = cfg.timezone;

  // NOTE: a service account can't add real Google attendees for a personal
  // Gmail (needs Domain-Wide Delegation), so we record guests in the event
  // description instead and email them separately. This avoids the API error
  // while still capturing who's invited.
  const attendees = (params.attendees ?? []).filter(Boolean);
  const description = [
    params.description,
    attendees.length ? `Guests: ${attendees.join(", ")}` : "",
    "— Scheduled with Kairos 🗓️",
  ]
    .filter(Boolean)
    .join("\n\n");

  const res = await cal.events.insert({
    calendarId: cfg.calendarId,
    requestBody: {
      summary: params.summary,
      description: description || undefined,
      start: { dateTime: params.startISO, timeZone: zone },
      end: { dateTime: params.endISO, timeZone: zone },
    },
  });

  const startDt = DateTime.fromISO(params.startISO, { zone });
  return {
    id: res.data.id ?? "",
    htmlLink: res.data.htmlLink ?? "",
    label: `${params.summary} on ${fmtLabel(startDt)}`,
    attendees,
  };
}

/** Reschedule (move) an existing event to a new time. */
export async function updateEvent(params: {
  eventId: string;
  startISO: string;
  endISO: string;
  summary?: string;
}): Promise<{ id: string; htmlLink: string; label: string; summary: string }> {
  const cfg = getConfig();
  const cal = getCalendarClient();
  const zone = cfg.timezone;

  const res = await cal.events.patch({
    calendarId: cfg.calendarId,
    eventId: params.eventId,
    requestBody: {
      summary: params.summary,
      start: { dateTime: params.startISO, timeZone: zone },
      end: { dateTime: params.endISO, timeZone: zone },
    },
  });

  const startDt = DateTime.fromISO(params.startISO, { zone });
  const title = res.data.summary ?? params.summary ?? "Meeting";
  return {
    id: res.data.id ?? params.eventId,
    htmlLink: res.data.htmlLink ?? "",
    label: `${title} on ${fmtLabel(startDt)}`,
    summary: title,
  };
}

/** Cancel (delete) an existing event. Returns its title for confirmation. */
export async function deleteEvent(params: {
  eventId: string;
}): Promise<{
  id: string;
  summary: string;
  startISO?: string;
  endISO?: string;
}> {
  const cfg = getConfig();
  const cal = getCalendarClient();

  // Fetch title/time first so we can confirm exactly what was cancelled.
  let summary = "Meeting";
  let startISO: string | undefined;
  let endISO: string | undefined;
  try {
    const got = await cal.events.get({
      calendarId: cfg.calendarId,
      eventId: params.eventId,
    });
    summary = got.data.summary ?? summary;
    startISO = got.data.start?.dateTime ?? got.data.start?.date ?? undefined;
    endISO = got.data.end?.dateTime ?? got.data.end?.date ?? undefined;
  } catch {
    /* fall back to generic title */
  }

  await cal.events.delete({
    calendarId: cfg.calendarId,
    eventId: params.eventId,
  });
  return { id: params.eventId, summary, startISO, endISO };
}
