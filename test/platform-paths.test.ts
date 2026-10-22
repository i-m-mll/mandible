import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

describe("platform paths", () => {
  const originalHome = process.env.HOME;
  const originalConfigDir = process.env.MANDIBLE_CONFIG_DIR;
  let tempDir = "";

  afterEach(() => {
    process.env.HOME = originalHome;
    if (originalConfigDir === undefined) {
      delete process.env.MANDIBLE_CONFIG_DIR;
    } else {
      process.env.MANDIBLE_CONFIG_DIR = originalConfigDir;
    }
    vi.resetModules();
    if (tempDir) {
      fs.rmSync(tempDir, { recursive: true, force: true });
      tempDir = "";
    }
  });

  it("honors MANDIBLE_CONFIG_DIR and expands home-relative paths", async () => {
    const home = path.join(os.tmpdir(), "mandible-platform-home");
    process.env.HOME = home;
    process.env.MANDIBLE_CONFIG_DIR = "~/mandible-config";
    vi.resetModules();

    const { getMandibleConfigPath } = await import("../../src/platform-paths.js");

    expect(getMandibleConfigPath("repos.json")).toBe(
      path.join(home, "mandible-config", "repos.json"),
    );
  });

  it("copies an existing legacy config file into the central config directory", async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-platform-paths-"));
    process.env.HOME = tempDir;
    process.env.MANDIBLE_CONFIG_DIR = path.join(tempDir, "central-config");
    const legacyPath = path.join(tempDir, ".config", "mandible", "repos.json");
    fs.mkdirSync(path.dirname(legacyPath), { recursive: true });
    fs.writeFileSync(legacyPath, '{"repos":["/repo"]}\n', "utf8");
    vi.resetModules();

    const { ensureMandibleConfigFile } = await import("../../src/platform-paths.js");
    const configPath = ensureMandibleConfigFile("repos.json");

    expect(configPath).toBe(path.join(tempDir, "central-config", "repos.json"));
    expect(fs.readFileSync(configPath, "utf8")).toBe('{"repos":["/repo"]}\n');
    expect(fs.existsSync(legacyPath)).toBe(true);
  });
});
