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
    expect(result.stderr).toContain("arranging audited recovery");
    expect(result.stderr).toContain("fresh reviewed Mandible request");
    expect(result.stderr).toContain("cause is not established");
    expect(result.stderr).not.toMatch(/git .*merge --continue|grant Input Monitoring|correct staged content/i);
  });

  it("classifies the observed incorrect-passphrase signature with an SK key", () => {
    expect(
      classify(
        "error: Couldn't sign message: incorrect passphrase supplied to decrypt private key?",
        true,
      ),
    ).toBe(true);
  });

  it("classifies the observed invalid-format signature with a presence prompt", () => {
    expect(
      classify(
        "Confirm user presence for key ED25519-SK SHA256:test\n" +
          "error: Couldn't sign message: invalid format?",
      ),
    ).toBe(true);
  });

  it("passes unrelated failures through without classifying them", () => {
    expect(classify("fatal: refusing to merge unrelated histories", true)).toBe(false);
    expect(classify("error: Couldn't sign message: invalid format?")).toBe(false);
  });

  it("streams unrelated Git stderr unchanged", () => {
    const stderr = "fatal: refusing to merge unrelated histories\n";
    const result = spawnSync(
      "bash",
      [
        "-c",
        `
          source "$1"
          git() {
            printf '%s' "$MANDIBLE_TEST_GIT_STDERR" >&2
            return 17
          }
          run_signing_git merge && exit 99
          report_daemon_sk_signing_failure "$AUTH_MERGE_LAST_GIT_STDERR" || true
        `,
        "auth-merge-test",
        AUTH_MERGE,
      ],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          MANDIBLE_CLI_DIR: path.dirname(AUTH_MERGE),
          MANDIBLE_AUTH_MERGE_SOURCE_ONLY: "1",
          MANDIBLE_TEST_GIT_STDERR: stderr,
        },
      },
    );

    expect(result.status).toBe(0);
    expect(result.stderr).toBe(stderr);
  });
});
