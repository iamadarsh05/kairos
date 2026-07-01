<div align="center">

<h1>Kairos</h1>

<p>
  <b>Voice-enabled AI scheduling agent</b> — finds and books Google Calendar
  meetings through a natural, back-and-forth conversation.
</p>

<p>
  <img src="https://img.shields.io/badge/Next.js-000000?style=for-the-badge&logo=next.js&logoColor=white" />
  <img src="https://img.shields.io/badge/TypeScript-3178C6?style=for-the-badge&logo=typescript&logoColor=white" />
  <img src="https://img.shields.io/badge/Gemini_Live-8E75B2?style=for-the-badge&logo=googlegemini&logoColor=white" />
  <img src="https://img.shields.io/badge/Google_Calendar-4285F4?style=for-the-badge&logo=googlecalendar&logoColor=white" />
  <img src="https://img.shields.io/badge/Vercel-000000?style=for-the-badge&logo=vercel&logoColor=white" />
</p>

<p>
  <a href="https://kairos-red-mu.vercel.app"><b>Live Demo</b></a>
  &nbsp;•&nbsp;
  <a href="#setup">Setup</a>
  &nbsp;•&nbsp;
  <a href="#architecture--design">Architecture</a>
</p>

</div>

Speak (or type) your request — Kairos understands intent, asks clarifying
questions when something's missing, reasons about dates and deadlines, checks
your Google Calendar, resolves conflicts, and books, reschedules, or cancels
meetings out loud with low latency. Built entirely on free-tier services.

<sub>Video walkthrough: <em>add your 2–3 min screen recording link here</em></sub>

---

## Highlights

- <b>Voice-native</b> — speak-to-speech via the Gemini Live API, with sub-800 ms perceived latency shown live in the UI.
- <b>Dual-mode</b> — talk or type; the same agent brain drives one session.
- <b>Real agentic logic</b> — remembers context across turns (duration, day, preferences) and decides when to ask vs. act.
- <b>Smart time parsing</b> — "late next week", "the last weekday of this month", "45 minutes before my 5 PM meeting on Friday", "after my last meeting".
- <b>Deterministic conflict resolution</b> — if a window is full, the tool itself computes the nearest real alternatives so the agent never dead-ends.
- <b>Full lifecycle</b> — create, reschedule, and cancel meetings (always confirms before cancelling).
- <b>Multi-attendee &amp; timezones</b> — invite guests and state times in both zones.
- <b>Email confirmations</b> — branded booking / reschedule / cancel emails via Resend.
- <b>Conversation history</b> — every chat is saved locally and browsable in a panel.
- <b>Live reactive UI</b> — ambient animated background and a microphone control that pulses and shifts color with the audio.

---

## Example conversation

> <b>You:</b> "I need to schedule a meeting."
> <b>Kairos:</b> "Hi, I'm Kairos — how long should the meeting be?"
> <b>You:</b> "About an hour, Tuesday afternoon."
> <b>Kairos:</b> "Got it, one hour Tuesday afternoon. I have 2:00 PM or 4:30 PM — which works?"
> <b>You:</b> "Actually, make it 90 minutes."
> <b>Kairos:</b> "Sure — for 90 minutes Tuesday afternoon I have 2:00 PM or 3:30 PM."
> <b>You:</b> "2 o'clock."
> <b>Kairos:</b> "Done — booked Tuesday at 2:00 PM. I've emailed you a confirmation."

---

## Architecture &amp; design

```
 ┌────────────────┐   mic PCM 16kHz     ┌────────────────────────┐
 │                │ ──────────────────▶ │                        │
 │     Browser    │   audio reply 24k   │    Gemini Live API     │
 │ (Next.js/React)│ ◀────────────────── │   (WebSocket, direct)  │
 │                │                     └───────────┬────────────┘
 │                │                                 │ function calls
 │                │   POST /api/calendar            │ (tool use)
 │                │ ◀───────────────────────────────┘
 │                │ ─────────┐
 └───────┬────────┘          │ execute tool
         │ POST /api/session   (mint ephemeral token + agent config)
         ▼                   ▼
 ┌────────────────────────────────────────────────┐
 │           Next.js API routes (server)           │
 │   • /api/session  → GEMINI_API_KEY (secret)     │
 │   • /api/calendar → Google Calendar API         │
 │                     + Resend email              │
 └────────────────────────────────────────────────┘
```

