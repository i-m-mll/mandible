import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { getMandibleHomePath } from "./platform-paths.js";

export type ChatShownProject = {
  projectId: string;
  checkoutId: string;
};

export type ChatShownProjectsPreference = {
  version: 1;
  key: "chat_shown_projects";
  value: ChatShownProject[];
  revision: number;
};

type HostUserPreferencesFile = {
  version: 1;
  userId: string;
  revision: number;
  settings: {
    chatShownProjects: ChatShownProject[];
  };
};

export class HostUserPreferencesError extends Error {
  constructor(
    public readonly code: "invalid_user_id" | "invalid_file" | "lock_timeout",
    message: string,
  ) {
    super(message);
    this.name = "HostUserPreferencesError";
  }
}

export class HostUserPreferencesRevisionConflict extends Error {
  constructor(
    public readonly expectedRevision: number,
    public readonly current: ChatShownProjectsPreference,
  ) {
    super(`Host preference revision conflict: expected ${expectedRevision}, found ${current.revision}`);
    this.name = "HostUserPreferencesRevisionConflict";
  }
}

const MAX_SHOWN_PROJECTS = 500;
const LOCK_WAIT_MS = 2_000;
const LOCK_STALE_MS = 30_000;
const LOCK_RETRY_MS = 10;

function preferencesRoot(): string {
  // Deliberately anchored on MANDIBLE_HOME rather than MANDIBLE_CONFIG_DIR.
  // IAB previews isolate their config directory, but host/user view intent must
  // be shared with the main daemon and remain outside the copied preview DB.
  return getMandibleHomePath("settings", "users");
}

function safeUserId(userId: string): string {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(userId)) {
    throw new HostUserPreferencesError("invalid_user_id", "Authenticated user id cannot name a preference file.");
  }
  return userId;
}

export function normalizeChatShownProjects(value: unknown): ChatShownProject[] | null {
  if (!Array.isArray(value) || value.length > MAX_SHOWN_PROJECTS) return null;
  const normalized: ChatShownProject[] = [];
  const seen = new Set<string>();
  for (const candidate of value) {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return null;
    const record = candidate as Record<string, unknown>;
    if (typeof record.projectId !== "string" || typeof record.checkoutId !== "string") return null;
    const projectId = record.projectId.trim();
    const checkoutId = record.checkoutId.trim();
    if (!projectId || !checkoutId || seen.has(projectId)) return null;
    seen.add(projectId);
    normalized.push({ projectId, checkoutId });
  }
  return normalized;
}

function emptyFile(userId: string): HostUserPreferencesFile {
  return {
    version: 1,
    userId,
    revision: 0,
    settings: { chatShownProjects: [] },
  };
}

function parseFile(raw: string, userId: string): HostUserPreferencesFile {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new HostUserPreferencesError("invalid_file", "Host preference file contains invalid JSON.");
  }
  const record = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
  const settings = record?.settings && typeof record.settings === "object" && !Array.isArray(record.settings)
    ? record.settings as Record<string, unknown>
    : null;
  const shownProjects = normalizeChatShownProjects(settings?.chatShownProjects);
  if (
    record?.version !== 1
    || record.userId !== userId
    || !Number.isSafeInteger(record.revision)
    || (record.revision as number) < 0
    || shownProjects === null
  ) {
    throw new HostUserPreferencesError("invalid_file", "Host preference file does not match schema version 1.");
  }
  return {
    version: 1,
    userId,
    revision: record.revision as number,
    settings: { chatShownProjects: shownProjects },
  };
}

function snapshot(file: HostUserPreferencesFile): ChatShownProjectsPreference {
  return {
    version: 1,
    key: "chat_shown_projects",
    value: file.settings.chatShownProjects,
    revision: file.revision,
  };
}

async function pause(ms: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}

