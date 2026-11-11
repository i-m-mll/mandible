import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { afterEach, beforeEach, expect, it } from "vitest";
import { AuthQueue } from "../src/auth-queue.js";
import { setDb, type Db } from "../src/db.js";
import type { BranchKeptReason, OutcomeReport, OutcomeStep } from "../src/notices/contract.js";
import { NoticeLog } from "../src/notices/log.js";
import { createOutcomeReporter } from "../src/notices/report.js";
import { renderNotice } from "../src/notices/render.js";
import { withRequestOrigin } from "../src/request-origin.js";
import { getOperator } from "../src/users/store.js";
import { AUTH_COMMAND_REVIEW, createLedgerProject, createMigratedDb } from "./helpers/auth-queue-fixtures.js";

const MAIN = { provider: "claude", agent_id: "s1", session_id: "s1" };
const branch = (name: string, state: OutcomeStep["state"], reason: BranchKeptReason | null): OutcomeStep =>
  ({ kind: "branch_removal", branch: name, state, reason });

it("renders the approved notice text", () => {
  const kept = ["codex/3714497-semantic-activity", "codex/51d5ab9-subagent-description-labels", "codex/51d5ab9-titled-tool-targets",
    "codex/778efee-claude-observations", "codex/778efee-claude-typed-facts", "codex/8a492c3-prefetch-memory",
    "codex/d7e6b92-provider-survey", "codex/reading-session-acquisition"];
  const report = (steps: OutcomeStep[]): OutcomeReport => ({ request_id: "a6e526bf-0000-4000-8000-000000000000", type: "merge", status: "completed",
    merge_commit: "fdd818f8".padEnd(40, "0"), reason: null, steps: [
      ...Array.from({ length: 18 }, (_, i): OutcomeStep => ({ kind: "action", action: "issue_close", issue: `i${i}`, state: "done", reason: null })),
      { kind: "action", action: "checkpoint_add", issue: "c1", state: "done", reason: null },
      ...["a", "b", "c"].map((hook): OutcomeStep => ({ kind: "hook", hook_id: hook, required: true, state: "done", reason: null })),
      ...Array.from({ length: 16 }, (_, i) => branch(`done/${i}`, "done", null)),
      ...steps,
    ] });
  expect(renderNotice(report([
    ...kept.map((name) => branch(name, "kept", "not_merged")),
    branch("integration/mandible-iab-preview-20261102-282088f", "kept", "preview_running"),
  ]), MAIN, "main")).toBe(`Mandible: auth a6e526bf merged as fdd818f8. Done: 18 issues closed, 16 branches and worktrees removed, 3 hooks passed.
Kept, commits not in main (8): ${kept.join(" ")}
Kept, preview running (1): integration/mandible-iab-preview-20261102-282088f
More: mandible auth show a6e526bf`);
  expect(renderNotice(report(Array.from({ length: 9 }, (_, i) => branch(`more/${i}`, "done", null))), MAIN, "main"))
    .toBe("Mandible: auth a6e526bf merged as fdd818f8. All follow-ups done: 18 issues closed, 25 branches and worktrees removed, 3 hooks passed.");
  const failed: OutcomeReport = { request_id: "0123456789", type: "command", status: "failed", merge_commit: null, reason: "exit 3", steps:
    Array.from({ length: 12 }, (_, i): OutcomeStep => ({ kind: "hook", hook_id: `h${i}`, required: true, state: "failed", reason: "timed out" })) };
  expect(renderNotice(failed, { provider: "claude", agent_id: "a9", session_id: "s1" }, "main")).toBe(`Mandible: auth 01234567 failed: exit 3. (submitted by agent a9)
Failed, timed out (12): h0 h1 h2 h3 h4 h5 h6 h7 h8 h9 +2 more
More: mandible auth show 01234567`);
});

let db: Db;
let queue: AuthQueue;
let user: NonNullable<ReturnType<typeof getOperator>>;
let repo: string;
beforeEach(() => {
  db = createMigratedDb(); setDb(db); user = getOperator(db)!;
  repo = createLedgerProject(db, process.cwd()).project.id;
  queue = new AuthQueue({ db, outcomeReporter: createOutcomeReporter(db) });
});
afterEach(async () => { await queue.dispose(); db.close(); });

const submit = (session: string, title = "Reviewed command") => queue.submit({ ...AUTH_COMMAND_REVIEW, type: "command", command: "printf reviewed",
  title, repo, session_id: session, requester_evidence_method: "session_claim" }, user.id);
const operator = { user_id: "", evidence_method: "operator" };
const texts = (provider: "claude" | "codex", session: string) => queue.notices!.collect(provider, session).map((notice) => notice.text);

it("tells the root session of the responsible agent once, and only that session", async () => {
  const request = await submit("agent:claude:s1:a1");
  await queue.reject(request.id, "Not this week", { ...operator, user_id: user.id });
  const line = `Mandible: auth ${request.id.slice(0, 8)} rejected: Not this week. (submitted by agent a1)`;
  expect(texts("claude", "a1")).toEqual([]);
  expect(texts("codex", "s1")).toEqual([]);
  expect(texts("claude", "s1")).toEqual([line]);
  const owed = queue.notices!.collect("claude", "s1");
  expect(owed.map((notice) => notice.text)).toEqual([line]);
  queue.notices!.delivered(owed.map((notice) => notice.id));
  expect(texts("claude", "s1")).toEqual([]);

  queue.assumeRequestResponsibility(request.id, { user_id: user.id, session_id: "agent:claude:s2:s2" }, "Hand off", 2, 0);
  expect(texts("claude", "s2")).toEqual([]);
});

