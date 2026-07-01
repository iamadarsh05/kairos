// The "brain" of the agent: tool declarations + system prompt.
//
// Both are generated server-side and baked into the ephemeral token's session
// config, so the client never sees (or can tamper with) the instructions.
//
// Design philosophy: keep the TOOLS dumb and the PROMPT smart. The tools just
// read/write the calendar over precise ISO timestamps. ALL the natural-language
// reasoning — "Tuesday afternoon", "last weekday of the month", "an hour before
// my 5 PM meeting", remembering the duration across turns — happens in the LLM,
// guided by the prompt. That keeps date logic flexible without brittle parsers.

import { DateTime } from "luxon";
import { Type } from "@google/genai";
import { getConfig } from "./config";

// ---------------------------------------------------------------------------
// Tool (function) declarations the model can call.
// ---------------------------------------------------------------------------
export function getToolDeclarations() {
  return [
    {
      functionDeclarations: [
        {
          name: "find_free_slots",
          description:
            "Search the user's calendar for available meeting slots of a given " +
            "duration within a date/time window. Returns concrete candidate start " +
            "times that don't conflict with existing events and fall inside working " +
            "hours. Call this once you know the duration and have resolved the user's " +
            "time preference into a concrete date range. Prefer a window of 1–7 days.",
          parameters: {
            type: Type.OBJECT,
            properties: {
              range_start: {
                type: Type.STRING,
                description:
                  "Start of the search window, ISO 8601 WITH timezone offset " +
                  "(e.g. 2026-07-07T00:00:00-04:00). Compute concrete dates from " +
                  "the 'Current date/time' given in your instructions.",
              },
              range_end: {
                type: Type.STRING,
                description:
                  "End of the search window, ISO 8601 with timezone offset.",
              },
              duration_minutes: {
                type: Type.NUMBER,
                description:
                  "Meeting length in minutes. Remember this across turns unless " +
                  "the user changes it.",
              },
              time_of_day: {
                type: Type.STRING,
                description:
                  "Optional coarse filter. One of: morning, afternoon, evening, any.",
              },
              earliest_hour: {
                type: Type.NUMBER,
                description:
                  "Optional hard lower bound on start hour, 0–23. Use for requests " +
                  "like 'after 7 PM' (=> 19).",
              },
              latest_hour: {
                type: Type.NUMBER,
                description:
                  "Optional hard upper bound on start hour, 0–23. Use for deadlines " +
                  "like 'before 6 PM' (=> 18).",
              },
            },
            required: ["range_start", "range_end", "duration_minutes"],
          },
        },
        {
          name: "list_events",
          description:
            "Look up existing events on the calendar within a time window, " +
            "optionally filtered by a text query. Use this to RESOLVE REFERENCES " +
            "to other events before scheduling — e.g. 'an hour before my 5 PM " +
            "meeting on Friday', 'a day after the Project Alpha Kick-off', or " +
            "'after my last meeting of the day'. Read the returned event times, " +
            "then reason about the target window yourself.",
          parameters: {
            type: Type.OBJECT,
            properties: {
              time_min: {
                type: Type.STRING,
                description: "Window start, ISO 8601 with timezone offset.",
              },
              time_max: {
                type: Type.STRING,
                description: "Window end, ISO 8601 with timezone offset.",
              },
              query: {
                type: Type.STRING,
                description:
                  "Optional free-text search over event titles, e.g. 'Project Alpha'.",
              },
            },
            required: ["time_min", "time_max"],
          },
        },
        {
          name: "create_event",
          description:
            "Book a meeting on the calendar. ONLY call this after the user has " +
            "explicitly confirmed a specific slot. Confirm the final details back " +
            "to the user in speech after booking.",
          parameters: {
            type: Type.OBJECT,
            properties: {
              summary: {
                type: Type.STRING,
                description:
                  "Event title. If the user didn't give one, use a sensible " +
                  "default like 'Meeting'.",
              },
              start: {
                type: Type.STRING,
                description:
                  "Start time, ISO 8601 with timezone offset, matching one of the " +
                  "slots you offered.",
              },
              end: {
                type: Type.STRING,
                description: "End time, ISO 8601 with timezone offset.",
              },
              description: {
                type: Type.STRING,
                description: "Optional event description/notes.",
              },
              attendees: {
                type: Type.ARRAY,
                items: { type: Type.STRING },
                description:
                  "Optional list of guest email addresses to invite. Ask the " +
                  "user for emails if they want to add people.",
              },
            },
            required: ["summary", "start", "end"],
          },
        },
        {
          name: "reschedule_event",
          description:
            "Move an existing event to a new time. First use list_events to " +
            "find the event and its id, then call this with the new start/end. " +
            "Confirm the new time back to the user afterward.",
          parameters: {
            type: Type.OBJECT,
            properties: {
              event_id: {
                type: Type.STRING,
                description: "The id of the event to move (from list_events).",
              },
              new_start: {
                type: Type.STRING,
                description: "New start, ISO 8601 with timezone offset.",
              },
              new_end: {
                type: Type.STRING,
                description: "New end, ISO 8601 with timezone offset.",
              },
            },
            required: ["event_id", "new_start", "new_end"],
          },
        },
        {
          name: "cancel_event",
          description:
            "Cancel (delete) an existing event. First use list_events to find " +
            "the event and its id. ALWAYS confirm with the user which meeting " +
            "before cancelling — never cancel without explicit confirmation.",
          parameters: {
            type: Type.OBJECT,
            properties: {
              event_id: {
                type: Type.STRING,
                description: "The id of the event to cancel (from list_events).",
              },
            },
            required: ["event_id"],
          },
        },
      ],
    },
  ];
}

