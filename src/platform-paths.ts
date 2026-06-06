import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function userHome(): string {
  return process.env.HOME || os.homedir();
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

export function getMandibleConfigDir(): string {
  const override = envPath("MANDIBLE_CONFIG_DIR");
  if (override) return override;

  const home = userHome();
  switch (process.platform) {
    case "darwin":
      return path.join(home, "Library", "Application Support", "Mandible", "config");
    case "win32":
      return path.join(
        process.env.APPDATA || path.join(home, "AppData", "Roaming"),
        "Mandible",
        "config",
      );
    default:
      return path.join(process.env.XDG_CONFIG_HOME || path.join(home, ".config"), "mandible");
  }
}

export function getMandibleConfigPath(...segments: string[]): string {
  return path.join(getMandibleConfigDir(), ...segments);
}

export function getLegacyMandibleConfigPath(...segments: string[]): string {
  return path.join(userHome(), ".config", "mandible", ...segments);
}

export function ensureMandibleConfigFile(...segments: string[]): string {
  const configPath = getMandibleConfigPath(...segments);
  const legacyPath = getLegacyMandibleConfigPath(...segments);
  if (path.resolve(configPath) === path.resolve(legacyPath)) {
    return configPath;
  }
  if (fs.existsSync(configPath) || !fs.existsSync(legacyPath)) {
    return configPath;
  }
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.copyFileSync(legacyPath, configPath);
  return configPath;
}

export function getMandibleDataDir(): string {
  const override = envPath("MANDIBLE_DATA_DIR");
  if (override) return override;

  const home = userHome();
  switch (process.platform) {
    case "darwin":
      return path.join(home, "Library", "Application Support", "Mandible");
    case "win32":
      return path.join(process.env.APPDATA || path.join(home, "AppData", "Roaming"), "Mandible");
    default:
      return path.join(process.env.XDG_DATA_HOME || path.join(home, ".local", "share"), "mandible");
  }
}

export function getMandibleDataPath(...segments: string[]): string {
  return path.join(getMandibleDataDir(), ...segments);
}
