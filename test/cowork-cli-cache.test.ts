import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { materializeCoworkCliCache } from "../src/cowork-cli-cache.js";

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
    const manifest = materializeCoworkCliCache({ sourceRoot: process.cwd(), targetDir });
    expect(manifest.schema).toBe("mandible-cowork-cli-cache@2");
    expect(manifest.content_digest).toMatch(/^[a-f0-9]{64}$/);
    expect(materializeCoworkCliCache({ sourceRoot: process.cwd(), targetDir }).content_digest)
      .toBe(manifest.content_digest);
    const archive = spawnSync(path.resolve("scripts/bun-runtime.sh"), ["--archive"], { encoding: "utf8", timeout: 30_000 });
    expect(archive.status, archive.stderr).toBe(0);
    const platform = process.arch === "arm64" ? "aarch64" : "x64";
    const asset = `bun-${process.platform}-${platform}.zip`;
    fs.mkdirSync(path.join(targetDir, "runtime/runtime"), { recursive: true });
    fs.copyFileSync(archive.stdout.trim(), path.join(targetDir, "runtime/runtime", asset));
    const result = spawnSync("bash", [path.join(targetDir, "issue.sh"), "report"], {
      encoding: "utf8", env: { ...process.env, MANDIBLE_CLI_DIR: targetDir }, timeout: 15_000,
    });
    expect(result.status, result.stderr).toBe(2);
    expect(result.stderr).toContain("Arguments do not match: mandible issue report");
    expect(result.stderr).not.toContain("Cannot find module");
    const rendered = spawnSync(process.execPath, [path.join(targetDir, "command-syntax.cjs"),
      "render", path.join(targetDir, "instructions-contract.md")], { encoding: "utf8" });
    expect(rendered.status).toBe(0);
    expect(rendered.stdout).not.toContain("{{");
  });

  it("preserves generated file bytes and provenance in the cache manifest", () => {
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
          path: "generated-fixture.md",
          contents: "# Generated fixture\n",
        },
      ],
    });

    expect(fs.readFileSync(path.join(targetDir, "generated-fixture.md"), "utf8")).toBe(
      "# Generated fixture\n",
    );
    expect(manifest.files.map((file) => file.path)).toEqual([
      "api.sh",
      "generated-fixture.md",
    ]);
    expect(manifest.files.at(-1)?.source).toBe("generated:generated-fixture.md");
    expect(JSON.parse(fs.readFileSync(path.join(targetDir, "manifest.json"), "utf8")).files).toHaveLength(2);
    const updated = materializeCoworkCliCache({
      sourceRoot,
      targetDir,
      version: "test-version",
      generatedFiles: [{ path: "generated-fixture.md", contents: "# Updated fixture\n" }],
    });
    expect(updated.content_digest).not.toBe(manifest.content_digest);
  });
});
