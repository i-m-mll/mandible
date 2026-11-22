import fs from "node:fs";
import { localApiSocketPath } from "../local-api-socket.js";
import { encodeHookOutput, HOOK_ADAPTERS, refusesStop, type HookProvider } from "../parsers/hook-adapters.js";

// `mandible hook notices <provider>`: print what Mandible owes this agent in
// the form the provider's event takes, then confirm it. A blocking exit code
// would refuse the prompt or tool call, so every failure is exit 1. The route
// paths are those of NOTICE_ROUTES; importing the contract would load zod.

function fail(message: string): never {
  process.stderr.write(`Mandible notices hook: ${message}\n`);
  process.exit(1);
}

const provider = process.argv[2];
if (!Object.hasOwn(HOOK_ADAPTERS, provider ?? "")) fail(`expected one of ${Object.keys(HOOK_ADAPTERS).join(", ")}.`);
const adapter = HOOK_ADAPTERS[provider as HookProvider];

let payload: Record<string, unknown>;
try { payload = JSON.parse(fs.readFileSync(0, "utf8")); }
catch { fail("invalid payload."); }
if (typeof payload !== "object" || payload === null) fail("invalid payload.");
const event = payload[adapter.event_field];
const encoding = typeof event === "string" && Object.hasOwn(adapter.events, event) ? adapter.events[event as keyof typeof adapter.events] : undefined;
if (!encoding) fail(`${provider} event ${JSON.stringify(event)} is not one this hook handles.`);
// Refuse the end of a turn at most once: a refusal whose confirmation was lost
// would otherwise refuse again for the same rows.
if (refusesStop(encoding) && adapter.continuing(payload)) process.exit(0);
const sessionId = payload[adapter.session_field];
if (typeof sessionId !== "string" || !sessionId) fail("invalid payload.");
const agentId = adapter.agent_field ? payload[adapter.agent_field] : undefined;

const socket = localApiSocketPath({ role: "main", instance_id: "" });

async function post(path: string, body: unknown): Promise<unknown> {
  // Bun's fetch speaks HTTP over a unix socket.
  const response = await fetch(`http://localhost${path}`, {
    unix: socket, method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify(body), signal: AbortSignal.timeout(900),
  } as RequestInit);
  if (!response.ok) throw new Error(`${path} answered ${response.status}`);
  return response.json();
}

const reason = (error: unknown) => error instanceof Error ? error.message : String(error);
let notices: Array<{ id: string; text: string }>;
try {
  ({ notices } = await post("/api/notices/collect", {
    provider, session_id: sessionId, ...(typeof agentId === "string" && agentId ? { agent_id: agentId } : {}),
  }) as { notices: typeof notices });
}
catch (error) { fail(`daemon unreachable: ${reason(error)}`); }
if (notices.length === 0) process.exit(0);
fs.writeSync(1, encodeHookOutput(encoding, event as string, notices.map((notice) => notice.text).join("\n")));
// Unconfirmed rows stay owed; the providers discard a failed hook's output.
try { await post("/api/notices/delivered", { ids: notices.map((notice) => notice.id) }); }
catch (error) { fail(`delivery not confirmed: ${reason(error)}`); }
