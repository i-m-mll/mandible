import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const SCRIPT = path.join(process.cwd(), "cli", "auth-clearance.sh");

describe("auth clearance CLI", () => {
  it("sends prospective exact scope without requiring a request id", () => {
    const helperDir = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-clearance-cli-"));
    try {
      fs.writeFileSync(path.join(helperDir, "api.sh"), `
api_send() {
  jq -n --arg method "$1" --arg route "$2" --argjson payload "$3" \
    '{method:$method,route:$route,payload:$payload}'
}
api_get() { jq -n --arg route "$1" '{route:$route}'; }
`);
      const result = spawnSync("bash", [
        SCRIPT, "create", "--grantee", "agent-a", "--project", "mandible",
        "--base", "develop", "--issue", "de690d2", "--head", "feature/exact",
        "--duration-minutes", "30", "--max-uses", "2", "--json",
      ], {
        cwd: process.cwd(),
        env: { ...process.env, MANDIBLE_CLI_DIR: helperDir },
        encoding: "utf8",
      });
      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({
        method: "POST",
        route: "/api/auth/clearances",
        payload: {
          grantee: "agent-a",
          action: "merge",
          project: "mandible",
          base: "develop",
          issue: "de690d2",
          head: "feature/exact",
          duration_minutes: 30,
          max_uses: 2,
        },
      });
    } finally {
      fs.rmSync(helperDir, { recursive: true, force: true });
    }
  });
});