<b>1. The browser talks directly to Gemini Live.</b> Audio streams peer-to-peer
with Google for the lowest latency (comfortably under 800 ms). This also
sidesteps Vercel's serverless limitation of no long-lived WebSockets — audio is
never proxied through the server.

<b>2. Ephemeral tokens keep the API key secret.</b> The browser never sees
<code>GEMINI_API_KEY</code>. <code>/api/session</code> mints a single-use,
30-minute ephemeral token server-side; the client uses only that to open the
Live socket. It also returns the server-authored system prompt and tool schemas,
so the agent's "brain" has a single source of truth on the server.

<b>3. Dumb tools, smart prompt.</b> The calendar tools only speak precise ISO
timestamps. All natural-language reasoning — remembering the duration, turning
"last weekday of the month" into a date, working backward from a deadline, or
looking up "my 5 PM meeting" — happens in the LLM, steered by a carefully
engineered system prompt (see <a href="src/lib/agent.ts"><code>src/lib/agent.ts</code></a>).
This keeps date logic flexible instead of relying on brittle regex parsers.

<b>4. Conflict resolution is deterministic, not hoped-for.</b> When
<code>find_free_slots</code> returns nothing, the server itself widens the search
(same days ignoring the time-of-day filter, then a 14-day window) and hands the
agent real alternatives with an instruction to offer them — so it can never
respond with a dead-end, regardless of the model's behaviour.

<b>5. Service-account calendar auth.</b> No OAuth consent screen — you share one
calendar with the service account once, and the deployed agent reads and writes
it with zero user clicks. (Trade-off: Google shows the service account under the
event's "Created by" and cannot send native guest invites — see
<a href="#notes--trade-offs">Notes &amp; trade-offs</a>.)

### How the agent works, turn by turn

1. Determine the <b>duration</b>, a <b>date window</b>, and any <b>time-of-day</b> preference.
2. Ask one focused question only when genuinely blocked (usually just the duration).
3. Resolve fuzzy/relative phrasing into concrete ISO dates using the current date/time injected into the prompt (and <code>list_events</code> for event-relative requests like "an hour before my 5 PM meeting").
4. Call <code>find_free_slots</code> and offer two or three options aloud.
5. On confirmation, call <code>create_event</code> (or <code>reschedule_event</code> / <code>cancel_event</code>), then confirm and email.

<b>Tools the model can call:</b> <code>find_free_slots</code>,
<code>list_events</code>, <code>create_event</code>,
<code>reschedule_event</code>, <code>cancel_event</code>.

---

## Tech stack

| Layer | Technology |
| --- | --- |
| Voice + LLM (STT → reasoning → TTS) | Google Gemini Live API (`gemini-3.1-flash-live-preview`) |
| Calendar | Google Calendar API (service account) |
| Email | Resend (optional) |
| App + orchestration | Next.js 15 (App Router) + TypeScript + React 19 |
| Dates / timezones | Luxon |
| Hosting | Vercel |

---

## Setup

Three free accounts are required. Budget roughly 15 minutes the first time.

### Prerequisites
- Node.js 18+ (`node --version`)
- A Google account

### 1. Gemini API key (free)
1. Go to <b>https://aistudio.google.com/apikey</b> → <b>Create API key</b> → copy it.
2. This is your `GEMINI_API_KEY`.

### 2. Google Calendar service account (free)
1. Open <b>https://console.cloud.google.com/</b> and select or create a project.
2. <b>Enable the Calendar API:</b> APIs &amp; Services → Library → "Google Calendar API" → <b>Enable</b>.
3. <b>Create a service account:</b> APIs &amp; Services → Credentials → <b>Create Credentials → Service account</b> → name it → Done.
4. Open it → <b>Keys</b> → <b>Add key → Create new key → JSON</b>. From the file:
   - `client_email` → `GOOGLE_CLIENT_EMAIL`
   - `private_key` → `GOOGLE_PRIVATE_KEY`
5. <b>Share your calendar with the service account</b> (required):
   - calendar.google.com → hover your calendar → <b>Settings and sharing</b>
   - <b>Share with specific people</b> → add the `client_email` → <b>"Make changes to events"</b>
   - Under <b>Integrate calendar</b>, copy the <b>Calendar ID</b> (usually your Gmail) → `GOOGLE_CALENDAR_ID`

