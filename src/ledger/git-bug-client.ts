import { spawn } from "node:child_process";

export type GitBugRetryClass = "retryable" | "fatal";

export type GitBugResult<T> =
  | { ok: true; value: T; stdout: string; stderr: string; exit_code: number }
  | {
      ok: false;
      error: string;
      retry: GitBugRetryClass;
      stdout: string;
      stderr: string;
      exit_code: number | null;
    };

export interface GitBugIssueSummary {
  id: string;
  human_id: string;
  title: string;
  status: "open" | "closed";
  labels: string[];
  author_name: string;
  created_at: string;
}

export interface GitBugCommentDetail {
  id: string;
  human_id: string;
  author_name: string;
  body: string;
  created_at: string;
}

export interface GitBugIssueDetail extends GitBugIssueSummary {
  description: string;
  comments: GitBugCommentDetail[];
  raw: unknown;
}

export interface GitBugCreateIssueInput {
  title: string;
  body: string;
  labels?: string[];
}

export interface GitBugClient {
  hasGitBugRefs(repoRoot: string): Promise<GitBugResult<boolean>>;
  listIssues(repoRoot: string): Promise<GitBugResult<GitBugIssueSummary[]>>;
  getIssue(repoRoot: string, ref: string): Promise<GitBugResult<GitBugIssueDetail>>;
  createIssue(repoRoot: string, input: GitBugCreateIssueInput): Promise<GitBugResult<{ id: string }>>;
  setStatus(repoRoot: string, ref: string, status: "open" | "closed"): Promise<GitBugResult<void>>;
  addComment(repoRoot: string, ref: string, body: string): Promise<GitBugResult<{ id?: string }>>;
  addLabel(repoRoot: string, ref: string, label: string): Promise<GitBugResult<void>>;
  removeLabel(repoRoot: string, ref: string, label: string): Promise<GitBugResult<void>>;
}

export interface SubprocessGitBugClientOptions {
  timeoutMs?: number;
}

export class SubprocessGitBugClient implements GitBugClient {
  private readonly timeoutMs: number;

  constructor(options: SubprocessGitBugClientOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? 15_000;
  }

  async hasGitBugRefs(repoRoot: string): Promise<GitBugResult<boolean>> {
    const result = await runCommand("git", ["for-each-ref", "--count=1", "refs/bugs/"], repoRoot, 5_000);
    if (!result.ok) return result;
    return { ...result, value: result.stdout.trim().length > 0 };
  }

  async listIssues(repoRoot: string): Promise<GitBugResult<GitBugIssueSummary[]>> {
    const result = await this.runGitBug(["bug", "--format=json"], repoRoot);
    if (!result.ok) return result;
    return mapJsonResult(result, (value) => asSummaryList(value));
  }

  async getIssue(repoRoot: string, ref: string): Promise<GitBugResult<GitBugIssueDetail>> {
    const result = await this.runGitBug(["bug", "show", ref, "--format=json"], repoRoot);
    if (!result.ok) return result;
    return mapJsonResult(result, (value) => asIssueDetail(value));
  }

  async createIssue(
    repoRoot: string,
    input: GitBugCreateIssueInput,
  ): Promise<GitBugResult<{ id: string }>> {
    const args = ["bug", "new", "-t", input.title, "-m", input.body, "--non-interactive"];
    const result = await this.runGitBug(args, repoRoot);
    if (!result.ok) return result;
    const id = extractCreatedIssueId(result.stdout);
    for (const label of input.labels ?? []) {
      if (id) {
        await this.addLabel(repoRoot, id, label);
      }
    }
    return { ...result, value: { id } };
  }

  async setStatus(
    repoRoot: string,
    ref: string,
    status: "open" | "closed",
  ): Promise<GitBugResult<void>> {
    const verb = status === "closed" ? "close" : "open";
    const result = await this.runGitBug(["bug", "status", verb, ref], repoRoot);
    return mapVoid(result);
  }

  async addComment(repoRoot: string, ref: string, body: string): Promise<GitBugResult<{ id?: string }>> {
    const result = await this.runGitBug(
      ["bug", "comment", "new", ref, "-m", body, "--non-interactive"],
      repoRoot,
    );
    if (!result.ok) return result;
    return { ...result, value: { id: extractCreatedIssueId(result.stdout) || undefined } };
  }

