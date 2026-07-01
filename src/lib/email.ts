// Sends the booking confirmation email via Resend (https://resend.com).
//
// Why Resend: a service account can't send Google Calendar invite emails for a
// personal Gmail (that needs Domain-Wide Delegation / Workspace). Resend's free
// tier + shared test sender lets us email the user directly with zero DNS setup
// when sending to their own address.
//
// Fully optional: if RESEND_API_KEY isn't set we return a skipped status and the
// booking still succeeds — email is a bonus, never a blocker.

import { DateTime } from "luxon";
import { getConfig } from "./config";

export interface EmailResult {
  sent: boolean;
  skipped?: boolean;
  error?: string;
}

type EmailKind = "booked" | "updated" | "cancelled";

const KIND_META: Record<
  EmailKind,
  { heading: string; subjectPrefix: string; accent: string }
> = {
  booked: { heading: "✓ Meeting scheduled", subjectPrefix: "✓ Scheduled", accent: "#7c9dff,#9b7cff" },
  updated: { heading: "↻ Meeting rescheduled", subjectPrefix: "↻ Rescheduled", accent: "#7c9dff,#56e0c0" },
  cancelled: { heading: "✕ Meeting cancelled", subjectPrefix: "✕ Cancelled", accent: "#ff7a7a,#ff9f5a" },
};

export async function sendConfirmationEmail(params: {
  summary: string;
  startISO: string;
  endISO: string;
  htmlLink?: string;
  kind?: EmailKind;
  attendees?: string[];
}): Promise<EmailResult> {
  const cfg = getConfig();
  if (!cfg.resendApiKey) return { sent: false, skipped: true };
  if (!cfg.notifyEmail) {
    return { sent: false, skipped: true, error: "No NOTIFY_EMAIL configured." };
  }

  const kind = params.kind ?? "booked";
  const meta = KIND_META[kind];
  const start = DateTime.fromISO(params.startISO, { zone: cfg.timezone });
  const end = DateTime.fromISO(params.endISO, { zone: cfg.timezone });
  const when = `${start.toFormat("cccc, LLLL d, yyyy")} · ${start.toFormat(
    "h:mm a"
  )} – ${end.toFormat("h:mm a")} (${cfg.timezone})`;
  const guests = (params.attendees ?? []).filter(Boolean);

  const html = `
  <div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;max-width:520px;margin:0 auto;background:#0b0e1a;color:#eef1f8;border-radius:16px;overflow:hidden;border:1px solid rgba(255,255,255,.08)">
    <div style="background:linear-gradient(135deg,${meta.accent});padding:22px 24px">
      <div style="font-size:13px;letter-spacing:.4px;opacity:.9;text-transform:uppercase">Kairos</div>
      <div style="font-size:20px;font-weight:700;margin-top:4px">${meta.heading}</div>
    </div>
    <div style="padding:24px">
      <div style="font-size:18px;font-weight:600;margin-bottom:14px">${escapeHtml(
        params.summary
      )}</div>
      <div style="font-size:14px;color:#9aa3bd;margin-bottom:6px">🗓️ ${when}</div>
      ${
        guests.length
          ? `<div style="font-size:14px;color:#9aa3bd;margin-bottom:6px">👥 Guests: ${escapeHtml(
              guests.join(", ")
            )}</div>`
          : ""
      }
      ${
        params.htmlLink && kind !== "cancelled"
          ? `<a href="${params.htmlLink}" style="display:inline-block;margin-top:18px;background:#7c9dff;color:#fff;text-decoration:none;padding:11px 18px;border-radius:10px;font-weight:600;font-size:14px">View in Google Calendar</a>`
          : ""
      }
      <div style="font-size:12px;color:#6b7392;margin-top:22px">Sent by your Kairos voice scheduling agent.</div>
    </div>
  </div>`;

  // Email the owner only. In Resend TEST mode (no verified domain) sending to
  // any other address makes the whole request fail, so we don't put guests in
  // `to` — they're listed in the event + email body instead. With a verified
  // domain you could safely add `...guests` here.
  const recipients = [cfg.notifyEmail];

  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${cfg.resendApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: cfg.fromEmail,
        to: recipients,
        subject: `${meta.subjectPrefix}: ${params.summary} — ${start.toFormat(
          "LLL d, h:mm a"
        )}`,
        html,
      }),
    });
    if (!res.ok) {
      const body = await res.text();
      return { sent: false, error: `Resend ${res.status}: ${body.slice(0, 180)}` };
    }
    return { sent: true };
  } catch (e: unknown) {
    return { sent: false, error: e instanceof Error ? e.message : "email failed" };
  }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
