import { useEffect, useState } from 'preact/hooks';
import { getStatuslineTelemetry } from '../api';
import type { StatuslineTelemetry } from './contextUsage';

type TelemetryRef = {
  sessionRef?: string | null;
  transcriptPath?: string | null;
};

type TelemetryEventDetail = {
  console_session_id?: string | null;
  session_id?: string | null;
  provider_session_id?: string | null;
  transcript_path?: string | null;
  telemetry?: StatuslineTelemetry;
};

export function useStatuslineTelemetry(ref: TelemetryRef): StatuslineTelemetry | null {
  const [telemetry, setTelemetry] = useState<StatuslineTelemetry | null>(null);
  const sessionRef = ref.sessionRef ?? null;
  const transcriptPath = ref.transcriptPath ?? null;

  useEffect(() => {
    if (!sessionRef && !transcriptPath) {
      setTelemetry(null);
      return undefined;
    }
    let active = true;
    void getStatuslineTelemetry<StatuslineTelemetry>({ sessionRef, transcriptPath })
      .then((next) => {
        if (active) setTelemetry(next);
      })
      .catch(() => {
        if (active) setTelemetry(null);
      });
    return () => {
      active = false;
    };
  }, [sessionRef, transcriptPath]);

  useEffect(() => {
    if (!sessionRef && !transcriptPath) return undefined;
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<TelemetryEventDetail>).detail;
      if (!detail?.telemetry) return;
      const matchesSession =
        (sessionRef && (
          detail.console_session_id === sessionRef ||
          detail.session_id === sessionRef ||
          detail.provider_session_id === sessionRef ||
          detail.telemetry.console_session_id === sessionRef ||
          detail.telemetry.provider_session_id === sessionRef
        ))
        || (transcriptPath && (
          detail.transcript_path === transcriptPath ||
          detail.telemetry.transcript_path === transcriptPath
        ));
      if (matchesSession) {
        setTelemetry(detail.telemetry);
      }
    };
    window.addEventListener('console:telemetry', handler);
    return () => window.removeEventListener('console:telemetry', handler);
  }, [sessionRef, transcriptPath]);

  return telemetry;
}
