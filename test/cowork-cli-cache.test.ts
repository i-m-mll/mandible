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
});
