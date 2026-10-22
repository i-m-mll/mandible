import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const child = spawn("bash", [fileURLToPath(new URL("./session-execution.sh", import.meta.url)), "--within-deadline", ...process.argv.slice(2)], {
  stdio: "inherit", detached: true,
});
let expired = false;
function signalGroup(signal) {
  if (!child.pid) return;
  try { process.kill(-child.pid, signal); }
  catch (error) { if (error.code !== "ESRCH") throw error; }
}
const deadline = setTimeout(() => {
  expired = true;
  process.stderr.write("Mandible execution hook: total observation deadline exceeded.\n");
  signalGroup("SIGTERM");
  // Give the API client's traps time to clean up, then end any remaining
  // descendants even if the shell has already handled TERM and exited.
  setTimeout(() => signalGroup("SIGKILL"), 100);
}, 2400);
child.on("error", (error) => {
  clearTimeout(deadline);
  process.stderr.write(`Mandible execution hook: ${error.message}\n`);
  process.exitCode = 1;
});
child.on("close", (code) => {
  clearTimeout(deadline);
  process.exitCode = expired ? 124 : code ?? 1;
});
