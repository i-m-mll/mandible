import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { isAbsolute } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type ProviderSessionProcessQuery = {
  provider_session_id: string;
  transcript_path: string | null;
};

/** One OS process snapshot answering whether any process still drives a provider session. */
export type ProviderSessionProcessEvidence =
  | { kind: "absent" }
  | { kind: "present"; pid: number };

/**
 * Throws when the process table cannot be read: an unreadable snapshot is never
 * evidence that a provider process is gone.
 */
export type ProviderSessionProcessProbe = (
  queries: readonly ProviderSessionProcessQuery[],
) => Promise<Map<string, ProviderSessionProcessEvidence>>;

/**
 * A provider process is bound to its session either by its launch argv
 * (Claude starts with `--session-id=<id>` or `--resume=<id>`; the Codex CLI
 * resumes with `resume <id>`) or by holding the session transcript open (a
 * Codex app-server keeps a loaded thread's rollout file open). Either evidence
 * means the session is still driven. A bare mention of the id, such as a
 * command that reads the transcript, is not.
 */
export const probeProviderSessionProcesses: ProviderSessionProcessProbe = async (queries) => {
  const evidence = new Map<string, ProviderSessionProcessEvidence>();
  if (queries.length === 0) return evidence;

  const ps = await execFileAsync("ps", ["-axww", "-o", "pid=,args="], {
    encoding: "utf8", timeout: 5_000, killSignal: "SIGKILL", maxBuffer: 32 * 1024 * 1024,
  });
  const processes: Array<{ pid: number; args: string }> = [];
  for (const line of ps.stdout.split("\n")) {
    const match = line.match(/^\s*(\d+)\s+(.*)$/);
    if (!match) continue;
    const pid = Number.parseInt(match[1], 10);
    if (pid !== process.pid) processes.push({ pid, args: match[2] });
  }
  if (processes.length === 0) throw new Error("The process table snapshot was empty");

  const transcripts = [...new Set(queries
    .map((query) => query.transcript_path)
    .filter((path): path is string => Boolean(path && isAbsolute(path) && existsSync(path))))];
  const holders = await transcriptHolders(transcripts);

  for (const query of queries) {
    const launch = sessionLaunchPattern(query.provider_session_id);
    const byArgv = processes.find((candidate) => launch.test(candidate.args));
    const byTranscript = query.transcript_path ? holders.get(query.transcript_path) : undefined;
    const pid = byArgv?.pid ?? byTranscript;
    evidence.set(query.provider_session_id, pid === undefined ? { kind: "absent" } : { kind: "present", pid });
  }
  return evidence;
};

function sessionLaunchPattern(providerSessionId: string): RegExp {
  const id = providerSessionId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:^|\\s)(?:--resume|--session-id|-r|resume)(?:=|\\s+)${id}(?:\\s|$)`);
}

async function transcriptHolders(paths: readonly string[]): Promise<Map<string, number>> {
  const holders = new Map<string, number>();
  if (paths.length === 0) return holders;
  let output: string;
  try {
    output = (await execFileAsync("/usr/sbin/lsof", ["-w", "-Fpn", "--", ...paths], {
      encoding: "utf8", timeout: 10_000, killSignal: "SIGKILL", maxBuffer: 16 * 1024 * 1024,
    })).stdout;
  } catch (error) {
    // lsof exits 1 with no diagnostics when no process holds any listed file.
    const failure = error as { code?: string | number; killed?: boolean; signal?: string; stdout?: string; stderr?: string };
    if (failure.code !== 1 || failure.killed || failure.signal || failure.stderr?.trim()) throw error;
    output = failure.stdout ?? "";
  }
  let pid: number | null = null;
  for (const line of output.split("\n")) {
    if (line.startsWith("p")) pid = Number.parseInt(line.slice(1), 10);
    else if (line.startsWith("n") && pid !== null && pid !== process.pid && !holders.has(line.slice(1))) {
      holders.set(line.slice(1), pid);
    }
  }
  return holders;
}