it("finds a Codex thread's root session from its recorded origin and follows a hand-off before delivery", async () => {
  const request = await withRequestOrigin({ provider: "codex", agent_id: "t2", session_id: "r2" }, () => submit("agent:codex:t2"));
  await queue.reject(request.id, "No", { ...operator, user_id: user.id });
  expect(texts("codex", "t2")).toEqual([]);
  expect(texts("codex", "r2")).toEqual([`Mandible: auth ${request.id.slice(0, 8)} rejected: No. (submitted by agent t2)`]);
  queue.assumeRequestResponsibility(request.id, { user_id: user.id, session_id: "agent:claude:s3:s3" }, "Hand off", 2, 0);
  expect(texts("codex", "r2")).toEqual([]);
  expect(texts("claude", "s3")).toEqual([`Mandible: auth ${request.id.slice(0, 8)} rejected: No.`]);
});

it("tells a session nothing about the request it withdrew itself", async () => {
  const request = await submit("agent:claude:s4:s4");
  await queue.withdraw(request.id, "Replacing it", { user_id: user.id, session_id: "agent:claude:s4:s4", evidence_method: "session_claim" }, 1, 0);
  expect(texts("claude", "s4")).toEqual([]);
});

it("raises a second notice when the report changes after delivery, and only then", () => {
  const id = randomUUID();
  db.prepare(`INSERT INTO auth_requests (id, type, command, title, status, output, created_at, updated_at, expires_at)
    VALUES (?, 'command', 'true', 'Fixture', 'completed', '', 1, 1, 2)`).run(id);
  db.prepare(`INSERT INTO auth_hook_executions (id, auth_request_id, hook_id, command, command_digest, required, state, created_at, updated_at)
    VALUES (?, ?, 'rebuild', 'true', ?, 1, 'pending', 1, 1)`).run(randomUUID(), id, "0".repeat(64));
  const log = new NoticeLog(db, createOutcomeReporter(db), () => ({ owner_user_id: user.id, responsibility_session_id: "agent:claude:s5:s5", work_unit_id: null }));
  const deliver = () => { const owed = log.collect("claude", "s5"); log.delivered(owed.map((n) => n.id)); return owed.map((n) => n.text); };

  log.raise(id, { kind: "change" });
  expect(deliver()).toEqual([]);
  log.raise(id, { kind: "transition", actor: null });
  expect(deliver()).toEqual([`Mandible: auth ${id.slice(0, 8)} completed.\nPending (1): rebuild\nMore: mandible auth show ${id.slice(0, 8)}`]);
  log.raise(id, { kind: "change" });
  expect(deliver()).toEqual([]);
  db.prepare("UPDATE auth_hook_executions SET state = 'complete' WHERE auth_request_id = ?").run(id);
  log.raise(id, { kind: "change" });
  log.raise(id, { kind: "change" });
  expect(deliver()).toEqual([`Mandible: auth ${id.slice(0, 8)} completed. All follow-ups done: 1 hook passed.`]);
  log.raise(id, { kind: "change" });
  expect(deliver()).toEqual([]);
});

function runHook(socket: string, payload: unknown): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath.includes("bun") ? process.execPath : "bun", ["--no-install", path.resolve("src/cli/hook-notices.ts"), "claude"],
      { env: { ...process.env, MANDIBLE_SOCKET: socket }, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(JSON.stringify(payload));
  });
}

it("prints owed notices and confirms them; a subagent prints nothing; an absent daemon is exit 1", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "notices-hook-"));
  const socket = path.join(dir, "s.sock");
  const seen: Array<{ url: string; body: unknown }> = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      seen.push({ url: req.url!, body: JSON.parse(body) });
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(req.url === "/api/notices/collect" ? { notices: [{ id: "n1", text: "Mandible: auth 01234567 expired." }] } : { ok: true }));
    });
  });
  try {
    expect(await runHook(socket, { session_id: "s1", hook_event_name: "UserPromptSubmit" }))
      .toMatchObject({ code: 1, stdout: "" });
    await new Promise<void>((resolve) => server.listen(socket, resolve));
    expect(await runHook(socket, { session_id: "s1", agent_id: "a1", hook_event_name: "UserPromptSubmit" })).toEqual({ code: 0, stdout: "", stderr: "" });
    expect(seen).toEqual([]);
    expect(await runHook(socket, { session_id: "s1", hook_event_name: "UserPromptSubmit" }))
      .toEqual({ code: 0, stdout: "Mandible: auth 01234567 expired.\n", stderr: "" });
    expect(seen).toEqual([
      { url: "/api/notices/collect", body: { provider: "claude", session_id: "s1" } },
      { url: "/api/notices/delivered", body: { ids: ["n1"] } },
    ]);
  } finally {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
