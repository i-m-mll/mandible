import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("desktop bootstrap build", () => {
  it("keeps desktop bootstrap assets separate from the daemon dist entrypoint", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-desktop-bootstrap-"));
    tempRoots.push(root);
    fs.mkdirSync(path.join(root, "scripts"), { recursive: true });
    fs.mkdirSync(path.join(root, "src-tauri", "bootstrap"), { recursive: true });
    fs.mkdirSync(path.join(root, "dist"), { recursive: true });
    fs.copyFileSync(path.join(process.cwd(), "scripts", "make-dist.sh"), path.join(root, "scripts", "make-dist.sh"));
    // This test isolates the bootstrap copy step; origin generation has its
    // own checks and must not make the temporary fixture imitate the whole repo.
    fs.writeFileSync(path.join(root, "scripts", "generate-canonical-origin.mjs"), "process.exit(0);\n");
    fs.writeFileSync(path.join(root, 'scripts', 'prepare-desktop-runtime.mjs'), 'process.exit(0);\n');
    const trustHelper = path.join(root, "scripts", "build-local-ca-trust-helper.sh");
    fs.writeFileSync(trustHelper, "#!/bin/sh\nexit 0\n");
    fs.chmodSync(trustHelper, 0o755);
    for (const file of ["index.html", "bootstrap.css", "bootstrap.js", "canonical-origin.js"]) {
      fs.writeFileSync(path.join(root, "src-tauri", "bootstrap", file), `${file}\n`);
    }
    fs.writeFileSync(path.join(root, "dist", "index.js"), "daemon-entry\n");

    const result = spawnSync("sh", ["scripts/make-dist.sh"], { cwd: root, encoding: "utf8" });

    expect(result.status, result.stderr).toBe(0);
    expect(fs.readFileSync(path.join(root, "dist", "index.js"), "utf8")).toBe("daemon-entry\n");
    expect(fs.readFileSync(path.join(root, "src-tauri", "dist", "index.html"), "utf8")).toBe("index.html\n");
    expect(fs.readFileSync(path.join(root, "src-tauri", "dist", "bootstrap.css"), "utf8")).toBe("bootstrap.css\n");
    expect(fs.readFileSync(path.join(root, "src-tauri", "dist", "bootstrap.js"), "utf8")).toBe("bootstrap.js\n");
    expect(fs.readFileSync(path.join(root, "src-tauri", "dist", "canonical-origin.js"), "utf8")).toBe("canonical-origin.js\n");

    const config = JSON.parse(fs.readFileSync(path.join(process.cwd(), "src-tauri", "tauri.conf.json"), "utf8"));
    expect(config.build.frontendDist).toBe("dist");
    expect(config.app.windows[0]).not.toHaveProperty("url");
  });
});
