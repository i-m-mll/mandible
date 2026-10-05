import { raiseHookNotificationAttention } from "../claude-hook-attention.js";
import { getDb } from "../db.js";
import { triggerTargetedIngest } from "../ingestion.js";
import type { RequestLike, RouteRegistrar } from "../server.js";
import { broadcastConsoleTelemetry } from "../sse.js";
import { normalizeClaudeStatusline } from "../parsers/context-usage.js";
import { readBody, sendJson } from "./http.js";

type JsonRecord = Record<string, unknown>;

interface HookPayload {
  sessionRef?: unknown;
  session_id?: unknown;
  sessionId?: unknown;
  transcriptPath?: unknown;
  transcript_path?: unknown;
  message?: unknown;
  notification?: unknown;
}

interface ResolvedHookSession {
  consoleSessionId: string | null;
  providerSessionId: string | null;
}

interface StatuslineTelemetry {
  telemetryKey: string;
  consoleSessionId: string | null;
  providerSessionId: string | null;
  transcriptPath: string | null;
  model: string | null;
  contextUsedPercentage: number | null;
  contextWindowSize: number | null;
  contextTotalInputTokens: number | null;
  contextTotalOutputTokens: number | null;
  currentCacheCreationInputTokens: number | null;
  currentCacheReadInputTokens: number | null;
  rateLimitFiveHourUsedPercentage: number | null;
  rateLimitFiveHourResetsAt: string | null;
  rateLimitSevenDayUsedPercentage: number | null;
  rateLimitSevenDayResetsAt: string | null;
  rawPayloadJson: string;
  receivedAt: number;
}

export function registerHookRoutes(server: RouteRegistrar): void {
  server.get("/api/hooks/statusline", (req, res) => {
    const sessionRef =
      normalizeText(req.query.sessionRef) ??
      normalizeText(req.query.session_id) ??
      normalizeText(req.query.sessionId);
    const transcriptPath =
      normalizeText(req.query.transcriptPath) ??
      normalizeText(req.query.transcript_path);
    if (!sessionRef && !transcriptPath) {
      sendJson(res, 400, { error: "sessionRef_or_transcriptPath_required" });
      return;
    }
    const telemetry = readLatestStatuslineTelemetry(sessionRef, transcriptPath);
    sendJson(res, 200, { telemetry: telemetry ? serializeTelemetry(telemetry) : null });
  }, { operation: { id: "get:/api/hooks/statusline", effects: ["ledger:read"], requestSchema: null, reportingCategory: null }, fileRpc: "allow" });

  server.post("/api/hooks/ingest-nudge", async (req, res) => {
    const payload = parseHookPayload(req);
    if (!payload.sessionRef && !payload.transcriptPath) {
      sendJson(res, 400, { error: "sessionRef_or_transcriptPath_required" });
      return;
    }

    const result = await triggerTargetedIngest(payload);
    sendJson(res, 202, result);
  }, { operation: { id: "post:/api/hooks/ingest-nudge", effects: ["delivery:background"], requestSchema: null, reportingCategory: "api" }, fileRpc: "allow" });

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
  }, { operation: { id: "post:/api/hooks/notification", effects: ["delivery:background"], requestSchema: null, reportingCategory: "api" }, fileRpc: "allow" });

  server.post("/api/hooks/statusline", async (req, res) => {
    const parsed = parseStatuslinePayload(req);
    const telemetry = persistStatuslineTelemetry(parsed);
    const ingest = await triggerTargetedIngest({
      sessionRef: telemetry.providerSessionId ?? parsed.sessionRef,
      transcriptPath: telemetry.transcriptPath,
    });
    broadcastConsoleTelemetry({
      console_session_id: telemetry.consoleSessionId,
      session_id: telemetry.consoleSessionId,
      provider_session_id: telemetry.providerSessionId,
      transcript_path: telemetry.transcriptPath,
      telemetry: serializeTelemetry(telemetry),
    });
    sendJson(res, 202, {
      ok: true,
      telemetry: serializeTelemetry(telemetry),
      ingest,
    });
  }, { operation: { id: "post:/api/hooks/statusline", effects: ["delivery:background"], requestSchema: null, reportingCategory: "api" }, fileRpc: "allow" });
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

