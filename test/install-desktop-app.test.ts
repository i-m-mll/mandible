import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const tempRoots: string[] = [];

function makeBundle(appPath: string, marker: string, signed = true): void {
  const contents = path.join(appPath, "Contents");
  const macos = path.join(contents, "MacOS");
  fs.mkdirSync(macos, { recursive: true });
  fs.writeFileSync(
    path.join(contents, "Info.plist"),
    "CFBundleIdentifier=bio.mll.mandible\nCFBundleExecutable=mandible-app\n",
  );
  fs.writeFileSync(path.join(macos, "mandible-app"), `#!/bin/sh\n# ${marker}\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(contents, "marker"), marker);
  if (signed) fs.writeFileSync(path.join(contents, "signature-ok"), "ok\n");
}

function makeTooling(root: string): { codesign: string; ditto: string; plist: string } {
  const bin = path.join(root, "bin");
  fs.mkdirSync(bin, { recursive: true });

  const codesign = path.join(bin, "codesign");
  fs.writeFileSync(
    codesign,
    `#!/bin/sh
count=0
if [[ -f "$MANDIBLE_TEST_CODESIGN_COUNT" ]]; then count="$(cat "$MANDIBLE_TEST_CODESIGN_COUNT")"; fi
count=$((count + 1))
printf '%s' "$count" > "$MANDIBLE_TEST_CODESIGN_COUNT"
if [[ -n "\${MANDIBLE_TEST_CODESIGN_FAIL_AT:-}" && "$count" == "$MANDIBLE_TEST_CODESIGN_FAIL_AT" ]]; then exit 1; fi
app="\${4}"
test -f "$app/Contents/signature-ok"
`,
    { mode: 0o755 },
  );

  const ditto = path.join(bin, "ditto");
  fs.writeFileSync(ditto, '#!/bin/sh\ncp -R "$1" "$2"\n', { mode: 0o755 });

  const plist = path.join(bin, "plistbuddy");
  fs.writeFileSync(
    plist,
    `#!/bin/sh
case "$2" in
  *CFBundleIdentifier*) sed -n 's/^CFBundleIdentifier=//p' "$3" ;;
  *CFBundleExecutable*) sed -n 's/^CFBundleExecutable=//p' "$3" ;;
  *) exit 1 ;;
