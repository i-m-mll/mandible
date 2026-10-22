import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  startFileRpcResponder,
  type FileRpcHandler,
  type FileRpcRequest,
} from "./helpers/file-rpc-responder.js";

const ROOT = process.cwd();
const CLI = path.join(ROOT, "bin", "mandible");
let tempDir = "";
let spoolDir = "";

const occurrence = {
  id: "occ_01",
  task_id: "task_01FULL",
  revision_id: "rev_01",
  occurrence_key: "at:2026-08-15T12:00:00.000Z",
  kind: "inbox_occurrence",
  message: "Review the merge message",
  triggering_evidence: { observed_at: "2026-08-15T12:00:00.000Z" },
  created_by_user_id: "user_01",
  fired_by_user_id: "system_01",
  created_at: 1786795200000,
};

function reminder(options: { lifecycle?: string; predicate?: Record<string, unknown>; occurred?: boolean } = {}) {
  const predicate = options.predicate ?? { kind: "at", at: "2026-08-15T12:00:00.000Z" };
  return {
    id: "task_01FULL",
    project_id: "prj_01FULL",
    project_key: "mandible",
    kind: "mandible-reminder",
    lifecycle: options.lifecycle ?? "armed",
    created_by_user_id: "user_01",
    created_at: 1786747569000,
    updated_at: 1786747569000,
    completed_at: options.occurred ? 1786795200000 : null,
    cancelled_at: options.lifecycle === "cancelled" ? 1786747600000 : null,
    revision: {
      id: "rev_01",
      revision_no: 1,
      schema: "mandible-reminder@1",
      payload_digest: "digest_01",
      payload: {
        schema: "mandible-reminder@1",
        message: "Review the merge message",
        predicate,
        effect: { kind: "inbox_occurrence" },
      },
      created_by_user_id: "user_01",
      created_at: 1786747569000,
    },
    occurrence: options.occurred ? occurrence : null,
  };
}

interface CliResult {
  status: number | null;
  stdout: string;
  stderr: string;
  seen: FileRpcRequest[];
}

function runWithResponder(args: string[], handler: FileRpcHandler): Promise<CliResult> {
  const responder = startFileRpcResponder(spoolDir, handler);
  return new Promise((resolve) => {
    const child = spawn(CLI, args, {
      cwd: ROOT,
      env: {
        ...process.env,
        MANDIBLE_BASE: `file://${spoolDir}`,
        MANDIBLE_FILE_RPC_TIMEOUT: "5",
      },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (status) => {
      responder.stop();
      resolve({ status, stdout, stderr, seen: responder.requests });
    });
  });
}

function runOffline(args: string[]) {
  return spawnSync(CLI, args, {
    cwd: ROOT,
    env: { ...process.env, MANDIBLE_PORT: "9" },
    encoding: "utf8",
  });
}

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-reminder-cli-"));
  spoolDir = path.join(tempDir, "rpc");
});

afterEach(() => fs.rmSync(tempDir, { recursive: true, force: true }));

describe("mandible reminder CLI parser and routing", () => {
  it("documents and dispatches the distinct reminder command without changing task", () => {
    const help = runOffline(["help"]);
    expect(help.status).toBe(0);
    expect(help.stdout).toContain("mandible reminder create");
    expect(help.stdout).toContain("mandible task ");
    const reminderHelp = runOffline(["reminder", "--help"]);
    expect(reminderHelp.status).toBe(0);
    expect(reminderHelp.stdout).toContain("--idempotency-key ");
  });

  it("requires a durable idempotency key and exactly one trigger before transport", () => {
    const base = ["reminder", "create", "--project", "mandible", "--message", "Review"];
    const missingKey = runOffline([...base, "--at", "2026-08-15T12:00:00Z"]);
    expect(missingKey.status).toBe(2);
    expect(missingKey.stderr).toContain("--idempotency-key");
    const twoTriggers = runOffline([
      ...base,
      "--idempotency-key", "review-20",
      "--at", "2026-08-15T12:00:00Z",
      "--issue-closed", "54a7bda",
    ]);
    expect(twoTriggers.status).toBe(2);
    expect(twoTriggers.stderr).toContain("Arguments do not match");
  });

  it("validates count-only options and positive thresholds before transport", () => {
    const invalidCount = runOffline([
      "reminder", "create", "--project", "mandible", "--message", "Review",
      "--idempotency-key", "review-20", "--auth-merge-count-gte", "0",
    ]);
    expect(invalidCount.status).toBe(2);
    expect(invalidCount.stderr).toContain("Invalid value for --auth-merge-count-gte");
    const invalidFilter = runOffline([
      "reminder", "create", "--project", "mandible", "--message", "Review",
      "--idempotency-key", "review-20", "--at", "2026-08-15T12:00:00Z",
      "--base-branch", "develop",
    ]);
    expect(invalidFilter.status).toBe(2);
    expect(invalidFilter.stderr).toContain("Arguments do not match");
  });
});

