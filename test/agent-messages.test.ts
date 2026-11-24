/**
 * A message is stored for one exact agent and handed over by that agent's own
 * hook, through the same collect and confirm routes as settlement notices.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { exactAgentRef, parseExactAgentRef, resolveAmbientProviderIdentity } from "../src/ambient-provider-identity.js";
import { AuthQueue } from "../src/auth-queue.js";
import { claudePreToolUseProjection } from "../src/claude-execution-context.js";
import { setDb, type Db } from "../src/db.js";
import type { NoticeCaller } from "../src/notices/contract.js";
import type { MessageView } from "../src/notices/messages.js";
import { createOutcomeReporter } from "../src/notices/report.js";
import { DEFAULT_WAKE_ENVIRONMENT } from "../src/notices/wake/environment.js";
import { WAKE_EXECUTORS } from "../src/notices/wake/executors.js";
import { WakeReconciler } from "../src/notices/wake/reconciler.js";
import { WakeRouteStore } from "../src/notices/wake/routes.js";
import { registerNoticeRoutes } from "../src/routes/notices.js";
import { PRODUCTION_EFFECTS } from "../src/security/effect-policy.js";
import { Router } from "../src/server.js";
import { getOperator } from "../src/users/store.js";
import { AUTH_COMMAND_REVIEW, createLedgerProject, createMigratedDb } from "./helpers/auth-queue-fixtures.js";

type Identity = { provider: string; agent_id: string | null; session_id: string | null };

let db: Db;
let queue: AuthQueue;
let router: Router;
let user: NonNullable<ReturnType<typeof getOperator>>;
let repo: string;
beforeEach(() => {
  db = createMigratedDb(); setDb(db); user = getOperator(db)!;
  repo = createLedgerProject(db, process.cwd()).project.id;
  queue = new AuthQueue({ db, outcomeReporter: createOutcomeReporter(db) });
  router = new Router({ clientAuth: { authenticate: () => ({ user_id: user.id, slug: user.slug,
    method: "local_socket", source: "local_socket", credential_id: null, effect_ceiling: PRODUCTION_EFFECTS }),
    mode: () => "strict", recordUnattributedWrite: () => undefined } });
  const reconciler = new WakeReconciler({ db, routes: WakeRouteStore.memory(), executors: WAKE_EXECUTORS,
    environment: DEFAULT_WAKE_ENVIRONMENT, kinds: ["message"], logger: () => undefined });
  registerNoticeRoutes(router, queue.notices!, db, { reconciler });
});
afterEach(async () => { await queue.dispose(); db.close(); });

async function send(to: string, text: string, from: Identity | null): Promise<MessageView> {
  const response = await router.invoke({ method: "POST", url: "/api/messages", body: { to, text }, ...(from ? { ambient_identity: from } : {}) });
  expect(response.status, JSON.stringify(response.body)).toBe(201);
  return (response.body as { message: MessageView }).message;
}
async function collect(caller: NoticeCaller): Promise<Array<{ id: string; text: string }>> {
  const response = await router.invoke({ method: "POST", url: "/api/notices/collect", body: caller });
  expect(response.status).toBe(200);
  return (response.body as { notices: Array<{ id: string; text: string }> }).notices;
}
async function confirm(ids: string[]): Promise<void> {
  expect((await router.invoke({ method: "POST", url: "/api/notices/delivered", body: { ids } })).status).toBe(200);
}
async function status(id: string): Promise<MessageView> {
  const response = await router.invoke({ method: "GET", url: `/api/messages/${id}` });
  expect(response.status).toBe(200);
  return (response.body as { message: MessageView }).message;
}

describe("message lifecycle", () => {
  const main = { provider: "claude", agent_id: "s1", session_id: "s1" };
  const subagent = { provider: "claude", agent_id: "a1", session_id: "s1" };
  const codex = { provider: "codex", agent_id: "t1", session_id: "t1" };

  it("is collected once, by its exact recipient only, names its sender, and reads delivered after confirmation", async () => {
    const toSubagent = await send("agent:claude:s1:a1", "Rebase onto\nmain first", codex);
    const toMain = await send("agent:claude:s1:s1", "Done with the parser", subagent);
    const fromShell = await send("agent:claude:s1:s1", "From outside", null);
    expect(toSubagent).toMatchObject({ sender_agent_ref: "agent:codex:t1", recipient_agent_ref: "agent:claude:s1:a1", delivered_at: null });
    expect(fromShell.sender_agent_ref).toBeNull();

    const rejected = await queue.submit({ ...AUTH_COMMAND_REVIEW, type: "command", command: "printf reviewed", title: "Reviewed command",
      repo, session_id: "agent:claude:s1:a1", requester_evidence_method: "session_claim" }, user.id);
    await queue.reject(rejected.id, "Not now", { user_id: user.id, evidence_method: "operator" });

    expect(await collect({ provider: "claude", session_id: "s1", agent_id: "b2" })).toEqual([]);
    expect(await collect({ provider: "codex", session_id: "a1" })).toEqual([]);
    const forSubagent = await collect({ provider: "claude", session_id: "s1", agent_id: "a1" });
    expect(forSubagent).toEqual([{ id: toSubagent.id, text: `Mandible: message ${toSubagent.short_id} from agent:codex:t1: Rebase onto main first` }]);
    const forMain = await collect({ provider: "claude", session_id: "s1" });
    expect(forMain.map((notice) => notice.id)).toEqual([toMain.id, fromShell.id, expect.any(String)]);
    expect(forMain[0].text).toContain("from agent:claude:s1:a1");
    expect(forMain[1].text).toContain("from a shell");
    expect(forMain[2].text).toContain(`auth ${rejected.id.slice(0, 8)} rejected`);
    expect((await collect({ provider: "claude", session_id: "s1", agent_id: "s1" })).map((notice) => notice.id))
      .toEqual(forMain.map((notice) => notice.id));

    expect(await status(toSubagent.short_id)).toMatchObject({ id: toSubagent.id, delivered_at: null });
    await confirm([toSubagent.id]);
    const delivered = await status(toSubagent.short_id);
    expect(delivered.delivered_at).toEqual(expect.any(Number));
    expect(delivered.delivered_at).toBeGreaterThanOrEqual(delivered.sent_at);
    expect(await collect({ provider: "claude", session_id: "s1", agent_id: "a1" })).toEqual([]);
    expect((await collect({ provider: "claude", session_id: "s1" })).map((notice) => notice.id)).toEqual(forMain.map((notice) => notice.id));

    const listed = await router.invoke({ method: "GET", url: "/api/messages", ambient_identity: subagent });
    expect((listed.body as { messages: MessageView[] }).messages.map((message) => message.id)).toEqual([toMain.id, toSubagent.id]);
    expect((await router.invoke({ method: "GET", url: "/api/messages" })).status).toBe(409);
  });

  it("refuses a recipient that is not an exact agent of a known provider, and an unknown id", async () => {
    for (const to of ["agent:claude:s1", "codex:t1", "agent:openai:t1", "agent:claude:s1:a1:x"]) {
      expect((await router.invoke({ method: "POST", url: "/api/messages", body: { to, text: "hi" }, ambient_identity: main })).status, to).toBe(400);
    }
    expect((await router.invoke({ method: "GET", url: "/api/messages/0badc0de" })).status).toBe(404);
    expect(db.prepare("SELECT COUNT(*) AS n FROM notifications").get()).toEqual({ n: 0 });
  });
});

/**
 * Per provider, a captured pair: the environment one of the session's own
 * commands runs with, and a hook payload of that session. A message sent to
 * the ref the command resolves is collected by the hook.
 */
