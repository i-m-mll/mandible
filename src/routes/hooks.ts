import { raiseHookNotificationAttention } from "../claude-hook-attention.js";
import { triggerTargetedIngest } from "../ingestion.js";
import type { RequestLike, RouteRegistrar } from "../server.js";
import { readBody, sendJson } from "./http.js";

interface HookPayload {
  sessionRef?: unknown;
  session_id?: unknown;
  sessionId?: unknown;
  transcriptPath?: unknown;
  transcript_path?: unknown;
  message?: unknown;
  notification?: unknown;
}

export function registerHookRoutes(server: RouteRegistrar): void {
  server.post("/api/hooks/ingest-nudge", async (req, res) => {
    const payload = parseHookPayload(req);
    if (!payload.sessionRef && !payload.transcriptPath) {
      sendJson(res, 400, { error: "sessionRef_or_transcriptPath_required" });
      return;
    }

    const result = await triggerTargetedIngest(payload);
    sendJson(res, 202, result);
  }, { fileRpc: "allow" });

  server.post("/api/hooks/notification", async (req, res) => {
    const payload = parseHookPayload(req);
    if (!payload.sessionRef && !payload.transcriptPath) {
      sendJson(res, 400, { error: "sessionRef_or_transcriptPath_required" });
      return;
    }

    const attention = raiseHookNotificationAttention(payload);
    sendJson(res, 202, {
      ok: true,
      attention,
    });
  }, { fileRpc: "allow" });
}

function parseHookPayload(req: RequestLike): {
  sessionRef: string | null;
  transcriptPath: string | null;
  message: string | null;
} {
  const body = readBody<HookPayload>(req);
  return {
    sessionRef: normalizeText(body.sessionRef) ?? normalizeText(body.session_id) ?? normalizeText(body.sessionId),
    transcriptPath: normalizeText(body.transcriptPath) ?? normalizeText(body.transcript_path),
    message: normalizeText(body.message) ?? normalizeText(body.notification),
  };
}

function normalizeText(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}
