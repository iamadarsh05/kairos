"use client";

// React hook that owns the whole voice loop:
//   1. mint an ephemeral session from our server
//   2. open the Gemini Live WebSocket from the browser
//   3. stream mic PCM up, play model PCM down
//   4. when the model calls a tool, run it via /api/calendar and send the result back
//   5. surface live transcripts for the on-screen UI

import { useCallback, useRef, useState } from "react";
import {
  GoogleGenAI,
  Modality,
  type Session,
  type LiveServerMessage,
} from "@google/genai";
import { MicCapture, PCMPlayer } from "./audio";

export type Role = "user" | "bot" | "tool" | "event";
export interface Message {
  id: string;
  role: Role;
  text: string;
  /** For `event` cards: link to the created Google Calendar event. */
  link?: string;
  /** For `event` cards: whether a confirmation email was sent. */
  emailed?: boolean;
  /** For `event` cards: booked / updated / cancelled. */
  kind?: "booked" | "updated" | "cancelled";
}

export type AgentStatus =
  | "idle"
  | "connecting"
  | "listening"
  | "thinking"
  | "speaking"
  | "error";

let msgSeq = 0;
const nextId = () => `m${++msgSeq}`;

// Friendly, human-readable status lines shown while a tool runs (never raw args).
const TOOL_LABEL: Record<string, string> = {
  find_free_slots: "Checking your calendar for open times…",
  list_events: "Looking up your calendar…",
  create_event: "Booking your meeting…",
  reschedule_event: "Rescheduling your meeting…",
  cancel_event: "Cancelling your meeting…",
};
const EVENT_TOOLS = new Set([
  "create_event",
  "reschedule_event",
  "cancel_event",
]);

