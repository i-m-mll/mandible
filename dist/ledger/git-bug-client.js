import { spawn } from "node:child_process";
export class SubprocessGitBugClient {
    timeoutMs;
    constructor(options = {}) {
        this.timeoutMs = options.timeoutMs ?? 15_000;
    }
    async hasGitBugRefs(repoRoot) {
        const result = await runCommand("git", ["for-each-ref", "--count=1", "refs/bugs/"], repoRoot, 5_000);
        if (!result.ok)
            return result;
        return { ...result, value: result.stdout.trim().length > 0 };
    }
    async listIssues(repoRoot) {
        const result = await this.runGitBug(["bug", "--format=json"], repoRoot);
        if (!result.ok)
            return result;
        return mapJsonResult(result, (value) => asSummaryList(value));
    }
    async getIssue(repoRoot, ref) {
        const result = await this.runGitBug(["bug", "show", ref, "--format=json"], repoRoot);
        if (!result.ok)
            return result;
        return mapJsonResult(result, (value) => asIssueDetail(value));
    }
    async createIssue(repoRoot, input) {
        const args = ["bug", "new", "-t", input.title, "-m", input.body, "--non-interactive"];
        const result = await this.runGitBug(args, repoRoot);
        if (!result.ok)
            return result;
        const id = extractCreatedIssueId(result.stdout);
        for (const label of input.labels ?? []) {
            if (id) {
                await this.addLabel(repoRoot, id, label);
            }
        }
        return { ...result, value: { id } };
    }
    async editTitle(repoRoot, ref, title) {
        const result = await this.runGitBug(["bug", "title", "edit", ref, "-t", title, "--non-interactive"], repoRoot);
        return mapVoid(result);
    }
    async editComment(repoRoot, commentId, body) {
        const result = await this.runGitBug(["bug", "comment", "edit", commentId, "-m", body, "--non-interactive"], repoRoot);
        return mapVoid(result);
    }
    async setStatus(repoRoot, ref, status) {
        const verb = status === "closed" ? "close" : "open";
        const result = await this.runGitBug(["bug", "status", verb, ref], repoRoot);
        return mapVoid(result);
    }
    async addComment(repoRoot, ref, body) {
        const result = await this.runGitBug(["bug", "comment", "new", ref, "-m", body, "--non-interactive"], repoRoot);
        if (!result.ok)
            return result;
        return { ...result, value: { id: extractCreatedIssueId(result.stdout) || undefined } };
    }
    async addLabel(repoRoot, ref, label) {
        return mapVoid(await this.runGitBug(["bug", "label", "new", ref, label], repoRoot));
    }
    async removeLabel(repoRoot, ref, label) {
        return mapVoid(await this.runGitBug(["bug", "label", "rm", ref, label], repoRoot));
    }
    runGitBug(args, repoRoot) {
        return runCommand("git-bug", args, repoRoot, this.timeoutMs);
    }
}
function runCommand(command, args, cwd, timeoutMs) {
    return new Promise((resolve) => {
        const child = spawn(command, args, {
            cwd,
            env: process.env,
            stdio: ["ignore", "pipe", "pipe"],
        });
        let stdout = "";
        let stderr = "";
        let settled = false;
        const finish = (exitCode, error) => {
            if (settled)
                return;
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
        child.stdout?.on("data", (chunk) => {
            stdout += chunk.toString();
        });
        child.stderr?.on("data", (chunk) => {
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
export function classifyGitBugFailure(message) {
    const lower = message.toLowerCase();
    if (lower.includes("lock") || lower.includes("timeout") || lower.includes("timed out")) {
        return "retryable";
    }
    return "fatal";
}
function mapVoid(result) {
    if (!result.ok)
        return result;
    return { ...result, value: undefined };
}
function mapJsonResult(result, mapper) {
    if (!result.ok)
        return result;
    const raw = result.value;
    try {
        return { ...result, value: mapper(JSON.parse(raw || "null")) };
    }
    catch (error) {
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
function asSummaryList(value) {
    if (!Array.isArray(value))
        return [];
    return value.map((entry) => asSummary(entry)).filter((entry) => !!entry);
}
function asIssueDetail(value) {
    const summary = asSummary(value);
    if (!summary) {
        throw new Error("Invalid git-bug issue detail payload");
    }
    const record = asRecord(value);
    const comments = Array.isArray(record.comments) ? record.comments : [];
    const [descriptionComment, ...rest] = comments;
    const description = asRecord(descriptionComment);
    return {
        ...summary,
        description: description.message ?? "",
        description_comment_id: String(description.human_id ?? description.id ?? ""),
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
function asSummary(value) {
    const record = asRecord(value);
    const title = typeof record.title === "string" ? record.title : "";
    if (!title)
        return null;
    return {
        id: String(record.id ?? record.human_id ?? ""),
        human_id: String(record.human_id ?? record.id ?? ""),
        title,
        status: record.status === "closed" ? "closed" : "open",
        labels: Array.isArray(record.labels) ? record.labels.filter((label) => typeof label === "string") : [],
        author_name: String(asRecord(record.author).name ?? asRecord(record.actors?.[0]).name ?? ""),
        created_at: String(asRecord(record.create_time).time ?? ""),
    };
}
function asRecord(value) {
    return value && typeof value === "object" && !Array.isArray(value)
        ? value
        : {};
}
function extractCreatedIssueId(stdout) {
    const match = stdout.match(/[0-9a-f]{7,}|[A-Za-z0-9_-]{6,}/);
    return match?.[0] ?? "";
}
