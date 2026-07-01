// Centralized, validated access to environment configuration.
// Throwing early with a clear message beats a cryptic failure deep in an API call.

export function getConfig() {
  const tz = process.env.AGENT_TIMEZONE || "America/New_York";
  const workStart = parseInt(process.env.WORK_DAY_START || "9", 10);
  const workEnd = parseInt(process.env.WORK_DAY_END || "18", 10);

  return {
    timezone: tz,
    workDayStart: Number.isFinite(workStart) ? workStart : 9,
    workDayEnd: Number.isFinite(workEnd) ? workEnd : 18,
    geminiApiKey: process.env.GEMINI_API_KEY || "",
    liveModel: process.env.GEMINI_LIVE_MODEL || "gemini-2.0-flash-live-001",
    calendarId: process.env.GOOGLE_CALENDAR_ID || "primary",
    // Email (Resend) — optional. If unset, booking still works; email is skipped.
    resendApiKey: process.env.RESEND_API_KEY || "",
    fromEmail: process.env.FROM_EMAIL || "Kairos <onboarding@resend.dev>",
    // Who receives the confirmation. Defaults to the calendar owner if that's an email.
    notifyEmail:
      process.env.NOTIFY_EMAIL ||
      (/@/.test(process.env.GOOGLE_CALENDAR_ID || "")
        ? process.env.GOOGLE_CALENDAR_ID!
        : ""),
    clientEmail: process.env.GOOGLE_CLIENT_EMAIL || "",
    // The private key arrives with literal "\n" sequences when stored as a
    // single-line env var; convert them back to real newlines for the JWT.
    privateKey: (process.env.GOOGLE_PRIVATE_KEY || "").replace(/\\n/g, "\n"),
  };
}

export type AppConfig = ReturnType<typeof getConfig>;