async function acquireLock(lockPath: string): Promise<() => Promise<void>> {
  const started = Date.now();
  const token = randomUUID();
  while (true) {
    try {
      await fs.promises.mkdir(lockPath, { mode: 0o700 });
      try {
        await fs.promises.writeFile(path.join(lockPath, "owner"), token, { encoding: "utf8", mode: 0o600 });
      } catch (error) {
        await fs.promises.rm(lockPath, { recursive: true, force: true });
        throw error;
      }
      return async () => {
        try {
          if (await fs.promises.readFile(path.join(lockPath, "owner"), "utf8") === token) {
            await fs.promises.rm(lockPath, { recursive: true, force: true });
          }
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      try {
        const stat = await fs.promises.stat(lockPath);
        if (Date.now() - stat.mtimeMs > LOCK_STALE_MS) {
          const reaperPath = `${lockPath}.reap`;
          try {
            // Serialize stale-lock cleanup so two daemon processes cannot each
            // remove a lock the other one just acquired.
            await fs.promises.mkdir(reaperPath, { mode: 0o700 });
            try {
              const current = await fs.promises.stat(lockPath);
              if (Date.now() - current.mtimeMs > LOCK_STALE_MS) {
                await fs.promises.rm(lockPath, { recursive: true, force: true });
              }
            } finally {
              await fs.promises.rm(reaperPath, { recursive: true, force: true });
            }
          } catch (reaperError) {
            if ((reaperError as NodeJS.ErrnoException).code !== "EEXIST") throw reaperError;
          }
          if (Date.now() - started >= LOCK_WAIT_MS) {
            throw new HostUserPreferencesError("lock_timeout", "Timed out waiting for the host preference writer.");
          }
          await pause(LOCK_RETRY_MS);
          continue;
        }
      } catch (statError) {
        if ((statError as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw statError;
      }
      if (Date.now() - started >= LOCK_WAIT_MS) {
        throw new HostUserPreferencesError("lock_timeout", "Timed out waiting for the host preference writer.");
      }
      await pause(LOCK_RETRY_MS);
    }
  }
}

async function readFileOrDefault(filePath: string, userId: string): Promise<HostUserPreferencesFile> {
  try {
    return parseFile(await fs.promises.readFile(filePath, "utf8"), userId);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyFile(userId);
    throw error;
  }
}

async function writeFileAtomically(filePath: string, value: HostUserPreferencesFile): Promise<void> {
  const directory = path.dirname(filePath);
  await fs.promises.mkdir(directory, { recursive: true, mode: 0o700 });
  await fs.promises.chmod(directory, 0o700);
  const temporary = path.join(directory, `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`);
  let handle: fs.promises.FileHandle | null = null;
  try {
    handle = await fs.promises.open(temporary, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = null;
    await fs.promises.rename(temporary, filePath);
  } finally {
    if (handle) await handle.close().catch(() => undefined);
    await fs.promises.rm(temporary, { force: true }).catch(() => undefined);
  }
}

export class HostUserPreferencesStore {
  constructor(private readonly root = preferencesRoot()) {}

  private filePath(userId: string): string {
    return path.join(this.root, `${safeUserId(userId)}.json`);
  }

  async readChatShownProjects(userId: string): Promise<ChatShownProjectsPreference> {
    const safeId = safeUserId(userId);
    return snapshot(await readFileOrDefault(this.filePath(safeId), safeId));
  }

  async writeChatShownProjects(
    userId: string,
    expectedRevision: number,
    value: ChatShownProject[],
  ): Promise<ChatShownProjectsPreference> {
    const safeId = safeUserId(userId);
    const filePath = this.filePath(safeId);
    await fs.promises.mkdir(this.root, { recursive: true, mode: 0o700 });
    const release = await acquireLock(`${filePath}.lock`);
    try {
      const current = await readFileOrDefault(filePath, safeId);
      if (current.revision !== expectedRevision) {
        throw new HostUserPreferencesRevisionConflict(expectedRevision, snapshot(current));
      }
      const next: HostUserPreferencesFile = {
        version: 1,
        userId: safeId,
        revision: current.revision + 1,
        settings: { chatShownProjects: value },
      };
      await writeFileAtomically(filePath, next);
      return snapshot(next);
    } finally {
      await release();
    }
  }
}
