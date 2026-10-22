// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { PRODUCTION_ORIGIN } from "../src/canonical-origin";

describe("desktop native origin boundary", () => {
  it("exposes commands only to the exact registered production HTTPS origin", () => {
    const rust = fs.readFileSync(path.join(process.cwd(), "src-tauri", "src", "lib.rs"), "utf8");
    const permission = fs.readFileSync(path.join(process.cwd(), "src-tauri", "permissions", "desktop.toml"), "utf8");
    const capability = JSON.parse(fs.readFileSync(
      path.join(process.cwd(), "src-tauri", "capabilities", "default.json"), "utf8",
    )) as { remote?: { urls?: string[] }; permissions?: string[] };
    const registered = rust.match(/generate_handler!\[([\s\S]*?)\]\)/)?.[1]
      .split(",").map((command) => command.trim().split('::').at(-1)!).filter(Boolean);
    const permitted = permission.match(/commands\.allow = \[([\s\S]*?)\]/)?.[1]
      .match(/"([^"]+)"/g)?.map((command) => command.slice(1, -1));
    const acceptancePermission = fs.readFileSync(path.join(process.cwd(), 'src-tauri/permissions/acceptance.toml'), 'utf8');
    const acceptanceCommands = acceptancePermission.match(/commands\.allow = \[([\s\S]*?)\]/)?.[1]
      .match(/"([^"]+)"/g)?.map(command => command.slice(1, -1));
    expect([...permitted!, ...acceptanceCommands!].sort()).toEqual(registered?.sort());
    expect(permitted).not.toContain('candidate_acceptance_report');
    expect(acceptanceCommands).toEqual(['candidate_acceptance_report']);
    expect(capability.remote?.urls).toEqual([PRODUCTION_ORIGIN]);
    expect(rust).toContain("origin == PRODUCTION_ORIGIN");
    expect(capability.permissions).toContain("allow-desktop-commands");
    expect(capability.permissions).not.toContain('allow-candidate-acceptance');
  });

  it("keeps native connection setup and daemon control without enrollment commands", () => {
    const rust = fs.readFileSync(path.join(process.cwd(), "src-tauri", "src", "lib.rs"), "utf8");
    expect(rust).toContain("secure_local_connections_setup");
    expect(rust).toContain("daemon_start");
    expect(rust).not.toContain("client_auth_enroll");
    expect(rust).not.toContain("install_browser_session");
  });
});
