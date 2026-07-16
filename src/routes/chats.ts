import { randomUUID } from "node:crypto";
import { getDb } from "../db.js";
import type { RouteRegistrar } from "../server.js";
import type { StarredChat } from "../types.js";
import { readBody, sendJson } from "./http.js";

type StarredChatInput = {
  session_id?: string | null;
  label?: string;
  notes?: string | null;
  transcript_path?: string | null;
  cwd?: string | null;
  branch?: string | null;
};

function normalizeOptionalText(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function coerceTimestampMs(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    const asNumber = Number(value);
    if (Number.isFinite(asNumber)) {
      return asNumber;
    }
    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) {
      return parsed;
    }
  }
  return Date.now();
}

function formatTimestamp(value: unknown): string {
  return new Date(coerceTimestampMs(value)).toISOString();
}

function mapRow(row: Record<string, unknown>): StarredChat {
  return {
    id: String(row.id ?? ""),
    session_id: typeof row.session_id === "string" ? row.session_id : null,
    label: String(row.label ?? ""),
    notes: typeof row.notes === "string" ? row.notes : null,
    transcript_path: typeof row.transcript_path === "string" ? row.transcript_path : null,
    cwd: typeof row.cwd === "string" ? row.cwd : null,
    branch: typeof row.branch === "string" ? row.branch : null,
    created_at: formatTimestamp(row.created_at)
  };
}

export function registerChatRoutes(server: RouteRegistrar): void {
  const db = getDb();

  server.get("/api/chats/starred", (_req, res) => {
    const rows = db
      .prepare("SELECT * FROM starred_chats ORDER BY created_at DESC")
      .all() as Record<string, unknown>[];
    sendJson(res, 200, rows.map(mapRow));
  }, { fileRpc: "deny" });

  server.post("/api/chats/star", (req, res) => {
    const payload = readBody<StarredChatInput>(req);
    const label = typeof payload.label === "string" ? payload.label.trim() : "";
    if (!label) {
      sendJson(res, 400, { error: "Missing label" });
      return;
    }

    const id = randomUUID();
    const createdAt = Date.now();
    const sessionId =
      typeof payload.session_id === "string" ? payload.session_id.trim() || null : null;

    const entry = {
      id,
      session_id: sessionId,
      label,
      notes: normalizeOptionalText(payload.notes),
      transcript_path: normalizeOptionalText(payload.transcript_path),
      cwd: normalizeOptionalText(payload.cwd),
      branch: normalizeOptionalText(payload.branch),
      created_at: createdAt
    };

    db.prepare(
      `INSERT INTO starred_chats (
        id,
        session_id,
        label,
        notes,
        transcript_path,
        cwd,
        branch,
        created_at
      ) VALUES (
        @id,
        @session_id,
        @label,
        @notes,
        @transcript_path,
        @cwd,
        @branch,
        @created_at
      )`
    ).run(entry);

    sendJson(res, 201, { id });
  }, { fileRpc: "deny" });

  server.delete("/api/chats/starred/:id", (req, res) => {
    const id = req.params.id;
    if (!id) {
      sendJson(res, 400, { error: "Missing chat id" });
      return;
    }
    const result = db
      .prepare("DELETE FROM starred_chats WHERE id = ?")
      .run(id);
    if (result.changes === 0) {
      sendJson(res, 404, { error: "Starred chat not found" });
      return;
    }
    sendJson(res, 200, { ok: true });
  }, { fileRpc: "deny" });

  server.patch("/api/chats/starred/:id", (req, res) => {
    const id = req.params.id;
    if (!id) {
      sendJson(res, 400, { error: "Missing chat id" });
      return;
    }
    const body = readBody<Record<string, unknown>>(req);
    const updates: string[] = [];
    const params: Record<string, unknown> = { id };

    if ("label" in body) {
      if (typeof body.label !== "string") {
        sendJson(res, 400, { error: "Invalid label" });
        return;
      }
      const trimmed = body.label.trim();
      if (!trimmed) {
        sendJson(res, 400, { error: "Label cannot be empty" });
        return;
      }
      updates.push("label = @label");
      params.label = trimmed;
    }

    if ("notes" in body) {
      if (body.notes === null) {
        updates.push("notes = @notes");
        params.notes = null;
      } else if (typeof body.notes === "string") {
        updates.push("notes = @notes");
        params.notes = body.notes.trim() || null;
      } else {
        sendJson(res, 400, { error: "Invalid notes" });
        return;
      }
    }

    if (updates.length === 0) {
      sendJson(res, 400, { error: "No updates provided" });
      return;
    }

    const result = db
      .prepare(`UPDATE starred_chats SET ${updates.join(", ")} WHERE id = @id`)
      .run(params);
    if (result.changes === 0) {
      sendJson(res, 404, { error: "Starred chat not found" });
      return;
    }
    sendJson(res, 200, { ok: true });
  }, { fileRpc: "deny" });
}
