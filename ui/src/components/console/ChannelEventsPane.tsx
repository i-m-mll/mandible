// Bug: b5e1c51 — ChannelEventsPane: renders structured channel events for PTY+Channel sessions
import type { JSX } from 'preact/jsx-runtime';
import { useEffect, useRef, useState } from 'preact/hooks';
import type { StreamEvent } from '../stream-renderer/types';

/** A channel event extracted from the stream event list. */
type ChannelEvent = {
  /** Unique key for React rendering. */
  key: string;
  /** The type of channel event: tool_call, notification, connect, disconnect. */
  eventType: string;
  /** Tool name or event label for the collapsed header. */
  label: string;
  /** ISO timestamp string. */
  timestamp: string;
  /** The raw event payload for the expanded view. */
  payload: Record<string, unknown>;
};

function extractChannelEvents(events: StreamEvent[]): ChannelEvent[] {
  const result: ChannelEvent[] = [];
  for (let i = 0; i < events.length; i++) {
    const event = events[i] as StreamEvent & {
      subtype?: string;
      event_type?: string;
      tool_name?: string;
      tool_input?: unknown;
      tool_output?: unknown;
      notification_type?: string;
      timestamp?: string;
      channel_event?: Record<string, unknown>;
    };
    if (event.type !== 'system' || event.subtype !== 'channel_event') continue;

    const channelData = event.channel_event ?? (event as unknown as Record<string, unknown>);
    const eventType = String(event.event_type ?? channelData.event_type ?? 'unknown');
    let label = eventType;

    if (eventType === 'tool_call') {
      label = String(channelData.tool_name ?? event.tool_name ?? 'tool_call');
    } else if (eventType === 'notification') {
      label = String(channelData.notification_type ?? event.notification_type ?? 'notification');
    } else if (eventType === 'connect') {
      label = 'Channel connected';
    } else if (eventType === 'disconnect') {
      label = 'Channel disconnected';
    }

    result.push({
      key: `ch-${i}`,
      eventType,
      label,
      timestamp: String(event.timestamp ?? channelData.timestamp ?? new Date().toISOString()),
      payload: channelData as Record<string, unknown>,
    });
  }
  return result;
}

function formatTimestamp(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  } catch {
    return iso;
  }
}

/** SVG icon for each event type. */
function EventIcon({ eventType }: { eventType: string }): JSX.Element {
  if (eventType === 'tool_call') {
    // Wrench icon
    return (
      <svg width="14" height="14" viewBox="0 0 16 16" fill="none" style={{ flexShrink: 0 }}>
        <path d="M14.3 2.3a1 1 0 0 0-1.4 0L10 5.2 8.8 4l2.9-2.9a1 1 0 0 0-1.1-1.6A5 5 0 0 0 4.5 6L1.3 9.2a2.5 2.5 0 0 0 3.5 3.5L8 9.5a5 5 0 0 0 6.5-6.1 1 1 0 0 0-.2-1.1z"
          fill="currentColor" opacity="0.7" />
      </svg>
    );
  }
  if (eventType === 'notification') {
    // Bell icon
    return (
      <svg width="14" height="14" viewBox="0 0 16 16" fill="none" style={{ flexShrink: 0 }}>
        <path d="M8 1a1 1 0 0 1 1 1v.3A4.5 4.5 0 0 1 12.5 7v2.5l1.3 1.3a.5.5 0 0 1-.4.9H2.6a.5.5 0 0 1-.4-.9L3.5 9.5V7A4.5 4.5 0 0 1 7 2.3V2a1 1 0 0 1 1-1zm-1.5 12a1.5 1.5 0 0 0 3 0h-3z"
          fill="currentColor" opacity="0.7" />
      </svg>
    );
  }
  if (eventType === 'connect') {
    // Link icon
    return (
      <svg width="14" height="14" viewBox="0 0 16 16" fill="none" style={{ flexShrink: 0 }}>
        <path d="M6.4 9.6a3 3 0 0 0 4.2 0l2-2a3 3 0 1 0-4.2-4.2l-1 1M9.6 6.4a3 3 0 0 0-4.2 0l-2 2a3 3 0 1 0 4.2 4.2l1-1"
          stroke="currentColor" stroke-width="1.5" stroke-linecap="round" opacity="0.7" />
      </svg>
    );
  }
  if (eventType === 'disconnect') {
    // Unlink icon
    return (
      <svg width="14" height="14" viewBox="0 0 16 16" fill="none" style={{ flexShrink: 0 }}>
        <path d="M6.4 9.6a3 3 0 0 0 4.2 0l2-2a3 3 0 1 0-4.2-4.2M9.6 6.4a3 3 0 0 0-4.2 0l-2 2a3 3 0 1 0 4.2 4.2M2 2l12 12"
          stroke="currentColor" stroke-width="1.5" stroke-linecap="round" opacity="0.7" />
      </svg>
    );
  }
  // Default: generic event icon
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" style={{ flexShrink: 0 }}>
      <circle cx="8" cy="8" r="6" stroke="currentColor" stroke-width="1.5" opacity="0.5" />
      <circle cx="8" cy="8" r="2" fill="currentColor" opacity="0.5" />
    </svg>
  );
}

type ChannelEventsPaneProps = {
  streamEvents: StreamEvent[];
  /** Callback to report the total channel event count (used for badge tracking). */
  onEventCountChange?: (count: number) => void;
};

export function ChannelEventsPane({ streamEvents, onEventCountChange }: ChannelEventsPaneProps): JSX.Element {
  const [expandedKeys, setExpandedKeys] = useState<Set<string>>(new Set());
  const scrollRef = useRef<HTMLDivElement>(null);
  const wasAtBottomRef = useRef(true);

  const channelEvents = extractChannelEvents(streamEvents);

  // Report event count changes for badge tracking
  useEffect(() => {
    onEventCountChange?.(channelEvents.length);
  }, [channelEvents.length, onEventCountChange]);

  // Auto-scroll to bottom when new events arrive (if user was already at bottom)
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (wasAtBottomRef.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [channelEvents.length]);

  const handleScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const threshold = 40;
    wasAtBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < threshold;
  };

  const toggleExpand = (key: string) => {
    setExpandedKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  };

  if (channelEvents.length === 0) {
    return (
      <div className="channel-events-pane channel-events-pane--empty">
        <div className="channel-events-pane__empty-message">
          No channel events yet. Events will appear here when the channel connection is active.
        </div>
      </div>
    );
  }

  return (
    <div className="channel-events-pane" ref={scrollRef} onScroll={handleScroll}>
      {channelEvents.map((event) => {
        const isExpanded = expandedKeys.has(event.key);
        return (
          <div
            key={event.key}
            className={`channel-events-pane__card${isExpanded ? ' channel-events-pane__card--expanded' : ''}`}
          >
            <button
              type="button"
              className="channel-events-pane__card-header"
              onClick={() => toggleExpand(event.key)}
            >
              <EventIcon eventType={event.eventType} />
              <span className="channel-events-pane__card-label">{event.label}</span>
              <span className="channel-events-pane__card-time">{formatTimestamp(event.timestamp)}</span>
              <span className={`channel-events-pane__card-chevron${isExpanded ? ' channel-events-pane__card-chevron--open' : ''}`}>
                <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
                  <path d="M3 4l2 2 2-2" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />
                </svg>
              </span>
            </button>
            {isExpanded && (
              <div className="channel-events-pane__card-body">
                <pre className="channel-events-pane__card-json">
                  {JSON.stringify(event.payload, null, 2)}
                </pre>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
