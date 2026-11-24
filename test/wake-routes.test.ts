/**
 * A message stored for an idle session wakes it once, through the route the
 * session registered, and the sender is told the message's reach.
 */
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AuthQueue } from "../src/auth-queue.js";
import { setDb, type Db } from "../src/db.js";
import type { MessageReach, MessageView } from "../src/notices/messages.js";
import { createOutcomeReporter } from "../src/notices/report.js";
import { WakeReconciler, WAKE_HOLD_MS } from "../src/notices/wake/reconciler.js";
import { WakeRouteStore } from "../src/notices/wake/routes.js";
import type { RegisteredRoute, Result, WakeExecutor, WakeFailure, WakeProvider, WakeTarget } from "../src/notices/wake/types.js";
import { registerNoticeRoutes } from "../src/routes/notices.js";
import { PRODUCTION_EFFECTS } from "../src/security/effect-policy.js";
import { applyExecutionEnvelope, SessionExecutionStore } from "../src/session-execution.js";
import { Router } from "../src/server.js";
import { getOperator } from "../src/users/store.js";
import { createMigratedDb } from "./helpers/auth-queue-fixtures.js";
import { fileRpc, runCli, scratchDir, startStubDaemon } from "./helpers/cli-process.js";

const TOKEN = "tok-5f0c2a9e3d1b4c55";
const CLAUDE_ROUTE: RegisteredRoute = { provider: "claude", socket: "/tmp/cc-socks/41.sock", token: TOKEN };

type Answer = Result<void, WakeFailure> | "pending";

let db: Db, queue: AuthQueue, router: Router, routes: WakeRouteStore, reconciler: WakeReconciler;
let calls: WakeTarget[], answer: Answer, release: () => void, clock: number, logs: string[], root: string;
let stopWatch: () => void;

function setup(sendWaitMs?: number): void {
  db = createMigratedDb(); setDb(db);
  const user = getOperator(db)!;
  queue = new AuthQueue({ db, outcomeReporter: createOutcomeReporter(db) });
  root = scratchDir("wake-routes");
  routes = WakeRouteStore.open(path.join(root, "main.wake-routes.json")).store;
  const executor: WakeExecutor = (target) => {
    calls.push(target);
    if (answer !== "pending") return Promise.resolve(answer);
    return new Promise((resolve) => { release = () => resolve({ ok: true, value: undefined }); });
  };
  const executors: Record<WakeProvider, WakeExecutor> = { claude: executor, codex: executor, antigravity: executor };
  reconciler = new WakeReconciler({ db, routes, executors, kinds: ["message"], now: () => clock,
    environment: { home: root, run: () => { throw new Error("the fake executor runs nothing"); }, alive: () => false },
    logger: (level, message, details) => logs.push(JSON.stringify({ level, message, details })) });
  stopWatch = reconciler.watchExecution();
  router = new Router({
    clientAuth: { authenticate: () => ({ user_id: user.id, slug: user.slug, method: "local_socket", source: "local_socket",
      credential_id: null, effect_ceiling: PRODUCTION_EFFECTS }), mode: () => "strict", recordUnattributedWrite: () => undefined },
    registerWakeRoute: (identity, route) => reconciler.registerFromCommand(identity, route),
  });
  registerNoticeRoutes(router, queue.notices!, db, { reconciler, ...(sendWaitMs === undefined ? {} : { send_wait_ms: sendWaitMs }) });
}

beforeEach(() => { calls = []; answer = { ok: true, value: undefined }; clock = 1_000_000; logs = []; });
afterEach(async () => {
  await reconciler.settled(); stopWatch(); await queue.dispose(); db.close();
  fs.rmSync(root, { recursive: true, force: true });
});

const SESSION = "s1", MAIN = "agent:claude:s1:s1";

