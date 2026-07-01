# 🗓️ Kairos — Voice-Enabled Smart Scheduler Agent

Kairos is a **voice-first AI agent** that finds and books meeting times through a
natural, back-and-forth conversation. Speak (or type) your request — Kairos
understands intent, asks clarifying questions when something's missing, reasons
about dates and deadlines, checks your **Google Calendar**, resolves conflicts,
and books, reschedules, or cancels meetings out loud with low latency.

Built entirely on **free-tier** services.

> **Live demo:** https://kairos-red-mu.vercel.app
> **Video walkthrough:** _add your 2–3 min screen recording link here_

---

## ✨ Highlights

- 🎙️ **Voice-native** — speak-to-speech via the Gemini Live API (< 800 ms
  perceived latency, shown live in the UI).
- ⌨️ **Dual-mode** — talk *or* type; same agent brain, one session.
- 🧠 **Real agentic logic** — remembers context across turns (duration, day,
  preferences), decides when to ask vs. act.
- 🗣️ **Smart time parsing** — "late next week", "the last weekday of this month",
  "45 minutes before my 5 PM meeting on Friday", "after my last meeting."
- ♟️ **Deterministic conflict resolution** — if a window is full, the tool itself
  computes the nearest real alternatives so the agent never dead-ends.
- 🔁 **Full lifecycle** — create, **reschedule**, and **cancel** meetings (always
  confirms before cancelling).
- 👥 **Multi-attendee + timezones** — invite guests, state times in both zones.
- 📧 **Email confirmations** — branded booking/reschedule/cancel emails (Resend).
- 🗂️ **Conversation history** — every chat saved locally, browsable in a panel.
- 🎛️ **Live reactive UI** — ambient animated background + a mic that pulses and
  shifts color with the audio.

---

## 🎬 What a conversation looks like

> **You:** "I need to schedule a meeting."
> **Kairos:** "Hi, I'm Kairos — how long should the meeting be?"
> **You:** "About an hour, Tuesday afternoon."
> **Kairos:** "Got it, one hour Tuesday afternoon. I have 2:00 PM or 4:30 PM — which works?"
> **You:** "Actually, make it 90 minutes."
> **Kairos:** "Sure — for 90 minutes on Tuesday afternoon I have 2:00 PM or 3:30 PM."
> **You:** "2 o'clock."
> **Kairos:** "Done — booked Tuesday at 2:00 PM. I've emailed you a confirmation."

---

## 🏗️ Architecture & design choices

```
 ┌───────────────┐   mic PCM 16kHz     ┌────────────────────────┐
 │               │ ──────────────────▶ │                        │
 │    Browser    │   audio reply 24k   │   Gemini Live API      │
 │ (Next.js/React)│ ◀────────────────── │  (WebSocket, direct)   │
 │               │                     └───────────┬────────────┘
 │               │                                 │ function calls
 │               │   POST /api/calendar            │ (tool use)
 │               │ ◀───────────────────────────────┘
 │               │ ─────────┐
 └───────┬───────┘          │ execute tool
         │ POST /api/session   (mint ephemeral token + agent config)
         ▼                  ▼
 ┌───────────────────────────────────────────────┐
 │          Next.js API routes (server)           │
 │  • /api/session  → GEMINI_API_KEY (secret)     │
 │  • /api/calendar → Google Calendar API         │
 │                    + Resend email              │
 └───────────────────────────────────────────────┘
```

**1. The browser talks directly to Gemini Live.** Audio streams peer-to-peer with
Google for the lowest latency (comfortably < 800 ms). This also sidesteps
Vercel's serverless limitation of no long-lived WebSockets — we never proxy audio
through our server.

**2. Ephemeral tokens keep the API key secret.** The browser never sees
`GEMINI_API_KEY`. `/api/session` mints a **single-use, 30-minute ephemeral token**
server-side; the client uses only that to open the Live socket. It also returns
the server-authored system prompt + tool schemas, so the agent's "brain" has a
single source of truth on the server.

