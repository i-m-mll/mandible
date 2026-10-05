import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { copyRuntimeFixture } from '../helpers/runtime-fixture.js';

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
  copyRuntimeFixture(root);
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
    defaultRelaunch?: boolean;
  } = {},
) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-desktop-install-"));
  tempRoots.push(root);
  const built = path.join(root, "build", "Mandible.app");
  const installed = path.join(root, "Applications", "Mandible.app");
  const backups = path.join(root, "backups");
  const buildTrace = path.join(root, "build-trace");
  const relaunchTrace = path.join(root, "relaunch-trace");
  const runtimeTrace = path.join(root, "runtime-trace");
  const codesignCount = path.join(root, "codesign-count");
  makeBundle(built, "new", options.signed ?? true);
  if (options.installed !== false) makeBundle(installed, "old");
  const tools = makeTooling(root);
  const nodeCommand = path.join(root, "bin", "node-runtime-setup");
  fs.writeFileSync(nodeCommand, '#!/bin/bash\nprintf "%s\\n" "$@" > "$MANDIBLE_TEST_RUNTIME_TRACE"\n', { mode: 0o755 });
  const terminated = path.join(root, "terminated");
  const relaunchPgrep = path.join(root, "bin", "relaunch-pgrep");
  const relaunchPs = path.join(root, "bin", "relaunch-ps");
  const relaunchKill = path.join(root, "bin", "relaunch-kill");
  const relaunchOpen = path.join(root, "bin", "relaunch-open");
  const relaunchSleep = path.join(root, "bin", "relaunch-sleep");
  fs.writeFileSync(relaunchPgrep, '#!/bin/bash\nprintf "101\\n"\n', { mode: 0o755 });
  fs.writeFileSync(
    relaunchPs,
    '#!/bin/bash\n[[ -f "$MANDIBLE_TEST_TERMINATED" ]] || printf "%s\\n" "$MANDIBLE_DESKTOP_INSTALL_PATH/Contents/MacOS/mandible-app"\n',
    { mode: 0o755 },
  );
  fs.writeFileSync(
    relaunchKill,
    '#!/bin/bash\nprintf "kill %s %s\\n" "$1" "$2" >> "$MANDIBLE_TEST_RELAUNCH_TRACE"\ntouch "$MANDIBLE_TEST_TERMINATED"\n',
    { mode: 0o755 },
  );
  fs.writeFileSync(
    relaunchOpen,
    '#!/bin/bash\nprintf "open %s %s\\n" "$1" "$2" >> "$MANDIBLE_TEST_RELAUNCH_TRACE"\n',
    { mode: 0o755 },
  );
  fs.writeFileSync(
    relaunchSleep,
    '#!/bin/bash\nprintf "sleep %s\\n" "$1" >> "$MANDIBLE_TEST_RELAUNCH_TRACE"\n',
    { mode: 0o755 },
  );

  const result = spawnSync("bash", ["cli/install-desktop-app.sh"], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: {
      ...process.env,
      MANDIBLE_RUNTIME: process.execPath,
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
      MANDIBLE_DESKTOP_RUNTIME: nodeCommand,
      MANDIBLE_TEST_RUNTIME_TRACE: runtimeTrace,
      MANDIBLE_DESKTOP_ASSUME_RUNNING: options.running ? "1" : "0",
      MANDIBLE_DESKTOP_RELAUNCH_COMMAND: options.defaultRelaunch
        ? ""
        : 'printf "relaunch\\n" > "$MANDIBLE_TEST_RELAUNCH_TRACE"',
      MANDIBLE_DESKTOP_PGREP: relaunchPgrep,
      MANDIBLE_DESKTOP_PS: relaunchPs,
      MANDIBLE_DESKTOP_KILL: relaunchKill,
      MANDIBLE_DESKTOP_OPEN: relaunchOpen,
      MANDIBLE_DESKTOP_SLEEP: relaunchSleep,
      MANDIBLE_DESKTOP_RELAUNCH_DELAY_SECONDS: "0",
      MANDIBLE_TEST_RELAUNCH_TRACE: relaunchTrace,
      MANDIBLE_TEST_TERMINATED: terminated,
      MANDIBLE_TEST_CODESIGN_COUNT: codesignCount,
      MANDIBLE_TEST_CODESIGN_FAIL_AT: options.failCodesignAt?.toString() ?? "",
    },
  });

  return { result, installed, backups, buildTrace, relaunchTrace, runtimeTrace };
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
    fs.mkdirSync(path.join(root, "scripts"), { recursive: true });
  fs.copyFileSync(path.join(process.cwd(), "scripts/bun-runtime.sh"), path.join(root, "scripts/bun-runtime.sh"));
  fs.chmodSync(path.join(root, "scripts/bun-runtime.sh"), 0o755);
  fs.copyFileSync(path.join(process.cwd(), ".bun-version"), path.join(root, ".bun-version"));
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
    const sleep = writeTool(
      "sleep",
      'printf "sleep %s\\n" "$1" >> "$MANDIBLE_TEST_TRACE"\n',
    );

    const result = spawnSync(
      "bash",
      ["cli/install-desktop-app.sh", "--relaunch", installPath, "mandible-app", "0"],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        env: {
          ...process.env,
      MANDIBLE_RUNTIME: process.execPath,
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
    const relaunchTrace = fs.readFileSync(trace, "utf8");
    expect(relaunchTrace).toContain("kill -TERM 101");
    expect(relaunchTrace).not.toContain("202");
    expect(relaunchTrace).toContain(`open -n ${installPath}`);
    expect(relaunchTrace.indexOf("kill -TERM 101"))
      .toBeLessThan(relaunchTrace.indexOf("sleep 0"));
    expect(relaunchTrace.indexOf("sleep 0"))
      .toBeLessThan(relaunchTrace.indexOf(`open -n ${installPath}`));
  });

  it("validates, backs up, installs, and requests relaunch for a running app", () => {
    const { result, installed, backups, buildTrace, relaunchTrace, runtimeTrace } = runInstaller({ running: true });

    expect(result.status, result.stderr).toBe(0);
    expect(fs.readFileSync(buildTrace, "utf8")).toBe("build\n");
    expect(fs.readFileSync(runtimeTrace, "utf8")).toContain("scripts/local-runtime.mjs\ninstall\n--root\n");
    expect(fs.readFileSync(runtimeTrace, "utf8")).toContain(`${process.cwd()}\n`);
    expect(fs.readFileSync(path.join(installed, "Contents", "marker"), "utf8")).toBe("new");
    const backup = fs.readdirSync(backups).find((entry) => entry.endsWith(".app"));
    expect(backup).toBeTruthy();
    expect(fs.readFileSync(path.join(backups, backup!, "Contents", "marker"), "utf8")).toBe("old");
    expect(fs.readFileSync(relaunchTrace, "utf8")).toBe("relaunch\n");
    expect(result.stderr).toContain("previous bundle preserved");
    expect(result.stderr).toContain("restarted the running desktop shell");
  });

  it("completes the default relaunch before reporting installer success", () => {
    const { result, installed, relaunchTrace } = runInstaller({
      running: true,
      defaultRelaunch: true,
    });

    expect(result.status, result.stderr).toBe(0);
    expect(fs.readFileSync(relaunchTrace, "utf8")).toContain("kill -TERM 101");
    expect(fs.readFileSync(relaunchTrace, "utf8")).toContain(`open -n ${installed}`);
    expect(result.stderr).toContain("restarted the running desktop shell");
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
    const { result, installed, backups, relaunchTrace, runtimeTrace } = runInstaller({ signed: false });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("failed code-signature verification");
    expect(fs.readFileSync(path.join(installed, "Contents", "marker"), "utf8")).toBe("old");
    expect(fs.existsSync(backups)).toBe(false);
    expect(fs.existsSync(relaunchTrace)).toBe(false);
    expect(fs.existsSync(runtimeTrace)).toBe(false);
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
