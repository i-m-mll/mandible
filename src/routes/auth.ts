import { AuthQueue, AuthQueueError } from "../auth-queue.js";
import { getDb, resolvePrefix } from "../db.js";
import type { RequestLike, ResponseLike, RouteRegistrar } from "../server.js";
import type { AuthRequestInput, AuthRequestType } from "../types.js";
import { execSync } from "node:child_process";
import path from "node:path";

function readBody<T>(req: RequestLike): T {
  return (req.body ?? {}) as T;
}

export function registerAuthRoutes(app: RouteRegistrar, queue = new AuthQueue()): AuthQueue {
  app.post("/api/auth/request", (req, res) => {
    const payload = parseAuthRequestPayload(readBody<Record<string, unknown>>(req));
    if (!payload) {
      res.status(400).json({ error: "Invalid auth request payload." });
      return;
    }

    // Bug: 76ea6c6 — fallback for repo name from cwd if missing
    // Bug: b011e5b — if repo looks like a branch name (contains / but not owner/repo), derive from cwd
    const repo = payload.repo;
    const looksLikeBranch = repo && (repo.includes("/") && !repo.match(/^[a-zA-Z0-9._-]+\/[a-zA-Z0-9._-]+$/));
    if (!repo || looksLikeBranch) {
      if (payload.cwd) {
        payload.repo = path.basename(payload.cwd);
      }
    }

    // Auth merge gate: verify Bug: references in non-merge commits
    if (payload.command && (payload.command.includes("auth merge") || payload.command.includes("auth-merge"))) {
      const gateError = verifyBugReferences(payload);
      if (gateError) {
        res.status(400).json({ error: gateError });
        return;
      }
    }

    // Bug: 16985e8 — detect duplicate submissions. Return 409 with the existing
    // request_id so the agent can PUT to update it rather than creating a new one.
    const duplicate = queue.findDuplicate(payload);
    if (duplicate) {
      res.status(409).json({
        error: "Duplicate auth request — a pending or approved request for this branch already exists.",
        request_id: duplicate.id,
        status: duplicate.status
      });
      return;
    }

    const request = queue.submit(payload);
    res.status(201).json({ request_id: request.id });
  });

  app.get("/api/auth/request/:id", (req, res) => {
    const request = queue.getRequest(req.params.id);
    if (!request) {
      // Bug: caa157e — distinguish ambiguous prefix from not-found
      const resolved = resolvePrefix(getDb(), "auth_requests", "id", req.params.id);
      if (!resolved.ok && resolved.error === "ambiguous") {
        res.status(409).json({
          error: `Ambiguous prefix '${req.params.id}' — matches ${resolved.count} requests. Use a longer prefix.`
        });
        return;
      }
      res.status(404).json({ error: "Auth request not found." });
      return;
    }

    // Bug: 0b83252 — resolve dependency status to avoid a second round-trip from the UI
    let dependsOnStatus: string | null = null;
    if (request.depends_on_id) {
      const dep = queue.getRequest(request.depends_on_id);
      dependsOnStatus = dep ? dep.status : null;
    }

    res.json({
      request_id: request.id,
      type: request.type,
      status: request.status,
      output: request.output,
      exit_code: request.exit_code,
      error: request.error,
      repo: request.repo ?? null,
      base_branch: request.base_branch ?? null,
      head_branch: request.head_branch ?? null,
      files_changed: request.files_changed ?? 0,
      additions: request.additions ?? 0,
      deletions: request.deletions ?? 0,
      diff_summary: request.diff_summary ?? null,
      commit_message: request.commit_message ?? null,
      spec_content: request.spec_content ?? null,
      post_merge_handoff: request.post_merge_handoff ?? null,
      issue_ids: request.issue_ids ?? null,
      issues: request.issues ?? null,
      depends_on_id: request.depends_on_id ?? null,
      depends_on_status: dependsOnStatus,
      execution_mode: request.execution_mode
    });
  });

  app.put("/api/auth/request/:id", (req, res) => {
    const result = parseAuthRequestUpdatePayload(readBody<Record<string, unknown>>(req));
    if (!result.ok) {
      res.status(400).json({ error: result.error });
      return;
    }

    try {
      const updated = queue.update(req.params.id, result.payload);
      res.status(200).json({ request_id: updated.id, ...updated });
    } catch (error) {
      if (isHttpError(error)) {
        res.status(error.status).json({ error: error.message });
        return;
      }
      handleQueueError(error, res);
    }
  });

  app.delete("/api/auth/request/:id", (req, res) => {
    const body = readBody<Record<string, unknown>>(req);
    if (typeof body.reason !== "string" || !body.reason.trim()) {
      res.status(400).json({ error: "reason is required" });
      return;
    }
    try {
      queue.delete(req.params.id, body.reason);
      res.status(200).json({ request_id: req.params.id, deleted: true });
    } catch (error) {
      handleQueueError(error, res);
    }
  });

  app.get("/api/auth/queue", (req, res) => {
    const query = req.query ?? {};
    // Bug: dd21c1e — optional ?type=X filter
    const typeFilter = typeof query.type === "string" && VALID_AUTH_REQUEST_TYPES.includes(query.type as AuthRequestType)
      ? (query.type as AuthRequestType)
      : undefined;
    let requests = queue.listActive();
    if (typeFilter) {
      requests = requests.filter((r) => r.type === typeFilter);
    }
    // Bug: 0b83252 — resolve depends_on_status for each request with a dependency
    const enriched = requests.map((r) => {
      if (!r.depends_on_id) return { ...r, depends_on_status: null };
      const dep = queue.getRequest(r.depends_on_id);
      return { ...r, depends_on_status: dep ? dep.status : null };
    });
    res.json({ requests: enriched });
  });

  app.get("/api/auth/history", (req, res) => {
    const query = req.query ?? {};
    // Bug: dd21c1e — optional ?type=X filter
    const typeFilter = typeof query.type === "string" && VALID_AUTH_REQUEST_TYPES.includes(query.type as AuthRequestType)
      ? (query.type as AuthRequestType)
      : undefined;
    const limitRaw = typeof query.limit === "string" ? Number(query.limit) : undefined;
    const limit =
      limitRaw != null && Number.isFinite(limitRaw) && limitRaw > 0
        ? Math.min(limitRaw, 200)
        : 50;
    let requests = queue.listHistory(limit);
    if (typeFilter) {
      requests = requests.filter((r) => r.type === typeFilter);
    }
    res.json({ requests });
  });

  app.post("/api/auth/request/:id/approve", (req, res) => {
    try {
      const request = queue.approve(req.params.id);
      res.status(202).json({ request_id: request.id, status: request.status });
    } catch (error) {
      handleQueueError(error, res);
    }
  });

  app.post("/api/auth/request/:id/reject", (req, res) => {
    try {
      const body = readBody<Record<string, unknown>>(req);
      const reason =
        typeof body.reason === "string" && body.reason.trim().length > 0
          ? body.reason
          : undefined;
      const request = queue.reject(req.params.id, reason);
      res.json({ request_id: request.id, status: request.status, error: request.error });
    } catch (error) {
      handleQueueError(error, res);
    }
  });

  app.post("/api/auth/request/:id/skip", (req, res) => {
    try {
      const request = queue.skip(req.params.id);
      res.json({ request_id: request.id, status: request.status });
    } catch (error) {
      handleQueueError(error, res);
    }
  });

  app.post("/api/auth/request/:id/retry", (req, res) => {
    try {
      const request = queue.retry(req.params.id);
      res.status(200).json({ request_id: request.id, status: request.status });
    } catch (error) {
      handleQueueError(error, res);
    }
  });

  app.post("/api/auth/request/:id/requeue", (req, res) => {
    try {
      const request = queue.requeue(req.params.id);
      res.status(200).json({ request_id: request.id, status: request.status });
    } catch (error) {
      handleQueueError(error, res);
    }
  });

  app.post("/api/auth/request/:id/dismiss", (req, res) => {
    try {
      const request = queue.dismiss(req.params.id);
      res.status(200).json({ request_id: request.id, status: request.status });
    } catch (error) {
      handleQueueError(error, res);
    }
  });

  app.post("/api/auth/request/:id/output", (req, res) => {
    const body = readBody<Record<string, unknown>>(req);
    if (typeof body.chunk !== "string") {
      res.status(400).json({ error: "Invalid output payload." });
      return;
    }
    try {
      queue.appendOutput(req.params.id, body.chunk);
      res.status(202).json({ request_id: req.params.id, ok: true });
    } catch (error) {
      handleQueueError(error, res);
    }
  });

  app.post("/api/auth/request/:id/result", (req, res) => {
    const body = readBody<Record<string, unknown>>(req);
    if (typeof body.exit_code !== "number" || typeof body.output !== "string") {
      res.status(400).json({ error: "Invalid result payload." });
      return;
    }
    const errorText = typeof body.error === "string" ? body.error : undefined;
    try {
      const request = queue.setResult(
        req.params.id,
        body.exit_code,
        body.output,
        errorText
      );
      res.status(200).json({ request_id: request.id, status: request.status });
    } catch (error) {
      handleQueueError(error, res);
    }
  });

  return queue;
}