/** A hook observation, as the execution outbox applies it. */
async function observe(event: string, provider: "claude" | "codex" = "claude", session = SESSION): Promise<void> {
  clock += 1;
  const applied = applyExecutionEnvelope(new SessionExecutionStore(db),
    { provider, session_id: session, hook_event_name: event, ...(event === "SessionStart" ? { source: "startup" } : {}) }, clock);
  expect(applied.ok).toBe(true);
  await reconciler.settled();
}
async function send(to = MAIN, text = "ping"): Promise<MessageView> {
  clock += 1;
  const response = await router.invoke({ method: "POST", url: "/api/messages", body: { to, text } });
  expect(response.status, JSON.stringify(response.body)).toBe(201);
  return (response.body as { message: MessageView }).message;
}
async function status(id: string): Promise<MessageReach> {
  const response = await router.invoke({ method: "GET", url: `/api/messages/${id}` });
  expect(response.status).toBe(200);
  return (response.body as { message: MessageView }).message.reach;
}
async function collect(provider: string, session: string, route?: RegisteredRoute): Promise<string[]> {
  clock += 1;
  const response = await router.invoke({ method: "POST", url: "/api/notices/collect",
    body: { provider, session_id: session, ...(route ? { route } : {}) } });
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  const ids = (response.body as { notices: Array<{ id: string }> }).notices.map((notice) => notice.id);
  if (ids.length) expect((await router.invoke({ method: "POST", url: "/api/notices/delivered", body: { ids } })).status).toBe(200);
  return ids;
}

describe("the reconciler", () => {
  beforeEach(() => setup());

  it("wakes a stopped session once for three messages, and again once a hook call answers the wake", async () => {
    await observe("UserPromptSubmit"); await observe("Stop");
    await send(); await send(); await send();
    expect(calls.map((call) => [call.provider, call.session_id])).toEqual([["claude", SESSION]]);
    await collect("claude", SESSION);
    await send();
    expect(calls).toHaveLength(2);
  });

  it("wakes again once an unanswered wake is older than the hold", async () => {
    await observe("Stop");
    await send();
    clock += WAKE_HOLD_MS;
    await send();
    expect(calls).toHaveLength(2);
  });

  it("does not wake a working session whose Stop hook collects the message", async () => {
    await observe("UserPromptSubmit");
    const message = await send();
    expect(await collect("claude", SESSION)).toEqual([message.id]);
    await observe("Stop");
    expect(calls).toEqual([]);
  });

  it("wakes exactly once when the message lands between an empty Stop collect and the stopped observation", async () => {
    await observe("UserPromptSubmit");
    expect(await collect("claude", SESSION)).toEqual([]);
    await send();
    expect(calls).toEqual([]);
    await observe("Stop");
    expect(calls).toHaveLength(1);
  });

  it("never wakes an ended session, a session with no record, a subagent, or for a non-message row", async () => {
    await send("agent:claude:s2:s2");
    await send("agent:codex:t9");
    await observe("Stop", "claude", "s3"); await observe("SessionEnd", "claude", "s3");
    await send("agent:claude:s3:s3");
    await observe("Stop");
    await send("agent:claude:s1:child");
    db.prepare(`INSERT INTO notifications (id, subject_kind, subject_id, recipient_kind, recipient_provider, recipient_id,
      responsible_agent_ref, raised_at, digest, text) VALUES ('r1', 'reminder', 'r1', 'session', 'claude', ?, ?, ?, 'd', 'Reminder')`)
      .run(SESSION, MAIN, clock);
    await observe("UserPromptSubmit"); await observe("Stop");
    expect(calls).toEqual([]);
  });

  it("wakes an Antigravity conversation, which has no execution record, and a stopped Codex thread", async () => {
    await send("agent:antigravity:c1");
    await observe("Stop", "codex", "t1");
    await send("agent:codex:t1");
    expect(calls.map((call) => [call.provider, call.session_id, call.registered])).toEqual([["antigravity", "c1", null], ["codex", "t1", null]]);
  });
});