### 3. Resend for email (optional, free)
1. Sign up at <b>https://resend.com</b> with the address you want confirmations sent to.
2. <b>API Keys → Create API Key</b> → copy (`re_...`) → `RESEND_API_KEY`.
3. In test mode (no verified domain) you can only email your own signup address — which is exactly right for self-confirmations.

### 4. Configure environment
```bash
cp .env.local.example .env.local
```
Fill in `.env.local` (see the reference table below).

### 5. Run locally
```bash
npm install
npm run dev
```
Open <b>http://localhost:3000</b>, click the mic, allow microphone access, and
talk. Use headphones so the mic doesn't echo the agent's voice.

---

## Deploy to Vercel (free)

1. Push this repository to GitHub (public).
2. <b>https://vercel.com → New Project →</b> import the repository.
3. <b>Settings → Environment Variables:</b> add every variable from `.env.local` (paste `GOOGLE_PRIVATE_KEY` with its `\n` escapes intact).
4. <b>Deploy</b> → you receive a public `https://<your-app>.vercel.app` URL.

HTTPS is required for microphone access; Vercel provides it automatically.

---

## Environment variables

| Variable | Required | Description |
| --- | --- | --- |
| `GEMINI_API_KEY` | Yes | Google AI Studio key |
| `GEMINI_LIVE_MODEL` | Yes | Live model id (default `gemini-3.1-flash-live-preview`) |
| `GOOGLE_CLIENT_EMAIL` | Yes | Service account email |
| `GOOGLE_PRIVATE_KEY` | Yes | Service account private key (quoted, `\n` escapes) |
| `GOOGLE_CALENDAR_ID` | Yes | Calendar to manage (your email) |
| `AGENT_TIMEZONE` | Yes | IANA timezone, e.g. `Asia/Kolkata` |
| `WORK_DAY_START` / `WORK_DAY_END` | Optional | Working hours (24h), default 9–18 |
| `RESEND_API_KEY` | Optional | Enables confirmation emails |
| `FROM_EMAIL` | Optional | Sender (default `Kairos <onboarding@resend.dev>`) |
| `NOTIFY_EMAIL` | Optional | Recipient (defaults to `GOOGLE_CALENDAR_ID`) |

---

## Test scenarios (spoken or typed)

- "Schedule a one-hour meeting Tuesday afternoon."
- "Actually, make it 90 minutes — same day still work?" &nbsp;<sub>(mid-conversation change + memory)</sub>
- "Find 45 minutes before my flight Friday at 6 PM." &nbsp;<sub>(deadline reasoning)</sub>
- "Book 30 minutes a day after the Project Alpha Kick-off." &nbsp;<sub>(event lookup)</sub>
- "An hour on the last weekday of this month, late morning." &nbsp;<sub>(date logic)</sub>
- "Something next week, but not Wednesday and not too early." &nbsp;<sub>(vague / negative constraints)</sub>
- "Move my 3 PM sync to tomorrow." / "Cancel my sync." &nbsp;<sub>(reschedule / cancel)</sub>
- Block a full afternoon, then ask for it → Kairos offers alternatives. &nbsp;<sub>(conflict resolution)</sub>

---

## Notes &amp; trade-offs

- <b>"Created by"</b> shows the service-account email (read-only in the API); the event still belongs to your calendar.
- <b>Guest invites</b> aren't sent natively (service accounts need Workspace delegation), so guests are added to the event and emailed via Resend.
- <b>Resend test mode</b> emails only your own address until a domain is verified.
- <b>History</b> is stored per-browser (localStorage).

---

## Project structure

```
src/
├─ app/
│  ├─ page.tsx                 # voice/text UI, history, reactive background
│  ├─ layout.tsx, globals.css, icon.svg
│  └─ api/
│     ├─ session/route.ts      # mints ephemeral token + serves agent config
│     └─ calendar/route.ts     # executes tool calls + sends emails
├─ lib/
│  ├─ agent.ts                 # system prompt + tool declarations
│  ├─ calendar.ts              # find slots / list / create / update / delete
│  ├─ email.ts                 # Resend confirmation emails
│  ├─ useLiveAgent.ts          # Live session, tool routing, transcripts, latency
│  ├─ audio.ts                 # mic capture (16k) + gapless playback (24k) + levels
│  ├─ history.ts               # localStorage conversation store
│  └─ config.ts                # env config
└─ components/icons.tsx        # inline SVG icons
```
