import path from "node:path";
import { describe, expect, it } from "vitest";
import type { Db } from "../src/db.js";
import {
  buildGitFetchArgs,
  buildGitReadTransportPlan,
  gitReadTransportRepoSettingKey,
  parseGitReadTransportPolicy,
  readGitReadTransportPolicy,
  toHttpsReadUrl,
} from "../src/git-read-transport.js";

describe("git read transport", () => {
  it("converts SSH GitHub remotes to HTTPS read URLs", () => {
    expect(toHttpsReadUrl("git@github.com:i-m-mll/mandible.git")).toBe(
      "https://github.com/i-m-mll/mandible.git",
    );
    expect(toHttpsReadUrl("ssh://git@github.com/i-m-mll/mandible.git")).toBe(
      "https://github.com/i-m-mll/mandible.git",
    );
    expect(toHttpsReadUrl("https://github.com/i-m-mll/mandible.git")).toBe(
      "https://github.com/i-m-mll/mandible.git",
    );
  });

  it("uses synthesized HTTPS fetches without changing push transport", () => {
    const plan = buildGitReadTransportPlan({
      policy: "https-reads",
      remoteUrl: "git@github.com:i-m-mll/mandible.git",
      pushUrl: "git@github.com:i-m-mll/mandible.git",
    });

    expect(plan.readRemote).toBe("https://github.com/i-m-mll/mandible.git");
    expect(plan.pushUrl).toBe("git@github.com:i-m-mll/mandible.git");
    expect(plan.usesSyntheticReadUrl).toBe(true);
    expect(plan.networkReadsDisabled).toBe(false);
    expect(plan.gitConfigMutations).toEqual([]);
  });

  it("leaves repo-default fetches on the configured remote name", () => {
    expect(buildGitFetchArgs({
      policy: "repo-default",
      remoteUrl: "git@github.com:i-m-mll/mandible.git",
      branch: "main",
    })).toEqual(["fetch", "origin", "main"]);
  });

  it("builds URL refspec fetches for HTTPS read policy", () => {
    expect(buildGitFetchArgs({
      policy: "https-reads",
      remoteUrl: "git@github.com:i-m-mll/mandible.git",
      branch: "main",
    })).toEqual([
      "fetch",
      "https://github.com/i-m-mll/mandible.git",
      "main:refs/remotes/origin/main",
    ]);
  });

  it("can disable network reads", () => {
    expect(buildGitFetchArgs({
      policy: "disabled",
      remoteUrl: "git@github.com:i-m-mll/mandible.git",
      branch: "main",
    })).toBeNull();
  });

  it("reads per-repo policy before the global default", () => {
    const repoRoot = path.join("/tmp", "mandible");
    const rows = new Map<string, string>([
      ["git.read_transport.default", "repo-default"],
      [gitReadTransportRepoSettingKey(repoRoot), "https-reads"],
    ]);
    const db = {
      prepare: () => ({
        get: (key: string) => {
          const value = rows.get(key);
          return value ? { value } : undefined;
        },
      }),
    } as unknown as Db;

    expect(readGitReadTransportPolicy(db, repoRoot)).toBe("https-reads");
    expect(readGitReadTransportPolicy(db, path.join("/tmp", "other"))).toBe("repo-default");
  });

  it("falls back on invalid policy values", () => {
    expect(parseGitReadTransportPolicy("ftp")).toBe("repo-default");
    expect(parseGitReadTransportPolicy("ftp", "disabled")).toBe("disabled");
  });
});