function parseStatuslinePayload(req: RequestLike): {
  payload: JsonRecord;
  sessionRef: string | null;
  transcriptPath: string | null;
} {
  const body = readBody<unknown>(req);
  const payload = normalizePayloadObject(body);
  const nested = isRecord(payload.statusline) ? payload.statusline : payload;
  const sessionRef =
    normalizeText(req.query.sessionRef) ??
    normalizeText(payload.sessionRef) ??
    normalizeText(nested.sessionRef) ??
    normalizeText(nested.session_id) ??
    normalizeText(nested.sessionId);
  const transcriptPath =
    normalizeText(payload.transcriptPath) ??
    normalizeText(payload.transcript_path) ??
    normalizeText(nested.transcriptPath) ??
    normalizeText(nested.transcript_path);
  return { payload: nested, sessionRef, transcriptPath };
}

function persistStatuslineTelemetry(input: {
  payload: JsonRecord;
  sessionRef: string | null;
  transcriptPath: string | null;
}): StatuslineTelemetry {
  const db = getDb();
  const resolved = resolveHookSession(input.sessionRef, input.transcriptPath);
  const providerSessionId = resolved.providerSessionId ?? input.sessionRef;
  const telemetryKey =
    resolved.consoleSessionId ? `console:${resolved.consoleSessionId}`
      : providerSessionId ? `provider:${providerSessionId}`
        : input.transcriptPath ? `transcript:${input.transcriptPath}`
          : `anonymous:${Date.now()}`;
  const normalizedUsage = normalizeClaudeStatusline(input.payload);
  const contextTotal = normalizedUsage?.accounting.find((entry) => entry.scope === "statusline_total");
  const currentUsage = normalizedUsage?.currentUsage;
  const rateLimits = isRecord(input.payload.rate_limits) ? input.payload.rate_limits : {};
  const fiveHour = isRecord(rateLimits.five_hour) ? rateLimits.five_hour : {};
  const sevenDay = isRecord(rateLimits.seven_day) ? rateLimits.seven_day : {};
  const telemetry: StatuslineTelemetry = {
    telemetryKey,
    consoleSessionId: resolved.consoleSessionId,
    providerSessionId,
    transcriptPath: input.transcriptPath,
    model: modelName(input.payload.model),
    contextUsedPercentage: normalizedUsage?.currentContext.availability === "available"
      ? normalizedUsage.currentContext.percent : null,
    contextWindowSize: normalizedUsage?.modelWindowTokens ?? null,
    contextTotalInputTokens: contextTotal?.inputTokens ?? null,
    contextTotalOutputTokens: contextTotal?.outputTokens ?? null,
    currentCacheCreationInputTokens: currentUsage?.cacheCreationInputTokens ?? null,
    currentCacheReadInputTokens: currentUsage?.cacheReadInputTokens ?? null,
    rateLimitFiveHourUsedPercentage: numberOrNull(fiveHour.used_percentage),
    rateLimitFiveHourResetsAt: normalizeText(fiveHour.resets_at),
    rateLimitSevenDayUsedPercentage: numberOrNull(sevenDay.used_percentage),
    rateLimitSevenDayResetsAt: normalizeText(sevenDay.resets_at),
    rawPayloadJson: JSON.stringify(input.payload),
    receivedAt: Date.now(),
  };
  db.prepare(`
    INSERT INTO console_session_telemetry (
      telemetry_key, console_session_id, provider_session_id, transcript_path,
      model, context_used_percentage, context_window_size, context_input_tokens,
      context_output_tokens, context_cache_creation_input_tokens,
      context_cache_read_input_tokens, rate_limit_five_hour_used_percentage,
      rate_limit_five_hour_resets_at, rate_limit_seven_day_used_percentage,
      rate_limit_seven_day_resets_at, raw_payload_json, received_at
    ) VALUES (
      @telemetryKey, @consoleSessionId, @providerSessionId, @transcriptPath,
      @model, @contextUsedPercentage, @contextWindowSize, @contextTotalInputTokens,
      @contextTotalOutputTokens, @currentCacheCreationInputTokens,
      @currentCacheReadInputTokens, @rateLimitFiveHourUsedPercentage,
      @rateLimitFiveHourResetsAt, @rateLimitSevenDayUsedPercentage,
      @rateLimitSevenDayResetsAt, @rawPayloadJson, @receivedAt
    )
    ON CONFLICT(telemetry_key) DO UPDATE SET
      console_session_id = excluded.console_session_id,
      provider_session_id = excluded.provider_session_id,
      transcript_path = excluded.transcript_path,
      model = excluded.model,
      context_used_percentage = excluded.context_used_percentage,
      context_window_size = excluded.context_window_size,
      context_input_tokens = excluded.context_input_tokens,
      context_output_tokens = excluded.context_output_tokens,
      context_cache_creation_input_tokens = excluded.context_cache_creation_input_tokens,
      context_cache_read_input_tokens = excluded.context_cache_read_input_tokens,
      rate_limit_five_hour_used_percentage = excluded.rate_limit_five_hour_used_percentage,
      rate_limit_five_hour_resets_at = excluded.rate_limit_five_hour_resets_at,
      rate_limit_seven_day_used_percentage = excluded.rate_limit_seven_day_used_percentage,
      rate_limit_seven_day_resets_at = excluded.rate_limit_seven_day_resets_at,
      raw_payload_json = excluded.raw_payload_json,
      received_at = excluded.received_at
  `).run(telemetry);
  return telemetry;
}

