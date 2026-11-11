import fs from "node:fs";
import { localApiSocketPath } from "../local-api-socket.js";

// `mandible hook notices <claude|codex>` on UserPromptSubmit: print the
// settlement notices owed to this session, then confirm them. Exit 2 would
// block the prompt, so every failure is exit 1. The route paths are those of
// NOTICE_ROUTES; importing the contract would load zod on every prompt.

function fail(message: string): never {
  process.stderr.write(`Mandible notices hook: ${message}\n`);
  process.exit(1);
}

const provider = process.argv[2];
if (provider !== "claude" && provider !== "codex") fail("expected claude or codex.");

let payload: Record<string, unknown>;
try { payload = JSON.parse(fs.readFileSync(0, "utf8")); }
catch { fail("invalid payload."); }
const sessionId = payload?.session_id;
if (typeof sessionId !== "string" || !sessionId) fail("invalid payload.");
// A subagent thread's prompt: its notices go to the session's main thread.
if (typeof payload.agent_id === "string" && payload.agent_id && payload.agent_id !== sessionId) process.exit(0);

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

let notices: Array<{ id: string; text: string }>;
try { ({ notices } = await post("/api/notices/collect", { provider, session_id: sessionId }) as { notices: typeof notices }); }
catch (error) { fail(`daemon unreachable: ${error instanceof Error ? error.message : String(error)}`); }
if (notices.length === 0) process.exit(0);
fs.writeSync(1, `${notices.map((notice) => notice.text).join("\n")}\n`);
// Printed but unconfirmed is printed again at the next prompt, so this exits 0.
try { await post("/api/notices/delivered", { ids: notices.map((notice) => notice.id) }); }
catch (error) { process.stderr.write(`Mandible notices hook: delivery not confirmed: ${error instanceof Error ? error.message : String(error)}\n`); }
