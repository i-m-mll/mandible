import path from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const CLI_DIR = path.join(process.cwd(), "cli");
const API = path.join(CLI_DIR, "api.sh");

function render(shell: "bash" | "zsh", filter: string, input: unknown) {
  const script = `source "$1"; api_jq_human "$2"`;
  return spawnSync(shell, ["-c", script, "mandible-identity-test", API, filter], {
    encoding: "utf8",
    input: `${JSON.stringify(input)}\n`,
    env: { ...process.env, MANDIBLE_CLI_DIR: CLI_DIR },
  });
}

describe("shared CLI identity formatting", () => {
  it.each(["bash", "zsh"] as const)("prefers server-allocated display refs under %s", (shell) => {
    const canonical = "d59627cf936936136562457704baa511d0b7531dd81892af572444aaeda29d95";
    const result = render(shell, "mandible_display_id", { id: canonical, display_id: "d59627c" });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe("d59627c\n");
    expect(result.stdout).not.toContain(canonical);
  });

  it("keeps typed semantics while compacting only the identity payload", () => {
    const canonical = `artifact-version:${"a".repeat(64)}`;
    const result = render("bash", "mandible_typed_short_ref", canonical);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe(`artifact-version:${"a".repeat(12)}\n`);
    expect(result.stdout).not.toContain(canonical);
  });

  it("compacts UUID and prefixed operational identities without changing their family", () => {
    const result = render(
      "bash",
      "[.uuid, .work_unit] | map(mandible_short_id) | @tsv",
      {
        uuid: "01949985-117d-499a-9395-ff9e9babc2b0",
        work_unit: "chk_00mt3cmxb4_7d0dca8bb4b19669b9f7",
      },
    );

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe("01949985\tchk_00mt3cmxb4\n");
  });
});