**3. Dumb tools, smart prompt.** The calendar tools only speak precise ISO
timestamps. *All* natural-language reasoning — remembering the duration, turning
"last weekday of the month" into a date, working backward from a deadline, or
looking up "my 5 PM meeting" — happens in the LLM, steered by a carefully
engineered system prompt (see [`src/lib/agent.ts`](src/lib/agent.ts)). This keeps
date logic flexible instead of relying on brittle regex parsers.

**4. Conflict resolution is deterministic, not hoped-for.** When
`find_free_slots` returns nothing, the server *itself* widens the search (same
days ignoring the time-of-day filter, then a 14-day window) and hands the agent
real alternatives with an instruction to offer them — so it can never respond
with a dead-end, regardless of the model's mood.

**5. Service-account calendar auth.** No OAuth consent screen — you share one
calendar with the service account once, and the deployed agent reads/writes it
with zero user clicks. (Trade-off: Google shows the service account under the
event's "Created by" and can't send native guest invites — see *Limitations*.)

### How the agent works, turn by turn
1. Determine **duration**, a **date window**, and any **time-of-day** preference.
2. Ask *one* focused question only if genuinely blocked (usually just duration).
3. Resolve fuzzy/relative phrasing into concrete ISO dates using the current
   date/time injected into the prompt (and `list_events` for event-relative
   requests like "an hour before my 5 PM meeting").
4. Call `find_free_slots`, offer 2–3 options aloud.
5. On confirmation, `create_event` (or `reschedule_event` / `cancel_event`),
   then confirm and email.

**Tools the model can call:** `find_free_slots`, `list_events`, `create_event`,
`reschedule_event`, `cancel_event`.

---

## 🧰 Tech stack

| Layer | Technology |
|---|---|
| Voice + LLM (STT → reasoning → TTS) | **Google Gemini Live API** (`gemini-3.1-flash-live-preview`) |
| Calendar | **Google Calendar API** (service account) |
| Email | **Resend** (optional) |
| App + orchestration | **Next.js 15 (App Router) + TypeScript + React 19** |
| Dates/timezones | **Luxon** |
| Hosting | **Vercel** |

---

## 🚀 Setup — step by step

You'll need three free accounts. Budget ~15 minutes the first time.

### 0. Prerequisites
- Node.js 18+ (`node --version`)
- A Google account

### 1. Gemini API key (free)
1. Go to **https://aistudio.google.com/apikey** → **Create API key** → copy it.
2. This is your `GEMINI_API_KEY`.

### 2. Google Calendar service account (free)
1. Open **https://console.cloud.google.com/** and select/create a project.
2. **Enable the Calendar API:** APIs & Services → Library → "Google Calendar API" → **Enable**.
3. **Create a service account:** APIs & Services → Credentials → **Create Credentials → Service account** → name it → Done.
4. Open it → **Keys** → **Add key → Create new key → JSON**. Note from the file:
   - `client_email` → `GOOGLE_CLIENT_EMAIL`
   - `private_key`  → `GOOGLE_PRIVATE_KEY`
5. **Share your calendar with the service account** (crucial):
   - calendar.google.com → hover your calendar → **⋮ → Settings and sharing**
   - **Share with specific people** → add the `client_email` → **"Make changes to events"**
   - Under **Integrate calendar**, copy the **Calendar ID** (usually your Gmail) → `GOOGLE_CALENDAR_ID`

### 3. Resend for email (optional, free)
1. Sign up at **https://resend.com** with the email you want confirmations sent to.
2. **API Keys → Create API Key** → copy (`re_...`) → `RESEND_API_KEY`.
3. In test mode (no verified domain) you can only email your own signup address —
   which is exactly right for self-confirmations.

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
Open **http://localhost:3000**, click the mic, allow microphone access, and talk.
Use **headphones** so the mic doesn't echo the agent's voice.

---

## ☁️ Deploy to Vercel (free)

1. Push this repo to GitHub (public).
2. **https://vercel.com → New Project →** import the repo.
3. **Settings → Environment Variables:** add every variable from `.env.local`
   (paste `GOOGLE_PRIVATE_KEY` with its `\n` escapes intact).
4. **Deploy** → you get a public `https://<your-app>.vercel.app` URL.

> HTTPS is required for microphone access — Vercel provides it automatically.

---

## 🔐 Environment variables

