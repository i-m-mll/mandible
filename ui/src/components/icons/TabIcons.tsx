// Bug: 914e9d7 — Tab icon components for header display modes
// Lucide-style inline SVGs: stroke="currentColor", fill="none", stroke-width="2"

type IconProps = {
  size?: number;
  className?: string;
};

const defaults = { size: 16, className: '' };

/** Chat — MessageSquare-style speech bubble */
export function ChatIcon(props: IconProps): JSX.Element {
  const { size, className } = { ...defaults, ...props };
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
    </svg>
  );
}

/** History — Clock with counter-clockwise arrow */
export function HistoryIcon(props: IconProps): JSX.Element {
  const { size, className } = { ...defaults, ...props };
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
      <path d="M3 3v5h5" />
      <path d="M12 7v5l4 2" />
    </svg>
  );
}

/** Thought — Lucide lightbulb (https://lucide.dev/icons/lightbulb).
 * Copyright (c) 2026 Lucide Icons and Contributors. ISC License:
 * Permission to use, copy, modify, and/or distribute this software for any
 * purpose with or without fee is hereby granted, provided that the above
 * copyright notice and this permission notice appear in all copies.
 * THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
 * WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
 * MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR
 * ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
 * WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN
 * ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF
 * OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.
 */
export function LightbulbIcon(props: IconProps): JSX.Element {
  const { size, className } = { ...defaults, ...props };
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <path d="M15 14c.2-1 .7-1.7 1.5-2.5 1-.9 1.5-2.2 1.5-3.5A6 6 0 0 0 6 8c0 1 .2 2.2 1.5 3.5.7.7 1.3 1.5 1.5 2.5" />
      <path d="M9 18h6" />
      <path d="M10 22h4" />
    </svg>
  );
}

/** Monitor — Activity/heartbeat line */
export function MonitorIcon(props: IconProps): JSX.Element {
  const { size, className } = { ...defaults, ...props };
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <polyline points="22 12 18 12 15 21 9 3 6 12 2 12" />
    </svg>
  );
}

/** Issues — Bug icon */
export function IssuesIcon(props: IconProps): JSX.Element {
  const { size, className } = { ...defaults, ...props };
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <path d="M8 2l1.88 1.88" />
      <path d="M14.12 3.88 16 2" />
      <path d="M9 7.13v-1a3.003 3.003 0 1 1 6 0v1" />
      <path d="M12 20c-3.3 0-6-2.7-6-6v-3a4 4 0 0 1 4-4h4a4 4 0 0 1 4 4v3c0 3.3-2.7 6-6 6" />
      <path d="M12 20v-9" />
      <path d="M6.53 9C4.6 8.8 3 7.1 3 5" />
      <path d="M6 13H2" />
      <path d="M3 21c0-2.1 1.7-3.9 3.8-4" />
      <path d="M20.97 5c0 2.1-1.6 3.8-3.5 4" />
      <path d="M22 13h-4" />
      <path d="M17.2 17c2.1.1 3.8 1.9 3.8 4" />
    </svg>
  );
}

/** Artifacts — Package icon */
export function ArtifactsIcon(props: IconProps): JSX.Element {
  const { size, className } = { ...defaults, ...props };
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <path d="m21 8-9-5-9 5 9 5 9-5Z" />
      <path d="M3 8v8l9 5 9-5V8" />
      <path d="M12 13v8" />
      <path d="m7.5 5.5 9 5" />
    </svg>
  );
}

/** Inbox — Custom agent-inbox SVG adapted from agent-inbox.svg */
export function InboxIcon(props: IconProps): JSX.Element {
  const { size, className } = { ...defaults, ...props };
  return (
    <svg width={size} height={size} viewBox="-0.5 -4 25 25" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <defs>
        <clipPath id="tab-inbox-bot-head">
          <path clipRule="evenodd" d="M-5-5h34v34H-5z M8.55 1H15.45A2 2 0 0 1 17.45 3V6.5A2 2 0 0 1 15.45 8.5H8.55A2 2 0 0 1 6.55 6.5V3A2 2 0 0 1 8.55 1Z" />
        </clipPath>
      </defs>
      <g clipPath="url(#tab-inbox-bot-head)">
        <path d="M5.45 4.11 L2 11v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 3H7.24a2 2 0 0 0-1.79 1.11z" />
        <polyline points="22 11 16 11 14 14 10 14 8 11 2 11" />
      </g>
      <rect x="6.55" y="1" width="10.9" height="7.5" rx="2" />
      <line x1="9.95" y1="3.3" x2="9.95" y2="5.8" />
      <line x1="14.05" y1="3.3" x2="14.05" y2="5.8" />
      <path d="M12 1V-2.5H9.3" />
    </svg>
  );
}

/** Auth — Shield with checkmark */
export function AuthIcon(props: IconProps): JSX.Element {
  const { size, className } = { ...defaults, ...props };
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10" />
      <path d="m9 12 2 2 4-4" />
    </svg>
  );
}