describe("routes", () => {
  beforeEach(() => setup());

  it("are registered by the collect request and by a command, replaced by a later one, and kept across a reload", async () => {
    await collect("claude", SESSION, CLAUDE_ROUTE);
    await observe("Stop");
    await send();
    expect(calls[0].registered).toEqual(CLAUDE_ROUTE);

    const replaced = { ...CLAUDE_ROUTE, socket: "/tmp/cc-socks/42.sock", token: `${TOKEN}-2` };
    const command = await router.invoke({ method: "GET", url: "/api/messages", wake_route: replaced,
      ambient_identity: { provider: "claude", session_id: SESSION, agent_id: SESSION } });
    expect(command.status).toBe(200);
    expect(routes.get("claude", SESSION)).toEqual(replaced);
    const antigravity = { provider: "antigravity", address: "127.0.0.1:5123", token: TOKEN } as const;
    expect((await router.invoke({ method: "GET", url: "/api/messages", wake_route: antigravity,
      ambient_identity: { provider: "antigravity", session_id: "c1", agent_id: "c1" } })).status).toBe(200);
    const file = path.join(root, "main.wake-routes.json");
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    const reloaded = WakeRouteStore.open(file);
    expect(reloaded.error).toBeNull();
    expect([reloaded.store.get("claude", SESSION), reloaded.store.get("antigravity", "c1")]).toEqual([replaced, antigravity]);
  });

  it("refuses a route of another provider than the caller's, or a malformed one", async () => {
    const codexCaller = { provider: "codex", session_id: null, agent_id: "t1" };
    for (const [route, identity] of [[CLAUDE_ROUTE, codexCaller], [{ provider: "claude", socket: "/s" }, { provider: "claude", session_id: SESSION, agent_id: SESSION }]] as const) {
      expect((await router.invoke({ method: "GET", url: "/api/messages", wake_route: route, ambient_identity: identity })).status).toBe(400);
    }
    expect((await router.invoke({ method: "POST", url: "/api/notices/collect",
      body: { provider: "codex", session_id: "t1", route: CLAUDE_ROUTE } })).status).toBe(400);
    expect(routes.get("claude", SESSION)).toBeNull();
  });

  it("are dropped when the route refuses the connection and when the session ends", async () => {
    await collect("claude", SESSION, CLAUDE_ROUTE);
    await observe("Stop");
    answer = { ok: false, error: { code: "route_refused", detail: `connect ECONNREFUSED with ${TOKEN}` } };
    await send();
    expect(routes.get("claude", SESSION)).toBeNull();
    await collect("claude", SESSION, CLAUDE_ROUTE);
    await observe("SessionEnd");
    expect(routes.get("claude", SESSION)).toBeNull();
  });

  it("leave the token in no database row, log line or stored error", async () => {
    await collect("claude", SESSION, CLAUDE_ROUTE);
    await observe("Stop");
    answer = { ok: false, error: { code: "entry_point_failed", detail: `refused token ${TOKEN}` } };
    await send();
    const copy = path.join(root, "copy.db");
    db.exec(`VACUUM INTO '${copy}'`);
    expect(fs.readFileSync(copy).includes(TOKEN)).toBe(false);
    expect(logs.join("\n")).not.toContain(TOKEN);
    expect(db.prepare("SELECT error FROM session_wakes").get()).toEqual({ error: "refused token <token>" });
  });
});

describe("reach", () => {
  it.each<[string, (message: () => Promise<MessageView>) => Promise<MessageReach>, MessageReach["kind"], number | undefined]>([
    ["working", async (sent) => { await observe("UserPromptSubmit"); return (await sent()).reach; }, "working", undefined],
    ["woken", async (sent) => { await observe("Stop"); return (await sent()).reach; }, "woken", undefined],
    ["wake in progress", async (sent) => { answer = "pending"; await observe("Stop"); return (await sent()).reach; }, "wake_in_progress", 0],
    ["not woken", async (sent) => { answer = { ok: false, error: { code: "no_route" } }; await observe("Stop"); return (await sent()).reach; }, "not_woken", undefined],
    ["ended", async (sent) => { await observe("SessionEnd"); return (await sent()).reach; }, "ended", undefined],
    ["unknown", async (sent) => (await sent()).reach, "unknown", undefined],
  ])("is %s at send and at status", async (_name, arrange, kind, wait) => {
    setup(wait);
    let id = "";
    const atSend = await arrange(async () => { const message = await send(); id = message.id; return message; });
    expect(atSend.kind).toBe(kind);
    expect((await status(id)).kind).toBe(kind);
    if (answer === "pending") { release(); await reconciler.settled(); expect((await status(id)).kind).toBe("woken"); }
  });

  it("is delivered once the woken turn's hook hands it over, and records the working observation's time", async () => {
    setup();
    await observe("Stop");
    const message = await send();
    await observe("UserPromptSubmit");
    expect(await status(message.id)).toEqual({ kind: "working", observed_at: clock });
    await collect("claude", SESSION);
    expect((await status(message.id)).kind).toBe("delivered");
  });
});