| Variable | Required | Description |
|---|---|---|
| `GEMINI_API_KEY` | ✅ | Google AI Studio key |
| `GEMINI_LIVE_MODEL` | ✅ | Live model id (default `gemini-3.1-flash-live-preview`) |
| `GOOGLE_CLIENT_EMAIL` | ✅ | Service account email |
| `GOOGLE_PRIVATE_KEY` | ✅ | Service account private key (quoted, `\n` escapes) |
| `GOOGLE_CALENDAR_ID` | ✅ | Calendar to manage (your email) |
| `AGENT_TIMEZONE` | ✅ | IANA tz, e.g. `Asia/Kolkata` |
| `WORK_DAY_START` / `WORK_DAY_END` | – | Working hours (24h), default 9–18 |
| `RESEND_API_KEY` | – | Enables confirmation emails |
| `FROM_EMAIL` | – | Sender (default `Kairos <onboarding@resend.dev>`) |
| `NOTIFY_EMAIL` | – | Recipient (defaults to `GOOGLE_CALENDAR_ID`) |

---

## 🧪 Test scenarios (spoken or typed)

- "Schedule a one-hour meeting Tuesday afternoon."
- "Actually, make it 90 minutes — same day still work?" *(mid-conversation change + memory)*
- "Find 45 minutes before my flight Friday at 6 PM." *(deadline reasoning)*
- "Book 30 minutes a day after the Project Alpha Kick-off." *(event lookup)*
- "An hour on the last weekday of this month, late morning." *(date logic)*
- "Something next week, but not Wednesday and not too early." *(vague/negative)*
- "Move my 3 PM sync to tomorrow." / "Cancel my sync." *(reschedule / cancel)*
- Block a full afternoon, then ask for it → Kairos offers alternatives. *(conflict resolution)*

---

## 🎥 Demo video script (2–3 min)

1. **Intro (15s):** "This is Kairos, a voice scheduling agent — Gemini Live +
   Google Calendar on Next.js/Vercel." Show the home screen.
2. **Basic booking (40s):** Tap mic → "Schedule a 30-minute meeting tomorrow
   afternoon." → it offers slots → pick one → show the confirmation card + the
   event appearing in Google Calendar + the email.
3. **Memory + change mid-convo (30s):** "Actually make it an hour" → it re-searches
   keeping the day. Point out the latency badge (< 800 ms).
4. **Smart parsing (30s):** "Find 45 minutes before my 5 PM meeting on Friday" →
   show it looking up the event and offering the right window.
5. **Conflict resolution (25s):** Ask for a fully-booked window → it proposes
   alternatives instead of failing.
6. **Reschedule/cancel + history (20s):** "Move it to 4" then "cancel it"; open
   the History panel.

---

## ⚠️ Limitations (by design, service-account trade-offs)

- **"Created by" on events** shows the service-account email (read-only in the
  API). The event still correctly belongs to your calendar. Standard for
  integration-created events.
- **Native guest invites** aren't sent by a service account on a personal Gmail
  (needs Workspace Domain-Wide Delegation), so guests are recorded on the event +
  emailed via Resend instead.
- **Resend test mode** delivers only to your own verified address; add a verified
  domain to email arbitrary guests.
- **History** is per-browser (localStorage), not synced across devices.

---

## 📁 Project structure

```
src/
├─ app/
│  ├─ page.tsx                 # voice/text UI, history, reactive background
│  ├─ layout.tsx, globals.css, icon.svg
│  └─ api/
│     ├─ session/route.ts      # mints ephemeral token + serves agent config
│     └─ calendar/route.ts     # executes tool calls + sends emails
├─ lib/
│  ├─ agent.ts                 # 🧠 system prompt + tool declarations
│  ├─ calendar.ts              # find slots / list / create / update / delete
│  ├─ email.ts                 # Resend confirmation emails
│  ├─ useLiveAgent.ts          # Live session, tool routing, transcripts, latency
│  ├─ audio.ts                 # mic capture (16k) + gapless playback (24k) + levels
│  ├─ history.ts               # localStorage conversation store
│  └─ config.ts                # env config
└─ components/icons.tsx        # inline SVG icons
```

---

Built for the Smart Scheduler AI Agent assignment.