export function useLiveAgent() {
  const [status, setStatus] = useState<AgentStatus>("idle");
  const [messages, setMessages] = useState<Message[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [micActive, setMicActive] = useState(false);
  const [muted, setMuted] = useState(false);
  const [latencyMs, setLatencyMs] = useState<number | null>(null);

  // Latency tracking: time from the user's last input to the agent's first
  // audio out ("time to first sound") — the perceived response latency.
  const lastInputAtRef = useRef(0);
  const awaitingRef = useRef(false);
  // Guards against overlapping start() calls (e.g. rapid double-clicks) that
  // would otherwise open multiple simultaneous Live sessions.
  const startingRef = useRef(false);

  const sessionRef = useRef<Session | null>(null);
  const micRef = useRef<MicCapture | null>(null);
  const playerRef = useRef<PCMPlayer | null>(null);

  // Per-turn transcript accumulation. Each turn gets a stable bubble id so we
  // can keep appending streamed fragments to the same bubble.
  const userBubbleRef = useRef<string | null>(null);
  const botBubbleRef = useRef<string | null>(null);

  const upsertBubble = useCallback(
    (role: Role, bubbleId: string, append: string) => {
      setMessages((prev) => {
        const idx = prev.findIndex((m) => m.id === bubbleId);
        if (idx === -1) {
          return [...prev, { id: bubbleId, role, text: append }];
        }
        const copy = [...prev];
        copy[idx] = { ...copy[idx], text: copy[idx].text + append };
        return copy;
      });
    },
    []
  );

  const addToolNote = useCallback((text: string) => {
    setMessages((prev) => [...prev, { id: nextId(), role: "tool", text }]);
  }, []);

  const updateMessage = useCallback((id: string, text: string) => {
    setMessages((prev) =>
      prev.map((m) => (m.id === id ? { ...m, text } : m))
    );
  }, []);

  // Run a single tool call against our server, return the JSON result.
  const runTool = useCallback(
    async (name: string, args: Record<string, unknown>) => {
      // Show a friendly, human-readable status line (never raw args).
      const noteId = nextId();
      setMessages((prev) => [
        ...prev,
        { id: noteId, role: "tool", text: TOOL_LABEL[name] ?? "Working…" },
      ]);
      try {
        const res = await fetch("/api/calendar", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ tool: name, args }),
        });
        const data = await res.json();

        // Booking/reschedule/cancel success → replace the status line with a
        // rich event card (styled by kind).
        if (EVENT_TOOLS.has(name) && data?.ok && data.event) {
          setMessages((prev) =>
            prev
              .filter((m) => m.id !== noteId)
              .concat({
                id: nextId(),
                role: "event",
                text: data.event.label as string,
                link: data.event.htmlLink as string | undefined,
                emailed: Boolean(data.emailed),
                kind: (data.event.kind as Message["kind"]) ?? "booked",
              })
          );
        } else if (!EVENT_TOOLS.has(name) && data?.ok) {
          // Update the status line to a brief, friendly done state (the agent
          // speaks the actual options aloud, so keep this short).
          updateMessage(
            noteId,
            data.count === 0
              ? "No matching times found."
              : `Found ${data.count} option${data.count === 1 ? "" : "s"}.`
          );
        } else if (!data?.ok) {
          updateMessage(noteId, "Couldn't complete that — I'll try again.");
        }
        return data;
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : "tool failed";
        updateMessage(noteId, "Something went wrong reaching the calendar.");
        return { ok: false, error: msg };
      }
    },
    [updateMessage]
  );

  const stop = useCallback(() => {
    micRef.current?.stop();
    micRef.current = null;
    playerRef.current?.close();
    playerRef.current = null;
    try {
      sessionRef.current?.close();
    } catch {
      /* noop */
    }
    sessionRef.current = null;
    userBubbleRef.current = null;
    botBubbleRef.current = null;
    setMicActive(false);
    setMuted(false);
    startingRef.current = false;
    setStatus("idle");
  }, []);

  // Mute/unmute the microphone without ending the session.
  const toggleMute = useCallback(() => {
    setMuted((m) => {
      const next = !m;
      micRef.current?.setMuted(next);
      return next;
    });
  }, []);

  const start = useCallback(async (opts?: { greet?: boolean }) => {
    // Ignore if a session is already starting or open (prevents duplicates).
    if (startingRef.current || sessionRef.current) return;
    startingRef.current = true;
    const greet = opts?.greet !== false;
    setError(null);
    setStatus("connecting");
    try {
      // 1. Mint an ephemeral session (token + model + agent config) server-side.
      const sessionRes = await fetch("/api/session", { method: "POST" });
      if (!sessionRes.ok) {
        const e = await sessionRes.json().catch(() => ({}));
        throw new Error(e.error || `Session error (${sessionRes.status})`);
      }
      const { token, model, systemInstruction, tools } =
        await sessionRes.json();

      // 2. Prepare playback, then connect to Live with the ephemeral token.
      const player = new PCMPlayer();
      await player.resume();
      playerRef.current = player;

      const ai = new GoogleGenAI({
        apiKey: token,
        httpOptions: { apiVersion: "v1alpha" },
      });

      const session = await ai.live.connect({
        model,
        config: {
          responseModalities: [Modality.AUDIO],
          systemInstruction,
          tools,
          // Ask the API to transcribe both sides so we can show text on screen.
          inputAudioTranscription: {},
          outputAudioTranscription: {},
        },
        callbacks: {
          onopen: () => {
            setStatus("listening");
          },
          onmessage: (message: LiveServerMessage) => {
            handleMessage(message);
          },
          onerror: (e: ErrorEvent) => {
            setError(e?.message || "Live connection error.");
            setStatus("error");
          },
          onclose: (e: CloseEvent) => {
            // A non-normal close (code !== 1000) while we still think we're
            // connected means something failed — surface the reason instead of
            // silently going idle (e.g. an invalid model closes with 1008).
            if (sessionRef.current) {
              if (e && e.code && e.code !== 1000) {
                setError(
                  `Connection closed (${e.code})${e.reason ? ": " + e.reason : ""}`
                );
                setStatus("error");
              } else {
                setStatus("idle");
              }
            }
          },
        },
      });
      sessionRef.current = session;

      // Kick off the conversation: the Live API won't speak first on its own,
      // so nudge it with a tiny opener. This turn has no audio transcript, so
      // it won't appear as a user bubble — only the agent's spoken greeting shows.
      // Skipped when the user starts by typing (their message drives the turn).
      if (greet) {
        try {
          session.sendClientContent({
            turns: [{ role: "user", parts: [{ text: "Hello" }] }],
            turnComplete: true,
          });
          setStatus("speaking");
        } catch {
          /* session may be closing */
        }
      }

      // 3. Start streaming the mic up as 16 kHz PCM. If the mic is blocked or
      //    unavailable, we DON'T fail — we fall back to text-only mode so the
      //    user can still type and hear spoken replies. (Robust for demos.)
      const mic = new MicCapture((base64Pcm) => {
        try {
          // Use the `audio` field (not the deprecated `media`/media_chunks),
          // which native-audio Live models require.
          session.sendRealtimeInput({
            audio: { data: base64Pcm, mimeType: "audio/pcm;rate=16000" },
          });
        } catch {
          /* session may be closing */
        }
      });
      try {
        await mic.start();
        micRef.current = mic;
        setMicActive(true);
      } catch {
        setMicActive(false);
        addToolNote(
          "🎙️ Microphone unavailable — you can still type below, and I'll reply out loud."
        );
      }

      // ---- message handler (closes over session/player) -------------------
      function handleMessage(message: LiveServerMessage) {
        const sc = message.serverContent;

        // Barge-in: the user started talking over the model. Cut playback.
        if (sc?.interrupted) {
          player.stop();
          botBubbleRef.current = null;
          setStatus("listening");
        }

        // Streamed audio out → enqueue for gapless playback.
        const parts = sc?.modelTurn?.parts ?? [];
        for (const part of parts) {
          const data = part.inlineData?.data;
          if (data) {
            // First audio after user input → record perceived latency.
            if (awaitingRef.current) {
              setLatencyMs(Date.now() - lastInputAtRef.current);
              awaitingRef.current = false;
            }
            setStatus("speaking");
            player.play(data);
          }
        }

        // Live transcripts (best-effort; depends on model support).
        const userText = sc?.inputTranscription?.text;
        if (userText) {
          // Track the moment of the user's latest speech for latency timing.
          lastInputAtRef.current = Date.now();
          awaitingRef.current = true;
          if (!userBubbleRef.current) userBubbleRef.current = nextId();
          upsertBubble("user", userBubbleRef.current, userText);
        }
        const botText = sc?.outputTranscription?.text;
        if (botText) {
          if (!botBubbleRef.current) botBubbleRef.current = nextId();
          upsertBubble("bot", botBubbleRef.current, botText);
        }

        // Tool calls: run each, then send all responses back together.
        const functionCalls = message.toolCall?.functionCalls;
        if (functionCalls && functionCalls.length) {
          setStatus("thinking");
          void (async () => {
            const responses = [];
            for (const fc of functionCalls) {
              const result = await runTool(fc.name ?? "", fc.args ?? {});
              responses.push({
                id: fc.id,
                name: fc.name,
                response: result,
              });
            }
            try {
              session.sendToolResponse({ functionResponses: responses });
            } catch {
              /* session may be closing */
            }
          })();
        }

        // Turn boundary: start fresh bubbles next time.
        if (sc?.turnComplete) {
          userBubbleRef.current = null;
          botBubbleRef.current = null;
          setStatus("listening");
        }
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "Failed to start agent.";
      setError(msg);
      setStatus("error");
      stop();
    } finally {
      startingRef.current = false;
    }
  }, [runTool, stop, upsertBubble]);

  // Send a typed message. Works as the primary input in text-only mode, or
  // alongside voice. If no session is open yet, we start one first (without the
  // spoken greeting, since the user's message drives the turn).
  const sendText = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (!trimmed) return;
      if (!sessionRef.current) {
        await start({ greet: false });
      }
      const session = sessionRef.current;
      if (!session) return;
      // Typed text has no audio transcript, so add the user bubble ourselves.
      setMessages((prev) => [
        ...prev,
        { id: nextId(), role: "user", text: trimmed },
      ]);
      try {
        lastInputAtRef.current = Date.now();
        awaitingRef.current = true;
        session.sendClientContent({
          turns: [{ role: "user", parts: [{ text: trimmed }] }],
          turnComplete: true,
        });
        setStatus("thinking");
      } catch {
        /* session may be closing */
      }
    },
    [start]
  );

  // Read the current audio levels (0..1) for the reactive visualizer. Called
  // from a requestAnimationFrame loop, so it reads refs directly — no re-render.
  const sampleLevels = useCallback(
    () => ({
      user: micRef.current?.getLevel() ?? 0,
      bot: playerRef.current?.getLevel() ?? 0,
    }),
    []
  );

  // Clear the current conversation and tear down any live session ("New chat").
  const reset = useCallback(() => {
    stop();
    setMessages([]);
    setError(null);
    setLatencyMs(null);
  }, [stop]);

  return {
    status,
    messages,
    error,
    micActive,
    muted,
    latencyMs,
    start,
    stop,
    reset,
    toggleMute,
    sendText,
    sampleLevels,
  };
}