// ---------------------------------------------------------------------------
// System prompt. This is where the agentic behavior is engineered.
// ---------------------------------------------------------------------------
export function getSystemPrompt(): string {
  const cfg = getConfig();
  const now = DateTime.now().setZone(cfg.timezone);
  const nowStr = now.toFormat("cccc, LLLL d, yyyy, h:mm a ZZZZ");

  return `You are "Kairos", a warm, efficient voice assistant that helps the user book meetings on their Google Calendar through natural spoken conversation.

# Context you can rely on
- Current date/time: ${nowStr}
- Timezone: ${cfg.timezone}
- Working hours you may offer: ${cfg.workDayStart}:00 to ${cfg.workDayEnd}:00, Monday–Friday by default.
- ALL dates you pass to tools must be concrete ISO 8601 strings WITH the timezone offset, derived from the current date/time above. Never send a tool a vague phrase.

# Your job, turn by turn
1. Figure out three things before searching: (a) meeting DURATION, (b) a DATE window, (c) any TIME-OF-DAY preference.
2. If you are missing the duration, ASK for it — that is the one thing you almost always need. Don't guess it.
3. If the user gives a time preference, you usually have enough to search even if details are fuzzy — search first, then refine. Don't over-interrogate; one clarifying question at a time, only when genuinely needed.
4. Once you can, call find_free_slots, then OFFER 2–3 specific options in natural speech ("I have 2:00 PM or 4:30 PM on Tuesday — which works?").
5. When the user picks one and confirms, call create_event, then confirm warmly.

# Memory & context (critical — you are graded on this)
- REMEMBER the duration, day, and preferences across turns. If the user later changes ONE thing ("actually make it an hour"), keep everything else and re-search with the new value. Do not re-ask what you already know.
- If the user references a "usual" meeting, assume 30 minutes unless told otherwise, and say that you're assuming it.

# Smart time parsing — resolve these YOURSELF into concrete date ranges
- "Tuesday afternoon" → the next upcoming Tuesday, time_of_day=afternoon.
- "late next week" → Thursday–Friday of the following calendar week.
- "the morning of June 20th" → that date, time_of_day=morning.
- "last weekday of this month" → compute it (skip weekends).
- "before my flight Friday at 6 PM" → search Friday with latest_hour set so the meeting ENDS by 6 PM (deadline reasoning, work backward).
- "an hour before my 5 PM meeting on Friday" → first list_events on Friday to find that meeting, then target the hour before it.
- "a day or two after the 'Project Alpha Kick-off'" → list_events with query 'Project Alpha' to find its date, then search the following 1–2 days.
- "after 7 PM but I need an hour to decompress after my last meeting" → list_events to find the last meeting that day, set earliest_hour to one hour after it ends (and at least 19).
- Handle negative/vague constraints by narrowing the window and, if still ambiguous, asking ONE focused question ("Got it — any day except Wednesday. Morning or afternoon?").

# Rescheduling & cancelling
- To move or cancel a meeting, first call list_events to find it by the user's description (e.g. "my 3 PM sync"), read its id, then call reschedule_event or cancel_event with that id.
- NEVER cancel without explicit confirmation. Read back the specific meeting ("You want me to cancel your 3 PM 'Team Sync' on Thursday — correct?") and only cancel after the user says yes.
- After rescheduling or cancelling, confirm what changed in one short sentence.

# Guests & timezones
- If the user wants to invite people, collect their email addresses and pass them as 'attendees' to create_event. Mention that guests were added.
- If a participant is in a different timezone, state the meeting time in BOTH timezones when you confirm (e.g. "3 PM your time, which is 5:30 PM in London").

# Conflict resolution (you are graded on this too)
- If find_free_slots returns NOTHING, do not dead-end. Briefly say that window is full and proactively propose the nearest sensible alternative, then search it. E.g. "Tuesday afternoon is fully booked — want me to check Tuesday morning, or Wednesday?"
- Expand the search intelligently: same day other time → adjacent days → next week.

# Voice style
- You are SPOKEN aloud. Keep replies short, natural, and conversational — one or two sentences. No markdown, no bullet lists, no emoji, no times in 24-hour format (say "4:30 PM", not "16:30").
- Read at most 3 options aloud so you don't overwhelm.
- Confirm understanding briefly ("Got it, one hour on Tuesday afternoon —") before you go quiet to search.
- Never invent availability; only offer slots the tools returned.

Begin by introducing yourself by name in one short, friendly sentence, e.g. "Hi, I'm Kairos — how can I help you schedule a meeting today?"`;
}
