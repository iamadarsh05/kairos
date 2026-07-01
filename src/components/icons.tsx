// Minimal inline SVG icons (Lucide-style). Inline so they inherit `currentColor`,
// scale crisply, and add zero dependencies.

type Props = { className?: string };

const base = {
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 2,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
};

/** AI "sparkle" logo mark — main star filled for a premium, dimensional look. */
export function SparklesIcon({ className }: Props) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden="true">
      <path
        d="M11.5 2.2a.6.6 0 0 1 1 0l1.7 5.2a3 3 0 0 0 1.9 1.9l5.2 1.7a.6.6 0 0 1 0 1.1l-5.2 1.7a3 3 0 0 0-1.9 1.9l-1.7 5.2a.6.6 0 0 1-1 0l-1.7-5.2a3 3 0 0 0-1.9-1.9l-5.2-1.7a.6.6 0 0 1 0-1.1l5.2-1.7a3 3 0 0 0 1.9-1.9z"
        fill="currentColor"
      />
      <circle cx="19" cy="5" r="1.4" fill="currentColor" opacity="0.85" />
      <circle cx="5.5" cy="18.5" r="1" fill="currentColor" opacity="0.7" />
    </svg>
  );
}

export function MicIcon({ className }: Props) {
  return (
    <svg {...base} className={className} aria-hidden="true">
      <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" />
      <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
      <line x1="12" x2="12" y1="19" y2="22" />
    </svg>
  );
}

export function MicOffIcon({ className }: Props) {
  return (
    <svg {...base} className={className} aria-hidden="true">
      <line x1="2" x2="22" y1="2" y2="22" />
      <path d="M18.89 13.23A7.12 7.12 0 0 0 19 12v-2" />
      <path d="M5 10v2a7 7 0 0 0 12 5" />
      <path d="M15 9.34V5a3 3 0 0 0-5.68-1.33" />
      <path d="M9 9v3a3 3 0 0 0 5.12 2.12" />
      <line x1="12" x2="12" y1="19" y2="22" />
    </svg>
  );
}

export function StopIcon({ className }: Props) {
  return (
    <svg {...base} className={className} aria-hidden="true">
      <rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor" />
    </svg>
  );
}

export function SendIcon({ className }: Props) {
  return (
    <svg {...base} className={className} aria-hidden="true">
      <path d="m22 2-7 20-4-9-9-4Z" />
      <path d="M22 2 11 13" />
    </svg>
  );
}

export function HistoryIcon({ className }: Props) {
  return (
    <svg {...base} className={className} aria-hidden="true">
      <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
      <path d="M3 3v5h5" />
      <path d="M12 7v5l4 2" />
    </svg>
  );
}

export function PlusIcon({ className }: Props) {
  return (
    <svg {...base} className={className} aria-hidden="true">
      <path d="M5 12h14" />
      <path d="M12 5v14" />
    </svg>
  );
}

export function CheckIcon({ className }: Props) {
  return (
    <svg {...base} className={className} aria-hidden="true">
      <path d="M20 6 9 17l-5-5" />
    </svg>
  );
}

export function CalendarIcon({ className }: Props) {
  return (
    <svg {...base} className={className} aria-hidden="true">
      <rect x="3" y="4" width="18" height="18" rx="2" />
      <path d="M3 10h18" />
      <path d="M8 2v4" />
      <path d="M16 2v4" />
    </svg>
  );
}

export function TrashIcon({ className }: Props) {
  return (
    <svg {...base} className={className} aria-hidden="true">
      <path d="M3 6h18" />
      <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
      <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
    </svg>
  );
}

export function ZapIcon({ className }: Props) {
  return (
    <svg {...base} className={className} aria-hidden="true">
      <path
        d="M13 2 4.5 12.5a1 1 0 0 0 .8 1.6H11l-1 7.9 8.5-10.5a1 1 0 0 0-.8-1.6H12z"
        fill="currentColor"
        stroke="none"
      />
    </svg>
  );
}

export function MessageIcon({ className }: Props) {
  return (
    <svg {...base} className={className} aria-hidden="true">
      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
    </svg>
  );
}

export function CloseIcon({ className }: Props) {
  return (
    <svg {...base} className={className} aria-hidden="true">
      <path d="M18 6 6 18" />
      <path d="m6 6 12 12" />
    </svg>
  );
}
