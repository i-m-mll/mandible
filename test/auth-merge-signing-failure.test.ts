import { spawnSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";

const AUTH_MERGE = path.join(process.cwd(), "cli", "auth-merge.sh");

function classify(stderr: string, skKeyInUse = false): boolean {
  const result = spawnSync(
    "bash",
    [
      "-c",
      `
        source "$1"
        signing_stderr=$(cat)
        is_daemon_sk_signing_failure "$signing_stderr" "$2"
      `,
      "auth-merge-test",
      AUTH_MERGE,
      String(skKeyInUse),
    ],
    {
      encoding: "utf8",
      input: stderr,
      env: {
        ...process.env,
        MANDIBLE_AUTH_MERGE_SOURCE_ONLY: "1",
      },
    },
  );
  expect(result.signal).toBeNull();
  return result.status === 0;
}

describe("daemon-context auth merge signing failures", () => {
  it("preserves failed auth state instead of advising unaudited Git continuation", () => {
    const result = spawnSync(
      "bash",
      [
        "-c",
        `
          source "$1"
          signing_key_is_sk() { return 0; }
          report_daemon_sk_signing_failure "error: Couldn't sign message: invalid format?"
        `,
        "auth-merge-test",
        AUTH_MERGE,
      ],
      {
        encoding: "utf8",
        env: { ...process.env, MANDIBLE_AUTH_MERGE_SOURCE_ONLY: "1" },
      },
    );

    expect(result.status).toBe(0);
    expect(result.stderr).toContain("Preserve the current state");
    expect(result.stderr).not.toMatch(/git .*merge --continue|grant Input Monitoring|correct staged content/i);
  });

  it("classifies only the observed security-key signing failures", () => {
    expect(classify("error: Couldn't sign message: incorrect passphrase supplied to decrypt private key?", true)).toBe(true);
    expect(classify(
      "Confirm user presence for key ED25519-SK SHA256:test\nerror: Couldn't sign message: invalid format?",
    )).toBe(true);
    expect(classify("fatal: refusing to merge unrelated histories", true)).toBe(false);
    expect(classify("error: Couldn't sign message: invalid format?")).toBe(false);
  });
});