/** Settings — Gear (matching existing gear in app.tsx) */
export function SettingsIcon(props: IconProps): JSX.Element {
  const { size, className } = { ...defaults, ...props };
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" className={className} aria-hidden="true" style={{ verticalAlign: 'middle', display: 'inline-block' }}>
      <path d="M6.5 1.5l-.5 1.5A4.5 4.5 0 0 0 4.5 4l-1.5-.5L1.5 6l1.2.9A4.5 4.5 0 0 0 2.5 8a4.5 4.5 0 0 0 .2 1.1L1.5 10l1.5 2.5 1.5-.5a4.5 4.5 0 0 0 1.5 1l.5 1.5h3l.5-1.5a4.5 4.5 0 0 0 1.5-1l1.5.5 1.5-2.5-1.2-.9A4.5 4.5 0 0 0 13.5 8a4.5 4.5 0 0 0-.2-1.1L14.5 6 13 3.5l-1.5.5A4.5 4.5 0 0 0 10 3L9.5 1.5h-3Z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
      <circle cx="8" cy="8" r="2" stroke="currentColor" strokeWidth="1.3" />
    </svg>
  );
}

/** Graph — Network/nodes icon */
export function GraphIcon(props: IconProps): JSX.Element {
  const { size, className } = { ...defaults, ...props };
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <circle cx="18" cy="18" r="3" />
      <circle cx="6" cy="6" r="3" />
      <circle cx="18" cy="6" r="3" />
      <path d="M6 9v6c0 1.7 1.3 3 3 3h3" />
      <line x1="15" y1="6" x2="9" y2="6" />
    </svg>
  );
}

/** Timeline — shared axis with lane marks */
export function TimelineIcon(props: IconProps): JSX.Element {
  const { size, className } = { ...defaults, ...props };
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <path d="M4 6h16" />
      <path d="M4 12h16" />
      <path d="M4 18h16" />
      <circle cx="8" cy="6" r="2" />
      <circle cx="14" cy="12" r="2" />
      <circle cx="18" cy="18" r="2" />
    </svg>
  );
}

/** Logs — FileText icon */
export function LogsIcon(props: IconProps): JSX.Element {
  const { size, className } = { ...defaults, ...props };
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z" />
      <polyline points="14 2 14 8 20 8" />
      <line x1="16" y1="13" x2="8" y2="13" />
      <line x1="16" y1="17" x2="8" y2="17" />
      <line x1="10" y1="9" x2="8" y2="9" />
    </svg>
  );
}

/** Projects — FolderOpen icon */
export function ProjectsIcon(props: IconProps): JSX.Element {
  const { size, className } = { ...defaults, ...props };
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <path d="m6 14 1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.54 6a2 2 0 0 1-1.95 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2" />
    </svg>
  );
}

/** Session Overview — SquareUser (id-card) icon. Issue 037fa85. */
export function SessionOverviewIcon(props: IconProps): JSX.Element {
  const { size, className } = { ...defaults, ...props };
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <rect width="18" height="18" x="3" y="3" rx="2" />
      <circle cx="12" cy="10" r="3" />
      <path d="M7 21v-2a2 2 0 0 1 2-2h6a2 2 0 0 1 2 2v2" />
    </svg>
  );
}

/** Diff — GitCompare icon */
export function DiffIcon(props: IconProps): JSX.Element {
  const { size, className } = { ...defaults, ...props };
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <circle cx="18" cy="18" r="3" />
      <circle cx="6" cy="6" r="3" />
      <path d="M13 6h3a2 2 0 0 1 2 2v7" />
      <path d="M6 9v12" />
    </svg>
  );
}

/** Information — Info circle icon */
export function InfoIcon(props: IconProps): JSX.Element {
  const { size, className } = { ...defaults, ...props };
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <circle cx="12" cy="12" r="10" />
      <path d="M12 16v-4" />
      <path d="M12 8h.01" />
    </svg>
  );
}

/** Console — Terminal square icon */
export function TerminalIcon(props: IconProps): JSX.Element {
  const { size, className } = { ...defaults, ...props };
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <rect width="20" height="16" x="2" y="4" rx="2" />
      <path d="m6 8 4 4-4 4" />
      <path d="M12 16h6" />
    </svg>
  );
}

/** Preview — Eye icon shared by detail/inspector surfaces. */
export function PreviewIcon(props: IconProps): JSX.Element {
  const { size, className } = { ...defaults, ...props };
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <path d="M2.5 12s3.5-6 9.5-6 9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6Z" />
      <circle cx="12" cy="12" r="2.5" />
    </svg>
  );
}

/** Light appearance — Sun icon. */
export function LightThemeIcon(props: IconProps): JSX.Element {
  const { size, className } = { ...defaults, ...props };
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.93 4.93l1.42 1.42M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.42-1.42M17.66 6.34l1.41-1.41" />
    </svg>
  );
}

/** Dark appearance — Moon icon. */
export function DarkThemeIcon(props: IconProps): JSX.Element {
  const { size, className } = { ...defaults, ...props };
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79Z" />
    </svg>
  );
}

/** System appearance — Monitor icon with split light/dark disc. */
export function SystemThemeIcon(props: IconProps): JSX.Element {
  const { size, className } = { ...defaults, ...props };
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <rect x="2" y="3" width="20" height="14" rx="2" />
      <path d="M8 21h8M12 17v4M12 6a4 4 0 0 0 0 8Z" />
    </svg>
  );
}