// Bug: dd21c1e — valid auth request types for input validation
const VALID_AUTH_REQUEST_TYPES: AuthRequestType[] = [
  "merge", "commit", "force-push", "branch-delete", "config-change", "preset-promote", "data-delete"
];

function parseAuthRequestPayload(body: Record<string, unknown>): AuthRequestInput | null {
  if (typeof body.command !== "string" || typeof body.title !== "string") {
    return null;
  }

  // Bug: dd21c1e — parse type, default to 'merge'
  const type: AuthRequestType | undefined =
    typeof body.type === "string" && VALID_AUTH_REQUEST_TYPES.includes(body.type as AuthRequestType)
      ? (body.type as AuthRequestType)
      : undefined;

  const executionMode =
    body.execution_mode === "remote" || body.execution_mode === "daemon"
      ? body.execution_mode
      : undefined;

  const filesChanged =
    typeof body.files_changed === "number" && Number.isFinite(body.files_changed)
      ? body.files_changed
      : undefined;

  const additions =
    typeof body.additions === "number" && Number.isFinite(body.additions)
      ? body.additions
      : undefined;

  const deletions =
    typeof body.deletions === "number" && Number.isFinite(body.deletions)
      ? body.deletions
      : undefined;

  return {
    session_id: typeof body.session_id === "string" ? body.session_id : null,
    type,
    command: body.command,
    title: body.title,
    cwd: typeof body.cwd === "string" ? body.cwd : null,
    diff_summary: typeof body.diff_summary === "string" ? body.diff_summary : null,
    commit_message: typeof body.commit_message === "string" ? body.commit_message : null,
    spec_content: typeof body.spec_content === "string" ? body.spec_content : null,
    repo: typeof body.repo === "string" ? body.repo : undefined,
    base_branch: typeof body.base_branch === "string" ? body.base_branch : undefined,
    head_branch: typeof body.head_branch === "string" ? body.head_branch : undefined,
    files_changed: filesChanged,
    additions,
    deletions,
    post_merge_handoff: typeof body.post_merge_handoff === "string" ? body.post_merge_handoff : (body.post_merge_handoff === null ? null : undefined),
    issues: parseStringArray(body.issues),
    depends_on_id: typeof body.depends_on_id === "string" ? body.depends_on_id : (body.depends_on_id === null ? null : undefined),
    execution_mode: executionMode,
    // Bug: 4e32923 — accept scoping fields from the CLI; null/missing means
    // legacy behaviour (broadcast on resolution, no tier-1 ownership).
    target_session_id: typeof body.target_session_id === "string" ? body.target_session_id : null,
    target_repo_root: typeof body.target_repo_root === "string" ? body.target_repo_root : null
  };
}

