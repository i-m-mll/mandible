// @vitest-environment node
/**
 * The CLI prints short identities only: a server-allocated display ref when
 * there is one, otherwise a compacted id that keeps its type prefix or family.
 */
import path from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const CLI_DIR = path.join(process.cwd(), "cli");

describe("shared CLI identity formatting", () => {
  it("prefers display refs and compacts ids without changing their type or family", () => {
    const issue = "d59627cf936936136562457704baa511d0b7531dd81892af572444aaeda29d95";
    const version = `artifact-version:${"a".repeat(64)}`;
    const filter = "[(.issue | mandible_display_id), (.version | mandible_typed_short_ref), (.uuid | mandible_short_id), (.work_unit | mandible_short_id)] | @tsv";
    const input = {
      issue: { id: issue, display_id: "d59627c" },
      version,
      uuid: "01949985-117d-499a-9395-ff9e9babc2b0",
      work_unit: "chk_00mt3cmxb4_7d0dca8bb4b19669b9f7",
    };

    const result = spawnSync("bash", ["-c", 'source "$1"; api_jq_human "$2"', "mandible-identity-test", path.join(CLI_DIR, "api.sh"), filter], {
      encoding: "utf8",
      input: `${JSON.stringify(input)}\n`,
      env: { ...process.env, MANDIBLE_CLI_DIR: CLI_DIR },
    });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe(`d59627c\tartifact-version:${"a".repeat(12)}\t01949985\tchk_00mt3cmxb4\n`);
  });
});