describe("mandible reminder CLI file-RPC parity", () => {
  it("creates each trigger form with the explicit idempotency key and preserves --json", async () => {
    const cases = [
      {
        args: ["--at", "2026-08-15T12:00:00Z"],
        expected: { kind: "at", at: "2026-08-15T12:00:00Z" },
      },
      {
        args: ["--issue-closed", "54a7bda"],
        expected: { kind: "issue_closed", issue: "54a7bda" },
      },
      {
        args: ["--auth-merge-count-gte", "20", "--base-branch", "develop", "--canonical-message", "true"],
        expected: {
          kind: "auth_merge_count_gte",
          project: "mandible",
          threshold: 20,
          base_branch: "develop",
          canonical_message: true,
        },
      },
    ];
    for (const [index, testCase] of cases.entries()) {
      const result = await runWithResponder(
        [
          "reminder", "create", "--project", "mandible", "--message", "Review the merge message",
          "--idempotency-key", `review-${index}`, ...testCase.args, "--json",
        ],
        (request) => {
          expect(request.method).toBe("POST");
          expect(request.path).toBe("/api/reminders");
          expect(request.body).toMatchObject({
            schema: "mandible-reminder@1",
            idempotency_key: `review-${index}`,
            project: "mandible",
            message: "Review the merge message",
            predicate: testCase.expected,
          });
          return { status: 201, body: { reminder: reminder(), stored: true, fired_immediately: false } };
        },
      );
      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({ stored: true, fired_immediately: false });
      expect(result.seen).toHaveLength(1);
    }
  });

  it("shows stable identity, lifecycle, predicate, project, immediate firing, and occurrence", async () => {
    const fired = reminder({ lifecycle: "completed", occurred: true });
    const create = await runWithResponder(
      [
        "reminder", "create", "--project", "mandible", "--message", "Review the merge message",
        "--idempotency-key", "review-now", "--at", "2026-08-15T12:00:00Z",
      ],
      () => ({ status: 201, body: { reminder: fired, stored: true, fired_immediately: true } }),
    );
    expect(create.stdout).toContain("Reminder task_01FULL");
    expect(create.stdout).toContain("project: mandible (prj_01FULL)");
    expect(create.stdout).toContain("lifecycle: completed");
    expect(create.stdout).toContain("predicate: at 2026-08-15T12:00:00.000Z");
    expect(create.stdout).toContain("fired_immediately: true");
    expect(create.stdout).toContain("occurrence: occ_01");
    expect(create.stdout).toContain("observed_at");

    const show = await runWithResponder(
      ["reminder", "show", "task_01", "--json"],
      (request) => {
        expect(request.method).toBe("GET");
        expect(request.path).toBe("/api/reminders/task_01");
        return { status: 200, body: { reminder: fired } };
      },
    );
    expect(JSON.parse(show.stdout)).toEqual({ reminder: fired });
  });

  it("lists with project/lifecycle filters and cancels by stable reminder ref", async () => {
    const listed = await runWithResponder(
      ["reminder", "list", "--project", "mandible", "--lifecycle", "armed"],
      (request) => {
        expect(request.method).toBe("GET");
        expect(request.path).toBe("/api/reminders?project=mandible&lifecycle=armed");
        return { status: 200, body: { reminders: [reminder()] } };
      },
    );
    expect(listed.stdout).toContain("task_01FULL\tarmed\tmandible\tat\t-");

    const cancelledReminder = reminder({ lifecycle: "cancelled" });
    const cancelled = await runWithResponder(
      ["reminder", "cancel", "task_01"],
      (request) => {
        expect(request.method).toBe("POST");
        expect(request.path).toBe("/api/reminders/task_01/cancel");
        return { status: 200, body: { reminder: cancelledReminder } };
      },
    );
    expect(cancelled.status).toBe(0);
    expect(cancelled.stdout).toContain("lifecycle: cancelled");
  });

  it("keeps identity, project-admission, and idempotency conflicts visible", async () => {
    for (const failure of [
      { status: 401, code: "authentication_required", error: "Authentication required" },
      { status: 403, code: "project_permission_required", error: "Project write access required" },
      { status: 409, code: "idempotency_conflict", error: "Idempotency key was reused with different bytes" },
    ]) {
      const result = await runWithResponder(
        [
          "reminder", "create", "--project", "mandible", "--message", "Review",
          "--idempotency-key", "review-20", "--issue-closed", "54a7bda",
        ],
        () => ({ status: failure.status, body: { code: failure.code, error: failure.error } }),
      );
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain(failure.code);
      expect(result.stderr).toContain(failure.error);
    }
  });
});

describe("mandible reminder CLI HTTP transport", () => {
  it("uses the shared HTTP helper and preserves a show response", () => {
    const binDir = path.join(tempDir, "bin");
    fs.mkdirSync(binDir);
    const responsePath = path.join(tempDir, "response.json");
    const curlLog = path.join(tempDir, "curl.log");
    fs.writeFileSync(responsePath, JSON.stringify({ reminder: reminder() }));
    fs.writeFileSync(path.join(binDir, "curl"), `#!/usr/bin/env bash
out=""
url=""
while (($#)); do
  case "$1" in
    -o) out="$2"; shift 2 ;;
    -w|--max-time|-X|-H|--data-binary) shift 2 ;;
    http*) url="$1"; shift ;;
    *) shift ;;
  esac
done
printf '%s' "$url" > "${curlLog}"
cp "${responsePath}" "$out"
printf '200'
`, { mode: 0o700 });
    const result = spawnSync(CLI, ["reminder", "show", "task_01", "--json"], {
      cwd: ROOT,
      env: {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH}`,
        MANDIBLE_BASE: "http://mandible.invalid",
        MANDIBLE_HTTP_RETRIES: "0",
      },
      encoding: "utf8",
    });
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ reminder: reminder() });
    expect(fs.readFileSync(curlLog, "utf8")).toContain("/api/reminders/task_01");
  });
});
