// POST /api/session
//
// Mints a short-lived EPHEMERAL token for the browser to open a Gemini Live
// WebSocket directly — so the real GEMINI_API_KEY never leaves the server.
// Also returns the model id and the server-authored agent config (system
// prompt + tool declarations), keeping a single source of truth on the server.

import { NextResponse } from "next/server";
import { GoogleGenAI } from "@google/genai";
import { getConfig } from "@/lib/config";
import { getSystemPrompt, getToolDeclarations } from "@/lib/agent";

export const dynamic = "force-dynamic"; // never cache: tokens are single-use

export async function POST() {
  const cfg = getConfig();
  if (!cfg.geminiApiKey) {
    return NextResponse.json(
      { error: "GEMINI_API_KEY is not configured on the server." },
      { status: 500 }
    );
  }

  try {
    const ai = new GoogleGenAI({ apiKey: cfg.geminiApiKey });

    const now = Date.now();
    const token = await ai.authTokens.create({
      config: {
        uses: 1, // one Live session per token; client re-mints on reconnect
        expireTime: new Date(now + 30 * 60 * 1000).toISOString(), // 30 min
        newSessionExpireTime: new Date(now + 2 * 60 * 1000).toISOString(), // 2 min to start
        httpOptions: { apiVersion: "v1alpha" },
      },
    });

    return NextResponse.json({
      token: token.name,
      model: cfg.liveModel,
      systemInstruction: getSystemPrompt(),
      tools: getToolDeclarations(),
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json(
      { error: `Failed to mint session token: ${message}` },
      { status: 500 }
    );
  }
}
