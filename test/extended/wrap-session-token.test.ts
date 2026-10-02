// The wrapper passes managed task markers through without projecting a bearer.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const CLI_DIR = path.join(process.cwd(), "cli");
const WRAP = path.join(CLI_DIR, "wrap.sh");

function runWrap(base?: string) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-wrap-local-"));
  try {
    const command = `source "$MANDIBLE_CLI_DIR/api.sh"; printf '%s|%s|%s|%s|%s|%s' "\${MANDIBLE_BASE-unset}" "$MANDIBLE_LOCAL_SOCKET" "\${MANDIBLE_TOKEN-unset}" "$MANDIBLE_MANAGED_CLIENT" "\${CODEX_THREAD_ID-unset}" "$MANDIBLE_MANAGED_APP"`;
    const env = { ...process.env, HOME: root, MANDIBLE_CLI_DIR: CLI_DIR,
      MANDIBLE_TOKEN: "stale-inherited-token", CODEX_THREAD_ID: "task-123",
      CLAUDE_CODE_SESSION_ID: "", CLAUDE_SESSION_ID: "", GEMINI_SESSION_ID: "",
    };
    if (base === undefined) delete env.MANDIBLE_BASE;
    else env.MANDIBLE_BASE = base;
    return spawnSync("bash", [WRAP, "--app", "codex", "--id", "wrapper-session", "--", "bash", "-c", command], {
      env, encoding: "utf8",
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

describe("cli/wrap.sh local identity", () => {
  it("keeps the private socket default across child exec without a bearer", () => {
    const result = runWrap();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe("unset|1|unset|1|unset|codex");
  });

  it("keeps inherited canonical base on the private socket across child exec", () => {
    const result = runWrap("https://app.mandible.localhost:19420");
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe("https://app.mandible.localhost:19420|1|unset|1|unset|codex");
  });

  it("keeps explicit noncanonical HTTP selected without exporting a bearer", () => {
    const result = runWrap("http://127.0.0.1:31337");
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe("http://127.0.0.1:31337|0|unset|1|unset|codex");
  });
});