  async addLabel(repoRoot: string, ref: string, label: string): Promise<GitBugResult<void>> {
    return mapVoid(await this.runGitBug(["bug", "label", "new", ref, label], repoRoot));
  }

  async removeLabel(repoRoot: string, ref: string, label: string): Promise<GitBugResult<void>> {
    return mapVoid(await this.runGitBug(["bug", "label", "rm", ref, label], repoRoot));
  }

  private runGitBug(args: string[], repoRoot: string): Promise<GitBugResult<string>> {
    return runCommand("git-bug", args, repoRoot, this.timeoutMs);
  }
}

function runCommand(
  command: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
): Promise<GitBugResult<string>> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (exitCode: number | null, error?: string) => {
      if (settled) return;
      settled = true;
      if (exitCode === 0 && !error) {
        resolve({ ok: true, value: stdout.trimEnd(), stdout: stdout.trimEnd(), stderr, exit_code: 0 });
        return;
      }
      const message = error || stderr.trim() || `${command} exited with ${exitCode}`;
      resolve({
        ok: false,
        error: message,
        retry: classifyGitBugFailure(message),
        stdout,
        stderr,
        exit_code: exitCode,
      });
    };

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(null, `${command} timed out after ${timeoutMs}ms`);
    }, timeoutMs);
    if (typeof timer === "object" && "unref" in timer) {
      timer.unref();
    }

    child.stdout?.on("data", (chunk: Buffer | string) => {
      stdout += chunk.toString();
    });
    child.stderr?.on("data", (chunk: Buffer | string) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      finish(null, error.message);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      finish(code);
    });
  });
}

export function classifyGitBugFailure(message: string): GitBugRetryClass {
  const lower = message.toLowerCase();
  if (lower.includes("lock") || lower.includes("timeout") || lower.includes("timed out")) {
    return "retryable";
  }
  return "fatal";
}

function mapVoid(result: GitBugResult<string>): GitBugResult<void> {
  if (!result.ok) return result;
  return { ...result, value: undefined };
}

function mapJsonResult<T>(
  result: GitBugResult<string>,
  mapper: (value: unknown) => T,
): GitBugResult<T> {
  if (!result.ok) return result;
  const raw = result.value;
  try {
    return { ...result, value: mapper(JSON.parse(raw || "null")) };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      retry: "fatal",
      stdout: result.stdout,
      stderr: result.stderr,
      exit_code: result.exit_code,
    };
  }
}

function asSummaryList(value: unknown): GitBugIssueSummary[] {
  if (!Array.isArray(value)) return [];
  return value.map((entry) => asSummary(entry)).filter((entry): entry is GitBugIssueSummary => !!entry);
}

function asIssueDetail(value: unknown): GitBugIssueDetail {
  const summary = asSummary(value);
  if (!summary) {
    throw new Error("Invalid git-bug issue detail payload");
  }
  const record = asRecord(value);
  const comments = Array.isArray(record.comments) ? record.comments : [];
  const [descriptionComment, ...rest] = comments;
  return {
    ...summary,
    description: asRecord(descriptionComment).message ?? "",
    comments: rest.map((comment) => {
      const item = asRecord(comment);
      return {
        id: String(item.id ?? item.human_id ?? ""),
        human_id: String(item.human_id ?? item.id ?? ""),
        author_name: String(asRecord(item.author).name ?? ""),
        body: String(item.message ?? ""),
        created_at: String(asRecord(item.create_time).time ?? item.time ?? ""),
      };
    }),
    raw: value,
  };
}

function asSummary(value: unknown): GitBugIssueSummary | null {
  const record = asRecord(value);
  const title = typeof record.title === "string" ? record.title : "";
  if (!title) return null;
  return {
    id: String(record.id ?? record.human_id ?? ""),
    human_id: String(record.human_id ?? record.id ?? ""),
    title,
    status: record.status === "closed" ? "closed" : "open",
    labels: Array.isArray(record.labels) ? record.labels.filter((label): label is string => typeof label === "string") : [],
    author_name: String(asRecord(record.author).name ?? asRecord(record.actors?.[0]).name ?? ""),
    created_at: String(asRecord(record.create_time).time ?? ""),
  };
}

function asRecord(value: unknown): Record<string, any> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, any>
    : {};
}

function extractCreatedIssueId(stdout: string): string {
  const match = stdout.match(/[0-9a-f]{7,}|[A-Za-z0-9_-]{6,}/);
  return match?.[0] ?? "";
}
