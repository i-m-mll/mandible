import fs from "node:fs";
import { localApiSocketPath } from "../local-api-socket.js";
import { executionOutboxDir, projectExecutionEnvelope, writeExecutionOutboxEntry } from "../session-execution-outbox.js";

function fail(message: string): never {
  process.stderr.write(`Mandible execution hook: ${message}\n`);
  process.exit(1);
}

const provider = process.argv[2];
if (provider !== "claude" && provider !== "codex") fail("expected claude or codex.");

const observedAt = Date.now();
let payload: unknown;
try { payload = JSON.parse(fs.readFileSync(0, "utf8")); }
catch { fail("invalid payload."); }
const envelope = projectExecutionEnvelope(provider, payload);
if (!envelope) fail("invalid payload.");

// A managed controller observes its own provider session; a nested provider
// has its own payload identity even with inherited markers. A fresh
// app-server learns its native id after spawn and publishes the binding
// atomically, scoped to the owning controller instance.
const controller = process.env.MANDIBLE_EXECUTION_OBSERVER_ID;
if (controller) {
  let observed = process.env.MANDIBLE_EXECUTION_OBSERVER_SESSION_ID ?? "";
  const bindingFile = process.env.MANDIBLE_EXECUTION_OBSERVER_SESSION_FILE;
  if (bindingFile) {
    observed = "";
    if (fs.existsSync(bindingFile)) {
      try {
        const binding = JSON.parse(fs.readFileSync(bindingFile, "utf8")) as Record<string, unknown>;
        if (binding.controller_instance_id === controller && typeof binding.provider_session_id === "string") observed = binding.provider_session_id;
      } catch { fail("invalid observer binding."); }
    }
  }
  if (observed === envelope.session_id) process.exit(0);
}

try {
  const socket = localApiSocketPath({ role: "main", instance_id: "" });
  writeExecutionOutboxEntry(executionOutboxDir(socket), { observed_at: observedAt, envelope });
} catch (error) {
  fail(`could not queue the observation: ${error instanceof Error ? error.message : String(error)}`);
}
