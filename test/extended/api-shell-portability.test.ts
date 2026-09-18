import path from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const API_HELPER = path.join(process.cwd(), "cli", "api.sh");

describe("sourced API shell portability", () => {
  for (const shell of ["bash", "zsh"]) {
    it(`matches generated route templates under ${shell}`, () => {
      const script = [
        `source ${JSON.stringify(API_HELPER)}`,
        'api_route_template_matches "/api/artifacts/bundles/:id/members" "/api/artifacts/bundles/bundle-1/members"',
        '! api_route_template_matches "/api/artifacts/bundles/:id/members" "/api/artifacts/bundles//members"',
        '! api_route_template_matches "/api/artifacts/:id" "/api/artifacts/one/extra"',
      ].join("\n");
      const result = spawnSync(shell, ["-c", script], { encoding: "utf8" });

      expect(result.status, result.stderr).toBe(0);
      expect(result.stderr).toBe("");
    });
  }
});
