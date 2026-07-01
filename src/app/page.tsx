"use client";

import { useEffect, useRef, useState } from "react";
import {
  useLiveAgent,
  type AgentStatus,
  type Message,
} from "@/lib/useLiveAgent";
import {
  loadConversations,
  upsertConversation,
  deleteConversation,
  deriveTitle,
  type Conversation,
} from "@/lib/history";
import {
  SparklesIcon,
  MicIcon,
  MicOffIcon,
  StopIcon,
  SendIcon,
  HistoryIcon,
  PlusIcon,
  CheckIcon,
  CalendarIcon,
  TrashIcon,
  CloseIcon,
  ZapIcon,
  MessageIcon,
} from "@/components/icons";
import { clearAll } from "@/lib/history";

const STATUS: Record<AgentStatus, string> = {
  idle: "Ready",
  connecting: "Connecting…",
  listening: "Listening",
  thinking: "Checking calendar…",
  speaking: "Speaking",
  error: "Error",
};

const SUGGESTIONS = [
  "Schedule a 1-hour meeting Tuesday afternoon",
  "Find 30 minutes tomorrow morning",
  "Book the last weekday of this month, late morning",
  "45 minutes before my 5 PM meeting on Friday",
];

export default function Home() {
  const {
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
  } = useLiveAgent();

  const [draft, setDraft] = useState("");
  const [history, setHistory] = useState<Conversation[]>([]);
  const [showHistory, setShowHistory] = useState(false);
  const [viewingId, setViewingId] = useState<string | null>(null);

  const isLive = status !== "idle" && status !== "error";
  const endRef = useRef<HTMLDivElement>(null);
  const pageRef = useRef<HTMLDivElement>(null);
  const currentIdRef = useRef<string | null>(null);
  const currentCreatedRef = useRef<number>(0);

  const viewing = viewingId
    ? history.find((c) => c.id === viewingId) ?? null
    : null;
  const displayed = viewing ? viewing.messages : messages;

  // Load history on mount.
  useEffect(() => {
    setHistory(loadConversations());
  }, []);

  // Auto-scroll.
  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [displayed, status]);

  // Persist the live conversation whenever it changes.
  useEffect(() => {
    if (viewingId) return; // not while browsing history
    if (messages.length === 0) return;
    if (!currentIdRef.current) {
      currentIdRef.current = `c${Date.now()}-${Math.floor(
        Math.random() * 1e6
      )}`;
      currentCreatedRef.current = Date.now();
    }
    setHistory(
      upsertConversation({
        id: currentIdRef.current,
        title: deriveTitle(messages),
        createdAt: currentCreatedRef.current,
        updatedAt: Date.now(),
        messages,
      })
    );
  }, [messages, viewingId]);

  // Reactive background driven by live audio levels (no re-renders).
  useEffect(() => {
    let raf = 0;
    let smoothed = 0;
    const tick = () => {
      const { user, bot } = sampleLevels();
      const target = Math.max(user, bot);
      smoothed += (target - smoothed) * 0.18;
      const el = pageRef.current;
      if (el) {
        el.style.setProperty("--level", smoothed.toFixed(3));
        el.style.setProperty(
          "--aura",
          bot >= user ? "var(--aura-bot)" : "var(--aura-user)"
        );
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [sampleLevels]);

  const submit = () => {
    const text = draft.trim();
    if (!text) return;
    setDraft("");
    void sendText(text);
  };

  const newChat = () => {
    reset();
    currentIdRef.current = null;
    currentCreatedRef.current = 0;
    setViewingId(null);
    setShowHistory(false);
  };

  const openConversation = (id: string) => {
    setViewingId(id);
    setShowHistory(false);
  };

  const delConversation = (id: string) => {
    setHistory(deleteConversation(id));
    if (viewingId === id) setViewingId(null);
  };

  const pillLabel = status === "error" ? error || "Error" : STATUS[status];

  return (
    <div className="page" ref={pageRef}>
      <div className="orb a" />
      <div className="orb b" />

      <header className="topbar">
        <div className="topbar-inner">
          <button className="brand" onClick={newChat} title="Go to home">
            <div className="brand-logo">
              <SparklesIcon />
            </div>
            <div className="brand-text">
              <h1>Kairos</h1>
              <p>Voice scheduling agent</p>
            </div>
          </button>
          <div className="topbar-actions">
            {!viewing && isLive && latencyMs != null && (
              <div
                className={`latency-badge ${latencyMs < 800 ? "good" : "warn"}`}
                title="Response latency (time to first audio)"
              >
                <ZapIcon /> {latencyMs} ms
              </div>
            )}
            {!viewing && (
              <div className={`status-pill ${status}`}>
                <span className="status-dot" />
                {pillLabel}
              </div>
            )}
            <button
              className="ghost-btn labeled"
              onClick={newChat}
              title="Start a new conversation"
              aria-label="New chat"
            >
              <PlusIcon />
              <span>New chat</span>
            </button>
            <button
              className="ghost-btn labeled"
              onClick={() => setShowHistory(true)}
              title="View past conversations"
              aria-label="History"
            >
              <HistoryIcon />
              <span>History</span>
            </button>
          </div>
        </div>
      </header>

      <div className="shell">
        {/* ---- viewing-history banner ---- */}
        {viewing && (
          <div className="view-banner">
            <span>
              Viewing past conversation · {formatDate(viewing.updatedAt)}
            </span>
            <button className="link-btn" onClick={() => setViewingId(null)}>
              Back to current
            </button>
          </div>
        )}

        {/* ---- chat / hero ---- */}
        {displayed.length === 0 ? (
          <div className="hero">
            <button
              className="hero-ring"
              onClick={() => void start()}
              disabled={isLive}
              aria-label="Start voice agent"
            >
              <MicIcon />
            </button>
            <h2>Let&apos;s find you a time</h2>
            <p>
              Tap the mic and just talk — or type below. I&apos;ll check your
              calendar, handle conflicts, and book it.
            </p>
            <div className="suggestions">
              {SUGGESTIONS.map((s) => (
                <button
                  key={s}
                  className="chip"
                  onClick={() => void sendText(s)}
                >
                  {s}
                </button>
              ))}
            </div>
          </div>
        ) : (
          <div className="chat">
            {displayed.map((m) => (
              <MessageView key={m.id} m={m} />
            ))}
            {!viewing &&
              (status === "thinking" || status === "connecting") && (
                <div className="row bot">
                  <div className="bubble">
                    <span className="typing">
                      <span />
                      <span />
                      <span />
                    </span>
                  </div>
                </div>
              )}
            <div ref={endRef} />
          </div>
        )}

        {/* ---- composer (hidden while viewing history) ---- */}
        {viewing ? (
          <div className="composer">
            <button className="resume-btn" onClick={() => setViewingId(null)}>
              ← Back to current chat
            </button>
          </div>
        ) : (
          <div className="composer">
            <div className="composer-bar">
              <input
                className="composer-input"
                placeholder={
                  isLive
                    ? "Type a message…"
                    : "Type a message, or tap the mic →"
                }
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    submit();
                  }
                }}
              />
              <button
                className="icon-btn send-btn"
                onClick={submit}
                disabled={!draft.trim()}
                aria-label="Send message"
              >
                <SendIcon />
              </button>
              {isLive && micActive && (
                <button
                  className={`icon-btn mute-btn ${muted ? "muted" : ""}`}
                  onClick={toggleMute}
                  title={muted ? "Unmute microphone" : "Mute microphone"}
                  aria-label={muted ? "Unmute microphone" : "Mute microphone"}
                >
                  {muted ? <MicOffIcon /> : <MicIcon />}
                </button>
              )}
              <button
                className={`icon-btn mic-btn ${isLive ? "live" : ""} ${
                  muted ? "muted" : ""
                }`}
                onClick={isLive ? stop : () => void start()}
                aria-label={isLive ? "End session" : "Start voice"}
              >
                {isLive ? <StopIcon /> : <MicIcon />}
              </button>
            </div>
            <div className="composer-hint">
              {status === "error" ? (
                <b>{error}</b>
              ) : isLive ? (
                micActive ? (
                  muted ? (
                    <>
                      <b>Muted</b> · the agent can&apos;t hear you — tap the mic
                      to unmute, or type
                    </>
                  ) : (
                    <>
                      <b>Voice live</b> · speak naturally or type · use headphones
                      to avoid echo
                    </>
                  )
                ) : (
                  <>
                    <b>Text mode</b> · mic unavailable — type and I&apos;ll reply
                    aloud
                  </>
                )
              ) : (
                <>Powered by Gemini Live · Google Calendar</>
              )}
            </div>
          </div>
        )}
      </div>

      {/* ---- history drawer ---- */}
      {showHistory && (
        <div className="drawer-backdrop" onClick={() => setShowHistory(false)}>
          <aside className="drawer" onClick={(e) => e.stopPropagation()}>
            <div className="drawer-head">
              <div className="drawer-head-title">
                <HistoryIcon />
                <span>History</span>
                {history.length > 0 && (
                  <span className="drawer-count">{history.length}</span>
                )}
              </div>
              <button
                className="ghost-btn"
                onClick={() => setShowHistory(false)}
                aria-label="Close"
              >
                <CloseIcon />
              </button>
            </div>

            {history.length === 0 ? (
              <div className="drawer-empty">
                <div className="drawer-empty-icon">
                  <MessageIcon />
                </div>
                <div className="drawer-empty-title">No conversations yet</div>
                <div className="drawer-empty-sub">
                  Your scheduling chats will be saved here automatically.
                </div>
              </div>
            ) : (
              <>
                <div className="drawer-list">
                  {history.map((c) => (
                    <button
                      key={c.id}
                      className={`drawer-item ${
                        c.id === viewingId ? "active" : ""
                      }`}
                      onClick={() => openConversation(c.id)}
                    >
                      <span className="drawer-item-icon">
                        <MessageIcon />
                      </span>
                      <span className="drawer-item-main">
                        <span className="drawer-item-title">{c.title}</span>
                        <span className="drawer-item-date">
                          {formatDate(c.updatedAt)} · {c.messages.length} messages
                        </span>
                      </span>
                      <span
                        className="drawer-del"
                        role="button"
                        tabIndex={0}
                        onClick={(e) => {
                          e.stopPropagation();
                          delConversation(c.id);
                        }}
                        aria-label="Delete conversation"
                      >
                        <TrashIcon />
                      </span>
                    </button>
                  ))}
                </div>
                <div className="drawer-foot">
                  <button
                    className="drawer-clear"
                    onClick={() => {
                      setHistory(clearAll());
                      setViewingId(null);
                    }}
                  >
                    <TrashIcon /> Clear all
                  </button>
                </div>
              </>
            )}
          </aside>
        </div>
      )}
    </div>
  );
}