function readLatestStatuslineTelemetry(
  sessionRef: string | null,
  transcriptPath: string | null,
): StatuslineTelemetry | null {
  const resolved = resolveHookSession(sessionRef, transcriptPath);
  const keys = [
    resolved.consoleSessionId ? `console:${resolved.consoleSessionId}` : null,
    resolved.providerSessionId ? `provider:${resolved.providerSessionId}` : null,
    sessionRef ? `provider:${sessionRef}` : null,
    transcriptPath ? `transcript:${transcriptPath}` : null,
  ].filter((key): key is string => Boolean(key));
  const db = getDb();
  const row = keys.length > 0
    ? db.prepare(`
        SELECT *
        FROM console_session_telemetry
        WHERE telemetry_key IN (${keys.map(() => "?").join(",")})
           OR console_session_id = ?
           OR provider_session_id = ?
           OR transcript_path = ?
        ORDER BY received_at DESC
        LIMIT 1
      `).get(
        ...keys,
        resolved.consoleSessionId ?? sessionRef,
        resolved.providerSessionId ?? sessionRef,
        transcriptPath,
      )
    : db.prepare(`
        SELECT *
        FROM console_session_telemetry
        WHERE console_session_id = ?
           OR provider_session_id = ?
           OR transcript_path = ?
        ORDER BY received_at DESC
        LIMIT 1
      `).get(resolved.consoleSessionId ?? sessionRef, resolved.providerSessionId ?? sessionRef, transcriptPath);
  return row ? telemetryFromRow(row as Record<string, unknown>) : null;
}

function telemetryFromRow(row: Record<string, unknown>): StatuslineTelemetry {
  return {
    telemetryKey: String(row.telemetry_key ?? ""),
    consoleSessionId: normalizeText(row.console_session_id),
    providerSessionId: normalizeText(row.provider_session_id),
    transcriptPath: normalizeText(row.transcript_path),
    model: normalizeText(row.model),
    contextUsedPercentage: numberOrNull(row.context_used_percentage),
    contextWindowSize: integerOrNull(row.context_window_size),
    contextTotalInputTokens: integerOrNull(row.context_input_tokens),
    contextTotalOutputTokens: integerOrNull(row.context_output_tokens),
    currentCacheCreationInputTokens: integerOrNull(row.context_cache_creation_input_tokens),
    currentCacheReadInputTokens: integerOrNull(row.context_cache_read_input_tokens),
    rateLimitFiveHourUsedPercentage: numberOrNull(row.rate_limit_five_hour_used_percentage),
    rateLimitFiveHourResetsAt: normalizeText(row.rate_limit_five_hour_resets_at),
    rateLimitSevenDayUsedPercentage: numberOrNull(row.rate_limit_seven_day_used_percentage),
    rateLimitSevenDayResetsAt: normalizeText(row.rate_limit_seven_day_resets_at),
    rawPayloadJson: typeof row.raw_payload_json === "string" ? row.raw_payload_json : "{}",
    receivedAt: integerOrNull(row.received_at) ?? 0,
  };
}

