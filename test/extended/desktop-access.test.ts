// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { PRODUCTION_ORIGIN } from "../../src/canonical-origin";

describe("desktop native origin boundary", () => {
  it("exposes commands only to the exact registered production HTTPS origin", () => {
    const rust = fs.readFileSync(path.join(process.cwd(), "src-tauri", "src", "lib.rs"), "utf8");
    const permission = fs.readFileSync(path.join(process.cwd(), "src-tauri", "permissions", "desktop.toml"), "utf8");
    const capability = JSON.parse(fs.readFileSync(
      path.join(process.cwd(), "src-tauri", "capabilities", "default.json"), "utf8",
    )) as { remote?: { urls?: string[] }; permissions?: string[] };
    const registered = rust.match(/generate_handler!\[([\s\S]*?)\]\)/)?.[1]
      .split(",").map((command) => command.trim()).filter(Boolean);
    const permitted = permission.match(/commands\.allow = \[([\s\S]*?)\]/)?.[1]
      .match(/"([^"]+)"/g)?.map((command) => command.slice(1, -1));
    expect(permitted).toEqual(registered);
    expect(capability.remote?.urls).toEqual([PRODUCTION_ORIGIN]);
    expect(rust).toContain("origin == PRODUCTION_ORIGIN");
    expect(capability.permissions).toContain("allow-desktop-commands");
  });

  it("installs the HttpOnly browser session inside native code", () => {
    const rust = fs.readFileSync(path.join(process.cwd(), "src-tauri", "src", "lib.rs"), "utf8");
    expect(rust).toContain("fn install_browser_session(");
    expect(rust).toContain("credential.fill(0);");
    expect(rust).toContain("native enrollment is available only to the registered production origin");
    expect(rust).not.toContain("mandible_auth=");
  });

  it("spends bootstrap proof only after a definitive daemon response", () => {
    const rust = fs.readFileSync(path.join(process.cwd(), "src-tauri", "src", "lib.rs"), "utf8");
    const bootstrap = rust.slice(rust.indexOf("fn client_auth_enroll("), rust.indexOf("/// Log the desktop shell in"));
    expect(bootstrap.match(/discard_spent_proof\(&path\)/g)).toHaveLength(2);
    expect(bootstrap).toContain("Enrollment::Unreachable(message)");
    expect(bootstrap).toContain("CLIENT_AUTH_BOOTSTRAP_CONSUMED.store(false, Ordering::Release)");
  });

  it("requires success plus a parseable session cookie before enrollment succeeds", () => {
    const rust = fs.readFileSync(path.join(process.cwd(), "src-tauri", "src", "lib.rs"), "utf8");
    expect(rust).toContain("if !response.status().is_success()");
    expect(rust).toContain("reqwest::header::SET_COOKIE");
    expect(rust).toContain("__Host-mandible-session=");
    expect(rust).toContain("window.set_cookie(cookie)");
  });
});