describe("one ref on both sides", () => {
  function exports(command: string): NodeJS.ProcessEnv {
    return Object.fromEntries([...command.matchAll(/(\w+)='([^']*)'/g)].map((match) => [match[1], match[2]]));
  }
  // Claude Code 2.1.328, desktop app, 2026-11-22: a subagent's PreToolUse payload.
  const claudeSession = "420beaf2-df51-4b9e-96ff-87e036d5da01", claudeAgent = "a8a600a2af348152b";
  const claudeCommand = (payload: Record<string, unknown>) => exports(String((claudePreToolUseProjection({
    ...payload, hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "true" },
  }).hookSpecificOutput as { updatedInput: { command: string } }).updatedInput.command));

  const pairs: Array<[string, NodeJS.ProcessEnv, NoticeCaller]> = [
    ["a Claude subagent", claudeCommand({ session_id: claudeSession, agent_id: claudeAgent }),
      { provider: "claude", session_id: claudeSession, agent_id: claudeAgent }],
    ["a Claude main thread", claudeCommand({ session_id: claudeSession }), { provider: "claude", session_id: claudeSession }],
    // Codex desktop thread 01a203f0, 2026-11-22: its commands carry the thread id, and its hooks' `session_id` is the
    // same id (the agent-failure hook echoed it, and notices addressed to it were collected).
    ["a Codex top-level thread", { CODEX_THREAD_ID: "01a203f0-f098-7922-ab6b-19fd4ffb33b7" },
      { provider: "codex", session_id: "01a203f0-f098-7922-ab6b-19fd4ffb33b7" }],
    ["an Antigravity conversation", { ANTIGRAVITY_CONVERSATION_ID: "5f0c2a9e-3d1b-4c55-9a7e-2b8f6d4e1c03" },
      { provider: "antigravity", session_id: "5f0c2a9e-3d1b-4c55-9a7e-2b8f6d4e1c03" }],
  ];

  it.each(pairs)("%s", async (_name, env, hook) => {
    const ref = exactAgentRef(resolveAmbientProviderIdentity(env));
    expect(ref).not.toBeNull();
    expect(parseExactAgentRef(ref!)).not.toBeNull();
    const message = await send(ref!, "ping", null);
    expect((await collect(hook)).map((notice) => notice.id)).toEqual([message.id]);
  });

  it("no longer parses a gemini ref", () => {
    expect(parseExactAgentRef("agent:gemini:5f0c2a9e")).toBeNull();
  });
});