function MessageView({ m }: { m: Message }) {
  if (m.role === "tool") {
    return <div className="tool">{m.text}</div>;
  }
  if (m.role === "event") {
    const kind = m.kind ?? "booked";
    const title =
      kind === "cancelled"
        ? "Meeting cancelled"
        : kind === "updated"
        ? "Meeting rescheduled"
        : "Meeting scheduled";
    return (
      <div className={`event-card ${kind}`}>
        <div className="event-check">
          {kind === "cancelled" ? <CloseIcon /> : <CheckIcon />}
        </div>
        <div className="event-body">
          <div className="event-title">{title}</div>
          <div className="event-sub">{m.text}</div>
          <div className="event-actions">
            {m.link && kind !== "cancelled" && (
              <a
                className="event-link"
                href={m.link}
                target="_blank"
                rel="noreferrer"
              >
                <CalendarIcon /> View in Google Calendar
              </a>
            )}
            {m.emailed && <span className="event-emailed">✉ Email sent</span>}
          </div>
        </div>
      </div>
    );
  }
  return (
    <div className={`row ${m.role}`}>
      <div className="bubble">{m.text}</div>
    </div>
  );
}

function formatDate(ts: number): string {
  try {
    return new Date(ts).toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  } catch {
    return "";
  }
}
