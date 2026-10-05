import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { materializeCoworkCliCache } from "../../src/cowork-cli-cache.js";

let tempDir = "";

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-cowork-cache-"));
});

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe("Cowork CLI cache materializer", () => {
  it("copies bash CLI scripts and the CLI reference into a cache directory", () => {
    const sourceRoot = path.join(tempDir, "source");
    const targetDir = path.join(tempDir, "cache", "cli");
    fs.mkdirSync(path.join(sourceRoot, "cli"), { recursive: true });
    fs.mkdirSync(path.join(sourceRoot, "docs"), { recursive: true });
    fs.writeFileSync(path.join(sourceRoot, "cli", "api.sh"), "#!/usr/bin/env bash\n", "utf8");
    fs.writeFileSync(path.join(sourceRoot, "cli", "issue.sh"), "#!/usr/bin/env bash\n", "utf8");
    fs.writeFileSync(path.join(sourceRoot, "cli", "README.txt"), "ignored\n", "utf8");
    fs.writeFileSync(path.join(sourceRoot, "docs", "cli-reference.md"), "# CLI\n", "utf8");

    const manifest = materializeCoworkCliCache({ sourceRoot, targetDir, version: "test-version" });

    expect(fs.readFileSync(path.join(targetDir, "api.sh"), "utf8")).toContain("bash");
    expect(fs.readFileSync(path.join(targetDir, "issue.sh"), "utf8")).toContain("bash");
    expect(fs.existsSync(path.join(targetDir, "README.txt"))).toBe(false);
    expect(fs.readFileSync(path.join(targetDir, "docs", "cli-reference.md"), "utf8")).toBe("# CLI\n");
    expect(fs.statSync(path.join(targetDir, "issue.sh")).mode & 0o111).not.toBe(0);
    expect(manifest.version).toBe("test-version");
    expect(manifest.files.map((file) => file.path)).toEqual([
      "api.sh",
      "issue.sh",
      path.join("docs", "cli-reference.md"),
    ]);
    expect(JSON.parse(fs.readFileSync(path.join(targetDir, "manifest.json"), "utf8")).files).toHaveLength(3);
  });

  it("ships command renderer dependencies for cached shell callers", () => {
    const targetDir = path.join(tempDir, "complete-cli");
    materializeCoworkCliCache({ sourceRoot: process.cwd(), targetDir });
    const result = spawnSync("bash", [path.join(targetDir, "issue.sh"), "report"], {
      encoding: "utf8", env: { ...process.env, MANDIBLE_CLI_DIR: targetDir },
    });
    expect(result.status, result.stderr).toBe(2);
    expect(result.stderr).toContain("Arguments do not match: mandible issue report");
    expect(result.stderr).not.toContain("Cannot find module");
    const rendered = spawnSync(process.execPath, [path.join(targetDir, "command-syntax.cjs"),
      "render", path.join(targetDir, "instructions-contract.md")], { encoding: "utf8" });
    expect(rendered.status).toBe(0);
    expect(rendered.stdout).toContain("`mandible issue report <id> [--json]`");
    expect(rendered.stdout).not.toContain("{{");
  });

  it("materializes generated route metadata into the cache manifest", () => {
    const sourceRoot = path.join(tempDir, "source");
    const targetDir = path.join(tempDir, "cache", "cli");
    fs.mkdirSync(path.join(sourceRoot, "cli"), { recursive: true });
    fs.writeFileSync(path.join(sourceRoot, "cli", "api.sh"), "#!/usr/bin/env bash\n", "utf8");

    const manifest = materializeCoworkCliCache({
      sourceRoot,
      targetDir,
      version: "test-version",
      generatedFiles: [
        {
          path: "route-mutation-categories.json",
          contents: "{\"schema\":1,\"routes\":[]}\n",
        },
      ],
    });

    expect(fs.readFileSync(path.join(targetDir, "route-mutation-categories.json"), "utf8")).toBe(
      "{\"schema\":1,\"routes\":[]}\n",
    );
    expect(manifest.files.map((file) => file.path)).toEqual([
      "api.sh",
      "route-mutation-categories.json",
    ]);
    expect(manifest.files.at(-1)?.source).toBe("generated:route-mutation-categories.json");
    expect(JSON.parse(fs.readFileSync(path.join(targetDir, "manifest.json"), "utf8")).files).toHaveLength(2);
  });
});