describe("the CLI", () => {
  beforeEach(() => setup());
  const env = (extra: Record<string, string>) => ({
    MANDIBLE_TOKEN: "fixture", MANDIBLE_NO_KEYCHAIN_TOKEN: "1", MANDIBLE_SESSION_ID: undefined, MANDIBLE_EXECUTION_CONTEXT: undefined,
    CODEX_THREAD_ID: undefined, CODEX_SESSION_ID: undefined, ANTIGRAVITY_CONVERSATION_ID: undefined, CLAUDE_SESSION_ID: undefined,
    CLAUDE_AGENT_ID: undefined, CLAUDE_CODE_SESSION_ID: SESSION, ANTIGRAVITY_LS_ADDRESS: undefined, ANTIGRAVITY_CSRF_TOKEN: undefined,
    CLAUDE_CODE_MESSAGING_SOCKET: CLAUDE_ROUTE.socket, CLAUDE_CODE_MESSAGING_TOKEN: TOKEN, ...extra,
  });
  const reaches: MessageReach[] = [
    { kind: "delivered", at: 1 }, { kind: "working", observed_at: 1 }, { kind: "woken", at: 1 }, { kind: "wake_in_progress", since: 1 },
    { kind: "not_woken", reason: "entry_point_failed", detail: "exited 1" }, { kind: "not_woken", reason: "no_route", detail: null },
    { kind: "ended", observed_at: 1 }, { kind: "unknown" },
  ];
  const message = (reach: MessageReach) => ({ id: "0badc0de-0000", short_id: "0badc0de", sender_agent_ref: null, recipient_agent_ref: MAIN,
    text: "t", sent_at: 1, delivered_at: null, recipient_execution: null, reach });

  it("attaches the session's route without the token on any argument list, and prints every reach", async () => {
    const reach = reaches[0];
    const daemon = await startStubDaemon((request) => request.url.startsWith("/api/messages")
      ? { status: request.method === "POST" ? 201 : 200, body: request.method === "POST" || request.url !== "/api/messages"
        ? { message: message(reach) } : { agent_ref: MAIN, messages: reaches.map(message) } } : undefined);
    const bin = scratchDir("argv-log"), argv = path.join(bin, "argv.log");
    for (const tool of ["curl", "jq"]) {
      const real = (await runCli(["-c", `command -v ${tool}`], { command: "/bin/bash" })).stdout.trim();
      fs.writeFileSync(path.join(bin, tool), `#!/bin/bash\nprintf '%s\\n' "$*" >> '${argv}'\nexec '${real}' "$@"\n`, { mode: 0o755 });
    }
    try {
      const run = (args: string[]) => runCli(args, { env: env({ ...daemon.env, PATH: `${bin}:${process.env.PATH}` }) });
      const outputs = [];
      for (const args of [["message", "send", "--to", MAIN, "-m", "hi"], ["message", "status", "0badc0de"], ["message", "list"]]) {
        const result = await run(args);
        expect(result.status, result.stderr).toBe(0);
        outputs.push(result.stdout);
      }
      expect(outputs[0].trim().split("\n")).toEqual(["0badc0de", expect.stringMatching(/^delivered /)]);
      const listed = outputs[2].trim().split("\n").map((line) => line.split("\t")[3]);
      expect(new Set(listed).size).toBe(reaches.length);
      expect(outputs.join("")).not.toMatch(/null|undefined|jq: error/);

      const headers = daemon.requests.map((request) => request.headers["x-mandible-wake-route"]);
      expect(headers.every((header) => header !== undefined)).toBe(true);
      expect((await router.invoke({ method: "GET", url: "/api/messages", wake_route: JSON.parse(String(headers[0])),
        ambient_identity: { provider: "claude", session_id: SESSION, agent_id: SESSION } })).status).toBe(200);
      expect(routes.get("claude", SESSION)).toEqual(CLAUDE_ROUTE);
      const logged = fs.readFileSync(argv, "utf8");
      expect(logged).toContain(`${daemon.env.MANDIBLE_BASE}/api/messages`);
      expect(logged).not.toContain(TOKEN);
    } finally { await daemon.close(); fs.rmSync(bin, { recursive: true, force: true }); }
  });

  it("carries the route in a file-RPC request", async () => {
    const seen: unknown[] = [];
    const rpc = fileRpc((request) => { seen.push(request); return { status: 200, body: { message: message(reaches[0]) } }; });
    try {
      const result = await runCli(["message", "status", "0badc0de"], { env: env({ ...rpc.env, ANTIGRAVITY_CONVERSATION_ID: "c1",
        CLAUDE_CODE_SESSION_ID: undefined, ANTIGRAVITY_LS_ADDRESS: "127.0.0.1:5123", ANTIGRAVITY_CSRF_TOKEN: TOKEN }) as Record<string, string> });
      expect(result.status, result.stderr).toBe(0);
      expect(seen.map((request) => (request as { wake_route?: unknown }).wake_route))
        .toContainEqual({ provider: "antigravity", address: "127.0.0.1:5123", token: TOKEN });
    } finally { rpc.responder.stop(); }
  });
});