esac
`,
    { mode: 0o755 },
  );

  return { codesign, ditto, plist };
}

function runInstaller(
  options: {
    signed?: boolean;
    running?: boolean;
    failCodesignAt?: number;
    installed?: boolean;
    ci?: string;
    buildCommand?: string;
  } = {},
) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-desktop-install-"));
  tempRoots.push(root);
  const built = path.join(root, "build", "Mandible.app");
  const installed = path.join(root, "Applications", "Mandible.app");
  const backups = path.join(root, "backups");
  const buildTrace = path.join(root, "build-trace");
  const relaunchTrace = path.join(root, "relaunch-trace");
  const codesignCount = path.join(root, "codesign-count");
  makeBundle(built, "new", options.signed ?? true);
  if (options.installed !== false) makeBundle(installed, "old");
  const tools = makeTooling(root);

  const result = spawnSync("bash", ["cli/install-desktop-app.sh"], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: {
      ...process.env,
      CI: options.ci ?? process.env.CI,
      MANDIBLE_DESKTOP_PLATFORM: "Darwin",
      MANDIBLE_DESKTOP_DEPENDENCY_COMMAND: ":",
      MANDIBLE_DESKTOP_BUILD_COMMAND:
        options.buildCommand ?? 'printf "build\\n" > "$MANDIBLE_TEST_BUILD_TRACE"',
      MANDIBLE_TEST_BUILD_TRACE: buildTrace,
      MANDIBLE_DESKTOP_BUNDLE_PATH: built,
      MANDIBLE_DESKTOP_INSTALL_PATH: installed,
      MANDIBLE_DESKTOP_BACKUP_DIR: backups,
      MANDIBLE_DESKTOP_BACKUP_STAMP: "test",
      MANDIBLE_DESKTOP_CODESIGN: tools.codesign,
      MANDIBLE_DESKTOP_DITTO: tools.ditto,
      MANDIBLE_DESKTOP_PLISTBUDDY: tools.plist,
      MANDIBLE_DESKTOP_ASSUME_RUNNING: options.running ? "1" : "0",
      MANDIBLE_DESKTOP_RELAUNCH_COMMAND: 'printf "relaunch\\n" > "$MANDIBLE_TEST_RELAUNCH_TRACE"',
      MANDIBLE_TEST_RELAUNCH_TRACE: relaunchTrace,
      MANDIBLE_TEST_CODESIGN_COUNT: codesignCount,
      MANDIBLE_TEST_CODESIGN_FAIL_AT: options.failCodesignAt?.toString() ?? "",
    },
  });

  return { result, installed, backups, buildTrace, relaunchTrace };
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("desktop app installer", () => {
  it("signals only the process owned by the installed bundle during relaunch", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-desktop-relaunch-"));
    tempRoots.push(root);
    const bin = path.join(root, "bin");
    const installPath = path.join(root, "Applications", "Mandible.app");
    const trace = path.join(root, "trace");
    const terminated = path.join(root, "terminated");
    fs.mkdirSync(bin, { recursive: true });

    const writeTool = (name: string, body: string) => {
      const tool = path.join(bin, name);
      fs.writeFileSync(tool, `#!/bin/bash\n${body}`, { mode: 0o755 });
      return tool;
    };
    const pgrep = writeTool("pgrep", 'printf "101\\n202\\n"\n');
    const ps = writeTool(
      "ps",
      `pid="$3"
if [[ "$pid" == "101" ]]; then
  [[ -f "$MANDIBLE_TEST_TERMINATED" ]] || printf '%s\\n' "$MANDIBLE_TEST_INSTALL/Contents/MacOS/mandible-app"
else
  printf '%s\\n' "/tmp/other-checkout/mandible-app"
fi
`,
    );
    const kill = writeTool(
      "kill",
      'printf "kill %s %s\\n" "$1" "$2" >> "$MANDIBLE_TEST_TRACE"\ntouch "$MANDIBLE_TEST_TERMINATED"\n',
    );
    const open = writeTool("open", 'printf "open %s %s\\n" "$1" "$2" >> "$MANDIBLE_TEST_TRACE"\n');
    const sleep = writeTool("sleep", ":\n");

    const result = spawnSync(
      "bash",
      ["cli/install-desktop-app.sh", "--relaunch", installPath, "mandible-app", "0"],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        env: {
          ...process.env,
          MANDIBLE_DESKTOP_PGREP: pgrep,
          MANDIBLE_DESKTOP_PS: ps,
          MANDIBLE_DESKTOP_KILL: kill,
          MANDIBLE_DESKTOP_OPEN: open,
          MANDIBLE_DESKTOP_SLEEP: sleep,
          MANDIBLE_TEST_TRACE: trace,
          MANDIBLE_TEST_TERMINATED: terminated,
          MANDIBLE_TEST_INSTALL: installPath,
        },
      },
    );

    expect(result.status, result.stderr).toBe(0);
    expect(fs.readFileSync(trace, "utf8")).toContain("kill -TERM 101");
    expect(fs.readFileSync(trace, "utf8")).not.toContain("202");
    expect(fs.readFileSync(trace, "utf8")).toContain(`open -n ${installPath}`);
  });

  it("validates, backs up, installs, and requests relaunch for a running app", () => {
    const { result, installed, backups, buildTrace, relaunchTrace } = runInstaller({ running: true });

    expect(result.status, result.stderr).toBe(0);
    expect(fs.readFileSync(buildTrace, "utf8")).toBe("build\n");
    expect(fs.readFileSync(path.join(installed, "Contents", "marker"), "utf8")).toBe("new");
    const backup = fs.readdirSync(backups).find((entry) => entry.endsWith(".app"));
    expect(backup).toBeTruthy();
    expect(fs.readFileSync(path.join(backups, backup!, "Contents", "marker"), "utf8")).toBe("old");
    expect(fs.readFileSync(relaunchTrace, "utf8")).toBe("relaunch\n");
    expect(result.stderr).toContain("previous bundle preserved");
    expect(result.stderr).toContain("scheduled restart");
  });

  it("normalizes the legacy auth-hook CI value for the Tauri build", () => {
    const { result, buildTrace } = runInstaller({
      ci: "1",
      buildCommand: 'printf "%s\\n" "$CI" > "$MANDIBLE_TEST_BUILD_TRACE"',
    });

    expect(result.status, result.stderr).toBe(0);
    expect(fs.readFileSync(buildTrace, "utf8")).toBe("true\n");
  });

  it("leaves the installed app untouched when the built signature is invalid", () => {
    const { result, installed, backups, relaunchTrace } = runInstaller({ signed: false });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("failed code-signature verification");
    expect(fs.readFileSync(path.join(installed, "Contents", "marker"), "utf8")).toBe("old");
    expect(fs.existsSync(backups)).toBe(false);
    expect(fs.existsSync(relaunchTrace)).toBe(false);
  });

  it("restores the previous app when installed-bundle validation fails after the swap", () => {
    const { result, installed, backups, relaunchTrace } = runInstaller({ failCodesignAt: 4 });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("installed app failed code-signature verification");
    expect(fs.readFileSync(path.join(installed, "Contents", "marker"), "utf8")).toBe("old");
    expect(fs.readdirSync(backups).some((entry) => entry.endsWith(".app"))).toBe(true);
    expect(fs.existsSync(relaunchTrace)).toBe(false);
  });

  it("removes a failed new install when there was no previous app", () => {
    const { result, installed, relaunchTrace } = runInstaller({ installed: false, failCodesignAt: 3 });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("installed app failed code-signature verification");
    expect(fs.existsSync(installed)).toBe(false);
    expect(fs.existsSync(relaunchTrace)).toBe(false);
  });
});