function resolveHookSession(sessionRef: string | null, transcriptPath: string | null): ResolvedHookSession {
  const db = getDb();
  if (sessionRef) {
    const consoleRow = db.prepare(`
      SELECT id, provider_session_id
      FROM console_sessions
      WHERE id = ? OR provider_session_id = ? OR mandible_session_id = ?
      ORDER BY updated_at DESC
      LIMIT 1
    `).get(sessionRef, sessionRef, sessionRef) as { id: string; provider_session_id: string | null } | undefined;
    if (consoleRow) {
      return { consoleSessionId: consoleRow.id, providerSessionId: consoleRow.provider_session_id ?? sessionRef };
    }
    const registryRow = db.prepare(`
      SELECT id
      FROM sessions
      WHERE id = ? OR conversation_id = ?
      ORDER BY updated_at DESC
      LIMIT 1
    `).get(sessionRef, sessionRef) as { id: string } | undefined;
    if (registryRow) {
      return { consoleSessionId: null, providerSessionId: sessionRef };
    }
  }

  if (transcriptPath) {
    const consoleRow = db.prepare(`
      SELECT cs.id, cs.provider_session_id, c.session_id
      FROM conversations c
      JOIN console_sessions cs
        ON cs.provider_session_id = c.session_id
        OR cs.id = c.session_id
        OR cs.mandible_session_id = c.session_id
      WHERE c.source_path = ?
      ORDER BY cs.updated_at DESC
      LIMIT 1
    `).get(transcriptPath) as { id: string; provider_session_id: string | null; session_id: string | null } | undefined;
    if (consoleRow) {
      return {
        consoleSessionId: consoleRow.id,
        providerSessionId: consoleRow.provider_session_id ?? consoleRow.session_id ?? null,
      };
    }
    const registryRow = db.prepare(`
      SELECT s.id, c.session_id AS provider_session_id
      FROM conversations c
      JOIN sessions s ON s.id = c.session_id OR s.conversation_id = c.session_id
      WHERE c.source_path = ?
      ORDER BY s.updated_at DESC
      LIMIT 1
    `).get(transcriptPath) as { id: string; provider_session_id: string | null } | undefined;
    if (registryRow) {
      return { consoleSessionId: null, providerSessionId: registryRow.provider_session_id ?? null };
    }
  }

  return { consoleSessionId: null, providerSessionId: null };
}

function serializeTelemetry(telemetry: StatuslineTelemetry): Record<string, unknown> {
  const rawPayload = parseRawPayload(telemetry.rawPayloadJson);
  const normalizedUsage = normalizeClaudeStatusline(rawPayload);
  const totals = normalizedUsage?.accounting.find((entry) => entry.scope === "statusline_total");
  const currentUsage = normalizedUsage?.currentUsage;
  return {
    telemetry_key: telemetry.telemetryKey,
    console_session_id: telemetry.consoleSessionId,
    provider_session_id: telemetry.providerSessionId,
    transcript_path: telemetry.transcriptPath,
    model: telemetry.model,
    context_window: {
      total_input_tokens: totals?.inputTokens ?? telemetry.contextTotalInputTokens,
      total_output_tokens: totals?.outputTokens ?? telemetry.contextTotalOutputTokens,
      used_percentage: normalizedUsage?.currentContext.availability === "available"
        ? normalizedUsage.currentContext.percent : telemetry.contextUsedPercentage,
      context_window_size: normalizedUsage?.modelWindowTokens ?? telemetry.contextWindowSize,
      current_usage: currentUsage ? {
        input_tokens: currentUsage.inputTokens ?? null,
        output_tokens: currentUsage.outputTokens ?? null,
        cache_creation_input_tokens: currentUsage.cacheCreationInputTokens ?? null,
        cache_read_input_tokens: currentUsage.cacheReadInputTokens ?? null,
      } : null,
    },
    rate_limits: {
      five_hour: {
        used_percentage: telemetry.rateLimitFiveHourUsedPercentage,
        resets_at: telemetry.rateLimitFiveHourResetsAt,
      },
      seven_day: {
        used_percentage: telemetry.rateLimitSevenDayUsedPercentage,
        resets_at: telemetry.rateLimitSevenDayResetsAt,
      },
    },
    received_at: telemetry.receivedAt,
  };
}

function parseRawPayload(raw: string): JsonRecord {
  try {
    const value = JSON.parse(raw) as unknown;
    return isRecord(value) ? value : {};
  } catch {
    return {};
  }
}

function normalizePayloadObject(body: unknown): JsonRecord {
  if (isRecord(body)) {
    return body;
  }
  if (typeof body === "string") {
    try {
      const parsed = JSON.parse(body) as unknown;
      return isRecord(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }
  return {};
}

function modelName(value: unknown): string | null {
  if (typeof value === "string") {
    return normalizeText(value);
  }
  if (isRecord(value)) {
    return normalizeText(value.display_name) ?? normalizeText(value.name) ?? normalizeText(value.id);
  }
  return null;
}

function numberOrNull(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function integerOrNull(value: unknown): number | null {
  const parsed = numberOrNull(value);
  return parsed === null ? null : Math.trunc(parsed);
}

function normalizeText(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