// Bug: 297677f — parse a string array field (for issues)
function parseStringArray(value: unknown): string[] | null | undefined {
  if (value === null) return null;
  if (value === undefined) return undefined;
  if (Array.isArray(value) && value.every((v) => typeof v === "string")) {
    return value.length > 0 ? value as string[] : null;
  }
  return undefined;
}

type ParseUpdateResult =
  | { ok: true; payload: Partial<AuthRequestInput> & { status?: "pending" } }
  | { ok: false; error: string };

// Bug: 58d93ee — return typed result instead of null so callers receive
// a descriptive error message rather than a generic 400
function parseAuthRequestUpdatePayload(
  body: Record<string, unknown>
): ParseUpdateResult {
  const payload: Partial<AuthRequestInput> & { status?: "pending" } = {};
  const hasKey = (key: string): boolean => Object.prototype.hasOwnProperty.call(body, key);

  if (hasKey("status")) {
    if (body.status !== "pending") {
      return { ok: false, error: "Invalid status — only 'pending' is accepted (use the retry flow to reset a failed request)" };
    }
    payload.status = "pending";
  }

  // Bug: dd21c1e — allow updating type
  if (hasKey("type")) {
    if (typeof body.type !== "string" || !VALID_AUTH_REQUEST_TYPES.includes(body.type as AuthRequestType)) {
      return { ok: false, error: `Invalid 'type' — must be one of: ${VALID_AUTH_REQUEST_TYPES.join(", ")}` };
    }
    payload.type = body.type as AuthRequestType;
  }

  if (hasKey("title")) {
    if (typeof body.title !== "string") {
      return { ok: false, error: "Invalid 'title' — must be a string" };
    }
    payload.title = body.title;
  }

  if (hasKey("command")) {
    // Bug: 58d93ee — explicit error when caller tries to set command to null
    if (body.command === null) {
      return { ok: false, error: "Invalid 'command' — cannot be set to null; provide a non-empty command string" };
    }
    if (typeof body.command !== "string") {
      return { ok: false, error: "Invalid 'command' — must be a string" };
    }
    payload.command = body.command;
  }

  if (hasKey("cwd")) {
    if (body.cwd === null || typeof body.cwd === "string") {
      payload.cwd = body.cwd as string | null;
    } else {
      return { ok: false, error: "Invalid 'cwd' — must be a string or null" };
    }
  }

  if (hasKey("diff_summary")) {
    if (body.diff_summary === null || typeof body.diff_summary === "string") {
      payload.diff_summary = body.diff_summary as string | null;
    } else {
      return { ok: false, error: "Invalid 'diff_summary' — must be a string or null" };
    }
  }

  if (hasKey("commit_message")) {
    if (body.commit_message === null || typeof body.commit_message === "string") {
      payload.commit_message = body.commit_message as string | null;
    } else {
      return { ok: false, error: "Invalid 'commit_message' — must be a string or null" };
    }
  }

  if (hasKey("spec_content")) {
    if (body.spec_content === null || typeof body.spec_content === "string") {
      payload.spec_content = body.spec_content as string | null;
    } else {
      return { ok: false, error: "Invalid 'spec_content' — must be a string or null" };
    }
  }

  if (hasKey("repo")) {
    if (typeof body.repo !== "string") {
      return { ok: false, error: "Invalid 'repo' — must be a string" };
    }
    payload.repo = body.repo;
  }

  if (hasKey("base_branch")) {
    if (typeof body.base_branch !== "string") {
      return { ok: false, error: "Invalid 'base_branch' — must be a string" };
    }
    payload.base_branch = body.base_branch;
  }

  if (hasKey("head_branch")) {
    if (typeof body.head_branch !== "string") {
      return { ok: false, error: "Invalid 'head_branch' — must be a string" };
    }
    payload.head_branch = body.head_branch;
  }

  if (hasKey("files_changed")) {
    if (typeof body.files_changed !== "number" || !Number.isFinite(body.files_changed)) {
      return { ok: false, error: "Invalid 'files_changed' — must be a finite number" };
    }
    payload.files_changed = body.files_changed;
  }

  if (hasKey("additions")) {
    if (typeof body.additions !== "number" || !Number.isFinite(body.additions)) {
      return { ok: false, error: "Invalid 'additions' — must be a finite number" };
    }
    payload.additions = body.additions;
  }

  if (hasKey("deletions")) {
    if (typeof body.deletions !== "number" || !Number.isFinite(body.deletions)) {
      return { ok: false, error: "Invalid 'deletions' — must be a finite number" };
    }
    payload.deletions = body.deletions;
  }

  if (hasKey("post_merge_handoff")) {
    if (body.post_merge_handoff === null || typeof body.post_merge_handoff === "string") {
      payload.post_merge_handoff = body.post_merge_handoff as string | null;
    } else {
      return { ok: false, error: "Invalid 'post_merge_handoff' — must be a string or null" };
    }
  }

  // Bug: 297677f — issues: array of issue IDs to close on merge
  if (hasKey("issues")) {
    const parsed = parseStringArray(body.issues);
    if (parsed === undefined) {
      return { ok: false, error: "Invalid 'issues' — must be an array of strings or null" };
    }
    payload.issues = parsed;
  }

  if (hasKey("depends_on_id")) {
    if (body.depends_on_id === null || typeof body.depends_on_id === "string") {
      payload.depends_on_id = body.depends_on_id as string | null;
    } else {
      return { ok: false, error: "Invalid 'depends_on_id' — must be a string or null" };
    }
  }

  return { ok: true, payload };
}

