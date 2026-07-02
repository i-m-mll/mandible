import { useEffect, useRef, useState } from 'preact/hooks';
import {
  getConversation,
  getConversations,
  getConsoleStreamEvents,
} from '../../api';
import { getCachedEvents, setCachedEvents } from '../../stream-cache';
import type { StreamEvent } from '../stream-renderer/types';
import {
  computeLiveTail,
  conversationBlocksToStreamEvents,
  deriveStreamingState,
  flushPendingSSE,
} from '../../chat';

export type ConsoleStreamState = {
  streamEvents: StreamEvent[];
  setStreamEvents: (fn: (prev: StreamEvent[]) => StreamEvent[]) => void;
  streaming: boolean;
  setStreaming: (value: boolean) => void;
  hydratingHistory: boolean;
  elapsedSeconds: number | undefined;
  beginLocalPrompt: (text: string) => void;
};

export function useConsoleStream({
  sessionId,
  providerSessionId,
  resumeAtMessage,
  sessionStatus,
}: {
  sessionId: string;
  providerSessionId: string | null;
  resumeAtMessage?: string | null;
  sessionStatus: string;
}): ConsoleStreamState {
  const hydratingRef = useRef(false);
  const pendingSSERef = useRef<StreamEvent[]>([]);
  const [streamEvents, setStreamEvents] = useState<StreamEvent[]>([]);
  const [streaming, setStreaming] = useState(false);
  const [hydratingHistory, setHydratingHistory] = useState(false);
  const [elapsedSeconds, setElapsedSeconds] = useState<number | undefined>(undefined);
  const streamStartAtRef = useRef<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    hydratingRef.current = true;
    pendingSSERef.current = [];

    void getCachedEvents(sessionId).then((cached) => {
      if (cancelled || !cached || cached.length === 0) return;
      setStreamEvents(cached);
      setStreaming(deriveStreamingState(cached));
    }).catch(() => {});

    if (!providerSessionId) {
      getConsoleStreamEvents<StreamEvent>(sessionId, 500)
        .then((events) => {
          if (cancelled) return;
          setStreamEvents(events);
          setStreaming(deriveStreamingState(events));
        })
        .catch(() => {
          if (cancelled) return;
          setStreamEvents([]);
          setStreaming(false);
        })
        .finally(() => {
          if (!cancelled) {
            hydratingRef.current = false;
            flushPendingSSE(pendingSSERef, setStreamEvents, setStreaming);
          }
        });
      return () => { cancelled = true; };
    }

    setHydratingHistory(true);
    const historyPromise = getConversations({ session_id: providerSessionId, limit: 1 })
      .then(async ({ conversations }) => {
        const conversation = conversations[0];
        if (!conversation) return null;
        const detail = await getConversation(conversation.id, resumeAtMessage || undefined);
        return conversationBlocksToStreamEvents(providerSessionId, detail.blocks);
      })
      .catch(() => null);

    const memPromise = getConsoleStreamEvents<StreamEvent>(sessionId, 500).catch(() => [] as StreamEvent[]);

    Promise.all([historyPromise, memPromise])
      .then(([historyEvents, memEvents]) => {
        if (cancelled) return;

        if (historyEvents && historyEvents.length > 0) {
          const liveTail = computeLiveTail(historyEvents, memEvents);
          const tailStartIndex = memEvents.length - liveTail.length;
          const systemEvents = memEvents
            .slice(0, tailStartIndex)
            .filter((event) => event.type === 'system');
          const allEvents = [...systemEvents, ...historyEvents, ...liveTail];
          setStreamEvents(allEvents);
          setStreaming(deriveStreamingState(allEvents));
        } else {
          setStreamEvents(memEvents);
          setStreaming(deriveStreamingState(memEvents));
        }
      })
      .catch(() => {
        if (cancelled) return;
        setStreamEvents([]);
        setStreaming(false);
      })
      .finally(() => {
        if (!cancelled) {
          setHydratingHistory(false);
          hydratingRef.current = false;
          flushPendingSSE(pendingSSERef, setStreamEvents, setStreaming);
        }
      });

    return () => { cancelled = true; };
  }, [providerSessionId, sessionId, resumeAtMessage]);

  useEffect(() => {
    if (streaming && (sessionStatus === 'stopped' || sessionStatus === 'crashed')) {
      setStreaming(false);
    }
  }, [streaming, sessionStatus]);

  const cacheFlushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const streamEventsRef = useRef(streamEvents);
  streamEventsRef.current = streamEvents;
  const sessionIdRef = useRef(sessionId);
  sessionIdRef.current = sessionId;
  const streamingRef = useRef(streaming);
  streamingRef.current = streaming;

  useEffect(() => {
    if (!streaming) return;
    const scheduleFlush = () => {
      cacheFlushTimerRef.current = setTimeout(() => {
        const events = streamEventsRef.current;
        if (events.length > 0) {
          void setCachedEvents(sessionIdRef.current, events).catch(() => {});
        }
        if (streamingRef.current) scheduleFlush();
      }, 2000);
    };
    scheduleFlush();
    return () => {
      if (cacheFlushTimerRef.current) clearTimeout(cacheFlushTimerRef.current);
    };
  }, [streaming]);

  useEffect(() => {
    const flushToCache = () => {
      const events = streamEventsRef.current;
      if (events.length > 0) {
        void setCachedEvents(sessionIdRef.current, events).catch(() => {});
      }
    };
    window.addEventListener('beforeunload', flushToCache);
    return () => {
      window.removeEventListener('beforeunload', flushToCache);
      flushToCache();
    };
  }, [sessionId]);

  useEffect(() => {
    if (!streaming) return;
    const check = () => {
      void getConsoleStreamEvents<StreamEvent>(sessionId, 500).then((events) => {
        if (events.length > 0) {
          const last = events[events.length - 1];
          if (last.type === 'result') {
            setStreamEvents(events);
            setStreaming(false);
          }
        }
      }).catch(() => {});
    };
    const timer = setTimeout(check, 5_000);
    return () => clearTimeout(timer);
  }, [streaming, sessionId]);

  useEffect(() => {
    const handleStreamEvent = (event: Event) => {
      const detail = (event as CustomEvent<{ console_session_id: string; event: StreamEvent }>).detail;
      if (!detail || detail.console_session_id !== sessionId) return;
      const streamEvent = detail.event;
      if (!streamEvent) return;

      if (hydratingRef.current) {
        pendingSSERef.current.push(streamEvent);
        return;
      }

      setStreamEvents((prev) => {
        const last = prev[prev.length - 1];
        if (last && JSON.stringify(last) === JSON.stringify(streamEvent)) {
          return prev;
        }
        return [...prev, streamEvent];
      });
      if (streamEvent.type === 'result') {
        setStreaming(false);
        streamStartAtRef.current = null;
      } else {
        setStreaming(true);
      }
    };

    window.addEventListener('console:stream_event', handleStreamEvent);
    return () => {
      window.removeEventListener('console:stream_event', handleStreamEvent);
      setStreamEvents([]);
      setStreaming(false);
    };
  }, [sessionId]);

  useEffect(() => {
    if (!streaming) {
      setElapsedSeconds(undefined);
      return;
    }
    if (streamStartAtRef.current === null) {
      let recovered = false;
      for (let i = streamEvents.length - 1; i >= 0; i--) {
        const event = streamEvents[i];
        if (event.type === 'synthetic_prompt') {
          const localId = (event as { localId?: string }).localId;
          if (localId) {
            const match = localId.match(/^sp-(\d+)-/);
            if (match) {
              streamStartAtRef.current = Number(match[1]);
              recovered = true;
              break;
            }
          }
        }
        if (event.type === 'result') break;
      }
      if (!recovered) {
        streamStartAtRef.current = Date.now();
      }
    }
    setElapsedSeconds(Math.floor((Date.now() - streamStartAtRef.current) / 1000));
    const interval = window.setInterval(() => {
      if (streamStartAtRef.current !== null) {
        setElapsedSeconds(Math.floor((Date.now() - streamStartAtRef.current) / 1000));
      }
    }, 1000);
    return () => window.clearInterval(interval);
  }, [streaming, streamEvents]);

  const beginLocalPrompt = (text: string) => {
    const localId = `sp-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    setStreamEvents((prev) => [...prev, {
      type: 'synthetic_prompt',
      localId,
      text,
    }]);
    setElapsedSeconds(0);
    streamStartAtRef.current = Date.now();
    setStreaming(true);
  };

  return {
    streamEvents,
    setStreamEvents,
    streaming,
    setStreaming,
    hydratingHistory,
    elapsedSeconds,
    beginLocalPrompt,
  };
}
