import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function userHome(): string {
  return process.env.HOME || os.homedir();
}

/** The home directory Mandible anchors user-scoped paths on. */
export function getUserHome(): string {
  return userHome();
}

function resolveHome(input: string): string {
  if (input === "~") {
    return userHome();
  }
  if (input.startsWith("~/")) {
    return path.join(userHome(), input.slice(2));
  }
  return input;
}

function envPath(name: string): string | null {
  const value = process.env[name]?.trim();
  return value ? path.resolve(resolveHome(value)) : null;
}

/**
 * The durable-state root (issue 24f0316).
 *
 * Mandible state is split by lifetime, not by platform convention:
 *
 *   - `~/.mandible` (this function) holds state whose loss is data loss: the
 *     ledger database and its `-wal`/`-shm` sidecars, `backups/`, `config/`,
 *     and the artifact CAS at `artifacts/` (which already lived here).
 *   - `~/.cache/mandible` keeps its original contract — genuinely disposable
 *     state that Mandible can rebuild: the cowork CLI mirror, IAB previews,
 *     agent-rpc spools, Claude hook staging, logs, `daemon.pid`, and the
 *     restart-availability receipt. Nothing under it is authoritative.
 *
 * Before this split the 7.5 GB live ledger sat under `~/.cache`, a directory
 * whose documented contract is "safe to delete". One helper now owns the
 * durable root so a future move is a single edit rather than a repo-wide sweep.
 *
 * `MANDIBLE_HOME` overrides the root wholesale and is honored by every derived
 * path, so a test or an alternate instance can relocate all durable state at
 * once. It is read on each call rather than captured at module load so that
 * tests which repoint `HOME`/`MANDIBLE_HOME` do not need to reset modules.
 */
export function getMandibleHome(): string {
  const override = envPath("MANDIBLE_HOME");
  if (override) return override;
  return path.join(userHome(), ".mandible");
}

export function getMandibleHomePath(...segments: string[]): string {
  return path.join(getMandibleHome(), ...segments);
}

/**
 * Configuration lives under the durable root on every platform (issue 24f0316).
 *
 * It used to follow per-platform convention — `~/Library/Application
 * Support/Mandible/config` on macOS, `%APPDATA%\Mandible\config` on Windows,
 * `$XDG_CONFIG_HOME/mandible` elsewhere — which scattered durable state across
 * three roots and left the daemon (TypeScript), the CLI (`cli/api.sh`) and the
 * desktop shell (`src-tauri/src/lib.rs`) each re-deriving the same path by
 * hand. Folding config into `~/.mandible/config` gives one durable root, and
 * makes the directory name lowercase-`mandible` everywhere, retiring the
 * `Mandible`/`mandible` casing split that only survived because macOS
 * filesystems are case-insensitive by default.
 *
 * Legacy locations are copied forward on first use — see
 * `ensureMandibleConfigEntry` — and are never deleted.
 */
export function getMandibleConfigDir(): string {
  const override = envPath("MANDIBLE_CONFIG_DIR");
  if (override) return override;
  return getMandibleHomePath("config");
}

export function getMandibleConfigPath(...segments: string[]): string {
  return path.join(getMandibleConfigDir(), ...segments);
}

/**
 * Client-auth state may have an authority-specific durable root. Preview
 * launchers use this to keep the pepper, authority id, and session
 * fingerprints outside their recyclable database/cache directory.
 */
export function ensureMandibleClientAuthDir(): string {
  const override = envPath("MANDIBLE_CLIENT_AUTH_DIR");
  if (override) return override;
  return ensureMandibleConfigEntry("client-auth");
}

/**
 * Config directories Mandible used before the durable root existed, in the
 * order they should be consulted. Platform-conventional first (that is where
 * the daemon most recently wrote), then the original `~/.config/mandible`.
 */
export function getLegacyMandibleConfigDirs(): string[] {
  const home = userHome();
  const dirs: string[] = [];
  switch (process.platform) {
    case "darwin":
      dirs.push(path.join(home, "Library", "Application Support", "Mandible", "config"));
      break;
    case "win32":
      dirs.push(
        path.join(
          process.env.APPDATA || path.join(home, "AppData", "Roaming"),
          "Mandible",
          "config",
        ),
      );
      break;
    default:
      dirs.push(path.join(process.env.XDG_CONFIG_HOME || path.join(home, ".config"), "mandible"));
      break;
  }
  dirs.push(path.join(home, ".config", "mandible"));

  const seen = new Set<string>();
  return dirs.filter((dir) => {
    const resolved = path.resolve(dir);
    if (seen.has(resolved)) return false;
    seen.add(resolved);
    return true;
  });
}

export function getLegacyMandibleConfigPath(...segments: string[]): string {
  return path.join(userHome(), ".config", "mandible", ...segments);
}

/**
 * Copy a file or directory tree, reproducing each entry's permission bits.
 *
 * Mode fidelity is not cosmetic here: `client-auth/` is 0700 and holds 0600
 * secrets (the token pepper and installation authority). A copy that widened those
 * modes would be a real regression, and `secret-store.ts` refuses secrets it
 * finds with broader permissions.
 */
function copyPreservingModes(src: string, dest: string): void {
  const stat = fs.lstatSync(src);
  if (stat.isSymbolicLink()) {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.symlinkSync(fs.readlinkSync(src), dest);
    return;
  }
  if (stat.isDirectory()) {
    fs.mkdirSync(dest, { recursive: true });
    for (const entry of fs.readdirSync(src)) {
      copyPreservingModes(path.join(src, entry), path.join(dest, entry));
    }
    fs.chmodSync(dest, stat.mode & 0o7777);
    return;
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
  fs.chmodSync(dest, stat.mode & 0o7777);
}

/**
 * Resolve a config entry under the durable root, copying it forward from the
 * first legacy location that still has it.
 *
 * Handles directories as well as files because two config entries are
 * directories with state that cannot be regenerated without cost:
 * `client-auth/` (losing the pepper invalidates every stored API token) and
 * `delegated-signing/` (the delegated key material). The legacy copy is left in
 * place — this is a copy-forward, never a move — and a failed copy removes its
 * own partial output and falls through to a fresh entry rather than handing the
 * caller a half-populated secret directory.
 */
export function ensureMandibleConfigEntry(...segments: string[]): string {
  const target = getMandibleConfigPath(...segments);
  if (fs.existsSync(target)) return target;

  for (const legacyDir of getLegacyMandibleConfigDirs()) {
    const legacy = path.join(legacyDir, ...segments);
    if (path.resolve(legacy) === path.resolve(target)) continue;
    if (!fs.existsSync(legacy)) continue;
    try {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      copyPreservingModes(legacy, target);
    } catch {
      fs.rmSync(target, { recursive: true, force: true });
      return target;
    }
    return target;
  }

  return target;
}

/**
 * Back-compatible alias for the file-shaped case. Kept because most callers
 * genuinely mean "one config file", and the name reads better at the call site.
 */
export function ensureMandibleConfigFile(...segments: string[]): string {
  return ensureMandibleConfigEntry(...segments);
}