function isHttpError(error: unknown): error is { status: number; message: string } {
  if (!error || typeof error !== "object") {
    return false;
  }
  return (
    "status" in error &&
    typeof (error as { status?: unknown }).status === "number" &&
    "message" in error &&
    typeof (error as { message?: unknown }).message === "string"
  );
}

function handleQueueError(error: unknown, res: ResponseLike): void {
  if (error instanceof AuthQueueError) {
    if (error.code === "not_found") {
      res.status(404).json({ error: error.message });
      return;
    }
    if (error.code === "invalid_status") {
      res.status(409).json({ error: error.message, status: error.status });
      return;
    }
    // Bug: 58d93ee — surface invalid_command as 422 Unprocessable Entity so
    // callers (including the dashboard) receive the specific error message
    if (error.code === "invalid_command") {
      res.status(422).json({ error: error.message });
      return;
    }
  }

  res.status(500).json({ error: "Unexpected auth queue error." });
}

function verifyBugReferences(
  payload: AuthRequestInput
): string | null {
  const { cwd, head_branch, base_branch } = payload;
  if (!cwd || !head_branch || !base_branch) {
    return null;
  }

  try {
    const output = execSync(
      `git log --no-merges --format="%H" ${base_branch}..${head_branch}`,
      { cwd, encoding: "utf-8", timeout: 10000 }
    ).trim();

    if (!output) {
      return null;
    }

    const commits = output.split("\n").filter(Boolean);
    const missing: string[] = [];

    for (const sha of commits) {
      const body = execSync(`git log -1 --format="%B" ${sha}`, {
        cwd,
        encoding: "utf-8",
        timeout: 5000,
      }).trim();

      if (!body.split("\n").some((line: string) => line.startsWith("Bug:"))) {
        const oneline = execSync(`git log -1 --oneline ${sha}`, {
          cwd,
          encoding: "utf-8",
          timeout: 5000,
        }).trim();
        missing.push(oneline);
      }
    }

    if (missing.length > 0) {
      return (
        `${missing.length} commit(s) missing Bug: references:\n` +
        missing.map((m) => `  ${m}`).join("\n") +
        "\n\nUse agent-commit --issue <id> for all commits."
      );
    }

    return null;
  } catch (err) {
    console.error("Bug reference verification failed:", err);
    return null;
  }
}
