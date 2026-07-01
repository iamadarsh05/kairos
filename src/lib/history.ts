// Conversation history, persisted in the browser's localStorage.
//
// No backend/auth needed — history lives per-browser, which is the right
// trade-off for this app: zero infra, works on Vercel's free tier, private to
// the device. Each conversation stores its full message list so it can be
// reopened and read later.

import type { Message } from "./useLiveAgent";

const KEY = "smart-scheduler.history.v1";
const MAX = 50; // cap stored conversations

export interface Conversation {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messages: Message[];
}

export function loadConversations(): Conversation[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return [];
    const list = JSON.parse(raw) as Conversation[];
    return Array.isArray(list)
      ? list.sort((a, b) => b.updatedAt - a.updatedAt)
      : [];
  } catch {
    return [];
  }
}

function persist(list: Conversation[]) {
  if (typeof window === "undefined") return;
  try {
    const trimmed = list
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, MAX);
    window.localStorage.setItem(KEY, JSON.stringify(trimmed));
  } catch {
    /* quota or serialization error — history is best-effort */
  }
}

/** Insert or update a conversation, returning the fresh sorted list. */
export function upsertConversation(conv: Conversation): Conversation[] {
  const list = loadConversations().filter((c) => c.id !== conv.id);
  list.push(conv);
  persist(list);
  return loadConversations();
}

export function deleteConversation(id: string): Conversation[] {
  const list = loadConversations().filter((c) => c.id !== id);
  persist(list);
  return list;
}

export function clearAll(): Conversation[] {
  if (typeof window !== "undefined") window.localStorage.removeItem(KEY);
  return [];
}

/** Derive a short human title from the first user message, if any. */
export function deriveTitle(messages: Message[]): string {
  const firstUser = messages.find((m) => m.role === "user");
  if (firstUser?.text) {
    const t = firstUser.text.trim().replace(/\s+/g, " ");
    return t.length > 46 ? t.slice(0, 46) + "…" : t;
  }
  return "New conversation";
}
