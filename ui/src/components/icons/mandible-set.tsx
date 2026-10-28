import { cloneElement, type ComponentType, type JSX, type VNode } from 'preact';
import type { IconSourceProps } from './types';

function svgIcon(artwork: VNode<JSX.SVGAttributes<SVGSVGElement>>): ComponentType<IconSourceProps> {
  return function SvgIcon({ size = 16, style, ...props }: IconSourceProps): JSX.Element {
    return cloneElement(artwork, {
      ...props, width: size, height: size,
      style: { ...(artwork.props.style as JSX.CSSProperties), ...style },
    });
  };
}

function glyphIcon(glyph: string): ComponentType<IconSourceProps> {
  return function GlyphIcon({ size, style, focusable: _focusable, ...props }: IconSourceProps): JSX.Element {
    return <span {...props} style={{ ...(size === undefined ? {} : { fontSize: size }), ...style }}>{glyph}</span>;
  };
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
const thought = svgIcon(<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M15 14c.2-1 .7-1.7 1.5-2.5 1-.9 1.5-2.2 1.5-3.5A6 6 0 0 0 6 8c0 1 .2 2.2 1.5 3.5.7.7 1.3 1.5 1.5 2.5" />
      <path d="M9 18h6" />
      <path d="M10 22h4" />
    </svg>);

function TokenRemove({ size = 8, style, focusable: _focusable, ...props }: IconSourceProps): JSX.Element {
  const line: JSX.CSSProperties = {
    position: 'absolute', left: 0, top: 'calc(50% - 0.75px)',
    width: '100%', height: 1.5, borderRadius: 999, background: 'currentColor',
  };
  return (
    <span {...props} style={{ display: 'inline-block', position: 'relative', width: size, height: size, ...style }}>
      <span style={{ ...line, transform: 'rotate(45deg)' }} />
      <span style={{ ...line, transform: 'rotate(-45deg)' }} />
    </span>
  );
}

function SelectIndicator({ size = 8, style, focusable: _focusable, ...props }: IconSourceProps): JSX.Element {
  return <span {...props} style={{
    display: 'inline-block', width: size, height: size / 2,
    backgroundImage: 'linear-gradient(45deg, transparent 50%, currentColor 50%), linear-gradient(135deg, currentColor 50%, transparent 50%)',
    backgroundPosition: 'left center, right center', backgroundRepeat: 'no-repeat', backgroundSize: '50% 100%', ...style,
  }} />;
}

const pin = svgIcon(<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 17v5" />
      <path d="M5 17h14" />
      <path d="M7 17l2-8-2-3V3h10v3l-2 3 2 8" />
    </svg>);
const plusGlyph = glyphIcon('+');
const forwardGlyph = glyphIcon('→');
const upGlyph = glyphIcon('↑');
const downGlyph = glyphIcon('↓');
const ellipsisGlyph = glyphIcon('…');
const checkGlyph = glyphIcon('✓');

export const mandibleSet = {
  rightSidebar: svgIcon(<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M15 4v16" />
    </svg>),
  spaces: svgIcon(<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="3" width="7" height="7" rx="1" />
      <rect x="14" y="3" width="7" height="7" rx="1" />
      <rect x="3" y="14" width="7" height="7" rx="1" />
      <rect x="14" y="14" width="7" height="7" rx="1" />
    </svg>),
  briefing: svgIcon(<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 4h13a1 1 0 0 1 1 1v13a2 2 0 0 0 2 2H5a2 2 0 0 1-2-2V5a1 1 0 0 1 1-1z" />
      <path d="M7 8h7" />
      <path d="M7 12h7" />
      <path d="M7 16h4" />
    </svg>),
  experimental: svgIcon(<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 3h6" />
      <path d="M10 3v6l-5 9a2 2 0 0 0 1.75 3h10.5A2 2 0 0 0 19 18l-5-9V3" />
      <path d="M8 15h8" />
    </svg>),
  tasks: svgIcon(<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M8 2v4" />
      <path d="M16 2v4" />
      <path d="M3 10h18" />
      <path d="M21 13V6a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h7" />
      <circle cx="18" cy="18" r="4" />
      <path d="M18 16.5V18l1 1" />
    </svg>),
  close: svgIcon(<svg fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" viewBox="0 0 24 24">
      <path d="m18 6-12 12" />
      <path d="m6 6 12 12" />
    </svg>),
  addHook: svgIcon(<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round">
              <path d="M8 2.5v11M2.5 8h11" />
            </svg>),
  editHook: svgIcon(<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
                      <path d="m10.8 2.5 2.7 2.7M3 13l2.5-.5L13 5a1.9 1.9 0 0 0-2.7-2.7L2.8 9.8 2.3 12.3 3 13Z" />
                    </svg>),
  removeHook: svgIcon(<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
                      <path d="M2.5 4h11M6 4V2.5h4V4m2.5 0-.6 9H4.1l-.6-9m3 2.5v4m3-4v4" />
                    </svg>),
  conversationOverview: svgIcon(<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M4 5h16v14H4z" /><path d="M8 9h8M8 13h5" /></svg>),
  conversationActivity: svgIcon(<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M4 12h3l2-5 4 10 2-5h5" /></svg>),
  more: svgIcon(<svg fill="currentColor" viewBox="0 0 24 24">
      <circle cx="5" cy="12" r="1.5" />
      <circle cx="12" cy="12" r="1.5" />
      <circle cx="19" cy="12" r="1.5" />
    </svg>),
  addAttachment: svgIcon(<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M12 4v16M4 12h16" />
            </svg>),
  addSetting: svgIcon(<svg viewBox="0 0 16 16"><path d="M8 3v10M3 8h10" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" /></svg>),
  removeSetting: svgIcon(<svg viewBox="0 0 16 16"><path d="M3 8h10" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" /></svg>),
  zoomOut: svgIcon(<svg fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
      <circle cx="11" cy="11" r="7" />
      <path d="M8 11h6" />
      <path d="m16 16 4 4" />
    </svg>),
  zoomIn: svgIcon(<svg fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
      <circle cx="11" cy="11" r="7" />
      <path d="M8 11h6" />
      <path d="M11 8v6" />
      <path d="m16 16 4 4" />
    </svg>),
  fitTimeline: svgIcon(<svg fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
      <path d="M4 9V4h5" />
      <path d="M20 9V4h-5" />
      <path d="M4 15v5h5" />
      <path d="M20 15v5h-5" />
      <path d="M8 12h8" />
    </svg>),
  addTimelineRow: svgIcon(<svg fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
      <path d="M5 7h8" />
      <path d="M5 12h8" />
      <path d="M5 17h8" />
      <path d="M18 9v6" />
      <path d="M15 12h6" />
    </svg>),
  spaceDocument: svgIcon(<svg viewBox="0 0 20 20">
          <path d="M5 2.75h6.2L15 6.55v10.7H5z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" />
          <path d="M11 2.9v4h4" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" />
          <path d="M7.4 10.1h5.2M7.4 13h5.2" stroke="currentColor" stroke-width="1.35" stroke-linecap="round" />
        </svg>),
  spaceBoard: svgIcon(<svg viewBox="0 0 20 20">
          <path d="M3.2 4.1h13.6v11.8H3.2z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" />
          <path d="M7.7 4.3v11.3M12.3 4.3v11.3" stroke="currentColor" stroke-width="1.35" stroke-linecap="round" />
          <path d="M4.9 7h1.5M9.3 9.7h1.5M14 7.8h1.3" stroke="currentColor" stroke-width="1.25" stroke-linecap="round" />
        </svg>),
  spaceCollection: svgIcon(<svg viewBox="0 0 20 20">
          <path d="M6.8 5.3h9M6.8 10h9M6.8 14.7h9" stroke="currentColor" stroke-width="1.55" stroke-linecap="round" />
          <path d="M3.9 5.3h.1M3.9 10h.1M3.9 14.7h.1" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" />
        </svg>),
  spaceCanvas: svgIcon(<svg viewBox="0 0 20 20">
          <path d="M7.1 6.2l5.7 2.8M7.1 13.8l5.7-4.8" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" />
          <circle cx="5.1" cy="5.3" r="2.2" fill="none" stroke="currentColor" stroke-width="1.45" />
          <circle cx="14.9" cy="9.8" r="2.2" fill="none" stroke="currentColor" stroke-width="1.45" />
          <circle cx="5.1" cy="14.7" r="2.2" fill="none" stroke="currentColor" stroke-width="1.45" />
        </svg>),
  addSpace: svgIcon(<svg viewBox="0 0 14 14">
    <path d="M7 2v10M2 7h10" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" fill="none" />
  </svg>),
  keep: svgIcon(<svg fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 16 16"><path d="m3 8.5 3 3 7-7" /></svg>),
  discard: svgIcon(<svg fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 16 16"><path d="m4 4 8 8M12 4l-8 8" /></svg>),
  clearVerdict: svgIcon(<svg fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 16 16"><path d="M3.5 10.5 9.75 4.25a1.4 1.4 0 0 1 2 0l1 1a1.4 1.4 0 0 1 0 2L7.25 12.75H5.5zM8 6l3 3M7.25 12.75H13" /></svg>),
  comment: svgIcon(<svg fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 16 16"><path d="M3 3.5h10v7H7l-3.5 2.5v-2.5H3z" /></svg>),
  editAnnotation: svgIcon(<svg fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 16 16"><path d="m3 11.5-.5 2 2-.5 7.75-7.75-1.5-1.5zM9.75 4.75l1.5 1.5" /></svg>),
  previousChange: svgIcon(<svg fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 16 16"><path d="m10 3-5 5 5 5" /></svg>),
  nextChange: svgIcon(<svg fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 16 16"><path d="m6 3 5 5-5 5" /></svg>),
  copy: svgIcon(<svg fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
      <rect x="9" y="9" width="10" height="10" rx="2" />
      <path d="M5 15V7a2 2 0 0 1 2-2h8" />
    </svg>),
  copied: svgIcon(<svg fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
      <path d="M20 6L9 17l-5-5" />
    </svg>),
  messageCopied: svgIcon(<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="20 6 9 17 4 12" />
            </svg>),
  copyMessage: svgIcon(<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
              <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
            </svg>),
  newChat: svgIcon(<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M5 4h10a2 2 0 0 1 2 2v3" />
      <path d="M5 4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h8" />
      <path d="M17 13v8M13 17h8" />
    </svg>),
  addProject: svgIcon(<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
      <path d="M12 5v14M5 12h14" />
    </svg>),
  pin,
  unpin: pin,
  sidebarMore: svgIcon(<svg viewBox="0 0 24 24" fill="currentColor">
          <circle cx="5" cy="12" r="1.75" />
          <circle cx="12" cy="12" r="1.75" />
          <circle cx="19" cy="12" r="1.75" />
        </svg>),
  reorder: svgIcon(<svg viewBox="0 0 14 14" fill="currentColor">
        <circle cx="4" cy="3" r="1" />
        <circle cx="10" cy="3" r="1" />
        <circle cx="4" cy="7" r="1" />
        <circle cx="10" cy="7" r="1" />
        <circle cx="4" cy="11" r="1" />
        <circle cx="10" cy="11" r="1" />
      </svg>),
  clearSearch: svgIcon(<svg fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 12 12">
      <path d="M3 3l6 6M9 3L3 9" />
    </svg>),
  filter: svgIcon(<svg fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
      <path d="M4 6h16M7 12h10M10 18h4" />
    </svg>),
  sidebarMenu: svgIcon(<svg fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
      <path d="M4 6h16M4 12h16M4 18h16" />
    </svg>),
  addSigningKey: svgIcon(<svg viewBox="0 0 16 16"><path d="M8 3v10M3 8h10" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" /></svg>),
  messageSelected: svgIcon(<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <rect x="3" y="3" width="18" height="18" rx="3" ry="3" />
                <polyline points="17 8 10 16 7 13" />
              </svg>),
  selectMessage: svgIcon(<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="3" y="3" width="18" height="18" rx="3" ry="3" />
              </svg>),
  openMarkdown: svgIcon(<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
              <path d="M14 2v6h6" />
              <path d="M9 15h6" />
              <path d="M9 18h3" />
            </svg>),
  toolExecute: svgIcon(<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" strokeLinejoin="round">
      <rect x="1.75" y="2.5" width="12.5" height="11" rx="2" />
      <path d="m4.25 6 2 2-2 2M8.25 10h3" />
    </svg>),
  issueMetadata: svgIcon(<svg fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
      <circle cx="12" cy="12" r="9" />
      <path d="M12 17v-5" />
      <path d="M12 8h.01" />
    </svg>),
  chat: svgIcon(<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
    </svg>),
  history: svgIcon(<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
      <path d="M3 3v5h5" />
      <path d="M12 7v5l4 2" />
    </svg>),
  thought: thought,
  monitor: svgIcon(<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="22 12 18 12 15 21 9 3 6 12 2 12" />
    </svg>),
  issues: svgIcon(<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
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
    </svg>),
  artifacts: svgIcon(<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="m21 8-9-5-9 5 9 5 9-5Z" />
      <path d="M3 8v8l9 5 9-5V8" />
      <path d="M12 13v8" />
      <path d="m7.5 5.5 9 5" />
    </svg>),
  inbox: svgIcon(<svg viewBox="-0.5 -4 25 25" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
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
    </svg>),
  auth: svgIcon(<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10" />
      <path d="m9 12 2 2 4-4" />
    </svg>),
  settings: svgIcon(<svg viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" style={{ verticalAlign: 'middle', display: 'inline-block' }}>
      <path d="M6.5 1.5l-.5 1.5A4.5 4.5 0 0 0 4.5 4l-1.5-.5L1.5 6l1.2.9A4.5 4.5 0 0 0 2.5 8a4.5 4.5 0 0 0 .2 1.1L1.5 10l1.5 2.5 1.5-.5a4.5 4.5 0 0 0 1.5 1l.5 1.5h3l.5-1.5a4.5 4.5 0 0 0 1.5-1l1.5.5 1.5-2.5-1.2-.9A4.5 4.5 0 0 0 13.5 8a4.5 4.5 0 0 0-.2-1.1L14.5 6 13 3.5l-1.5.5A4.5 4.5 0 0 0 10 3L9.5 1.5h-3Z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
      <circle cx="8" cy="8" r="2" stroke="currentColor" strokeWidth="1.3" />
    </svg>),
  graph: svgIcon(<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="18" cy="18" r="3" />
      <circle cx="6" cy="6" r="3" />
      <circle cx="18" cy="6" r="3" />
      <path d="M6 9v6c0 1.7 1.3 3 3 3h3" />
      <line x1="15" y1="6" x2="9" y2="6" />
    </svg>),
  timeline: svgIcon(<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 6h16" />
      <path d="M4 12h16" />
      <path d="M4 18h16" />
      <circle cx="8" cy="6" r="2" />
      <circle cx="14" cy="12" r="2" />
      <circle cx="18" cy="18" r="2" />
    </svg>),
  logs: svgIcon(<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z" />
      <polyline points="14 2 14 8 20 8" />
      <line x1="16" y1="13" x2="8" y2="13" />
      <line x1="16" y1="17" x2="8" y2="17" />
      <line x1="10" y1="9" x2="8" y2="9" />
    </svg>),
  projects: svgIcon(<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="m6 14 1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.54 6a2 2 0 0 1-1.95 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2" />
    </svg>),
  sessionOverview: svgIcon(<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect width="18" height="18" x="3" y="3" rx="2" />
      <circle cx="12" cy="10" r="3" />
      <path d="M7 21v-2a2 2 0 0 1 2-2h6a2 2 0 0 1 2 2v2" />
    </svg>),
  diff: svgIcon(<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="18" cy="18" r="3" />
      <circle cx="6" cy="6" r="3" />
      <path d="M13 6h3a2 2 0 0 1 2 2v7" />
      <path d="M6 9v12" />
    </svg>),
  info: svgIcon(<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10" />
      <path d="M12 16v-4" />
      <path d="M12 8h.01" />
    </svg>),
  terminal: svgIcon(<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect width="20" height="16" x="2" y="4" rx="2" />
      <path d="m6 8 4 4-4 4" />
      <path d="M12 16h6" />
    </svg>),
  preview: svgIcon(<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M2.5 12s3.5-6 9.5-6 9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6Z" />
      <circle cx="12" cy="12" r="2.5" />
    </svg>),
  themeLight: svgIcon(<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.93 4.93l1.42 1.42M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.42-1.42M17.66 6.34l1.41-1.41" />
    </svg>),
  themeDark: svgIcon(<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79Z" />
    </svg>),
  themeSystem: svgIcon(<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2" y="3" width="20" height="14" rx="2" />
      <path d="M8 21h8M12 17v4M12 6a4 4 0 0 0 0 8Z" />
    </svg>),
  chatStop: svgIcon(<svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="1" /></svg>),
  annotate: svgIcon(<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="7" />
          <path d="M12 2v4M12 18v4M2 12h4M18 12h4" />
        </svg>),
  showViewSidebar: svgIcon(<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d={'M8 12h8'} />
      <path d={'m10.5 9.5-2.5 2.5 2.5 2.5'} />
    </svg>),
  hideViewSidebar: svgIcon(<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="4" width="18" height="16" rx="2" />
      {<path d="M9 4v16" />}
      <path d={'M12 12h5'} />
      <path d={'m14.5 9.5 2.5 2.5-2.5 2.5'} />
    </svg>),
  folderClosed: svgIcon(<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      {(<path d="M3 6.5A2.5 2.5 0 0 1 5.5 4h4l2 2.5h7A2.5 2.5 0 0 1 21 9v8a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 17z" />)}
    </svg>),
  folderOpen: svgIcon(<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      {(<path d="M3 7.5A2.5 2.5 0 0 1 5.5 5h4l2 2.5H19A2.5 2.5 0 0 1 21.4 11l-1.55 5.8A2.5 2.5 0 0 1 17.44 18.7H5.35A2.35 2.35 0 0 1 3 16.35z" />)}
    </svg>),
  disclosureCollapsed: svgIcon(<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d={'m9 18 6-6-6-6'} />
    </svg>),
  disclosureExpanded: svgIcon(<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d={'m6 9 6 6 6-6'} />
    </svg>),
  briefingBundleCollapsed: svgIcon(<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      {(<>
          <rect x="2" y="7" width="20" height="14" rx="2" />
          <path d="M8 7V5a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
          <path d="M2 12h20" />
        </>)}
    </svg>),
  briefingBundleExpanded: svgIcon(<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      {(<>
          <path d="m12 2 9 5-9 5-9-5 9-5Z" />
          <path d="m3 12 9 5 9-5" />
          <path d="m3 17 9 5 9-5" />
        </>)}
    </svg>),
  dismiss: glyphIcon("×"),
  menu: ellipsisGlyph,
  forkConversation: glyphIcon('⑁'),
  resume: glyphIcon('↩'),
  information: glyphIcon('ℹ'),
  subagent: glyphIcon('⤷'),
  subagentActivity: glyphIcon('↳'),
  workflow: glyphIcon("◇"),
  attachmentAnnotation: glyphIcon("✎"),
  attachmentImage: glyphIcon("▧"),
  attachmentFile: glyphIcon("▤"),
  pending: ellipsisGlyph,
  toolRead: glyphIcon("↗"),
  toolEdit: glyphIcon("±"),
  toolWrite: plusGlyph,
  toolDelete: glyphIcon("−"),
  toolMove: forwardGlyph,
  toolSwitchMode: forwardGlyph,
  toolSearch: glyphIcon("⌕"),
  toolJavascript: glyphIcon("JS"),
  toolFetch: downGlyph,
  toolBrowser: glyphIcon("◎"),
  planCompleted: checkGlyph,
  planInProgress: glyphIcon("•"),
  planPending: glyphIcon("○"),
  disclosureTextCollapsed: glyphIcon("▸"),
  disclosureTextExpanded: glyphIcon("▾"),
  sectionCollapsed: glyphIcon("▶"),
  sectionExpanded: glyphIcon("▼"),
  sortAscending: upGlyph,
  sortDescending: downGlyph,
  remoteAhead: glyphIcon("☁↑"),
  remoteBehind: glyphIcon("☁↓"),
  pushAll: glyphIcon("↑↑"),
  push: upGlyph,
  pushCompleted: checkGlyph,
  pushFailed: glyphIcon("✗"),
  workSettings: glyphIcon("⚙"),
  plan: glyphIcon("P"),
  add: plusGlyph,
  messageSelect: glyphIcon('□'),
  messageSelectionChecked: checkGlyph,
  openLink: forwardGlyph,
  menuSelected: checkGlyph,
  removeToken: TokenRemove,
  selectIndicator: SelectIndicator,
  warning: glyphIcon('⚠'),
  permission: glyphIcon("!"),
  historyBack: svgIcon(<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1" strokeLinecap="round" strokeLinejoin="round"><path d="m11 6-6 6 6 6" /><path d="M5 12h14" /></svg>),
  historyForward: svgIcon(<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1" strokeLinecap="round" strokeLinejoin="round"><path d="m13 6 6 6-6 6" /><path d="M19 12H5" /></svg>),
  chatSubmit: svgIcon(<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1" strokeLinecap="round" strokeLinejoin="round"><path d="m6 12 6-6 6 6" /><path d="M12 6v12" /></svg>),
  jumpToLatest: svgIcon(<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m6 12 6 6 6-6" /><path d="M12 18V6" /></svg>),
};
