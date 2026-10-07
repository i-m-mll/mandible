import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { getMandibleHomePath } from "./platform-paths.js";
import type { SidebarOrderPreference, SidebarOrderPreferenceValue } from "./contracts.js";

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

export type HostAppTheme = "system" | "light" | "dark";

export type AppThemePreference = {
  version: 1;
  key: "app_theme";
  value: HostAppTheme | null;
  revision: number;
};

type HostUserPreferencesFile = {
  version: 1;
  userId: string;
  revision: number;
  settings: {
    chatShownProjects: ChatShownProject[];
    appTheme: HostAppTheme | null;
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
    public readonly current: ChatShownProjectsPreference | AppThemePreference | SidebarOrderPreference,
  ) {
    super(`Host preference revision conflict: expected ${expectedRevision}, found ${current.revision}`);
    this.name = "HostUserPreferencesRevisionConflict";
  }
}

const MAX_SHOWN_PROJECTS = 500;
export const MAX_ORDERED_SIDEBAR_IDS = 1000;
const LOCK_WAIT_MS = 2_000;
const LOCK_STALE_MS = 30_000;
const LOCK_RETRY_MS = 10;

function preferencesRoot(): string {
  // Production keeps durable user intent under MANDIBLE_HOME. A registered
  // preview supplies its separately validated instance-owned directory.
  return process.env.MANDIBLE_USER_PREFERENCES_DIR?.trim()
    ? path.resolve(process.env.MANDIBLE_USER_PREFERENCES_DIR)
    : getMandibleHomePath("settings", "users");
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

function normalizeOrderedSidebarIds(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length > MAX_ORDERED_SIDEBAR_IDS) return null;
  const result: string[] = [];
  const seen = new Set<string>();
  for (const candidate of value) {
    if (typeof candidate !== "string") return null;
    const id = candidate.trim();
    if (!id || seen.has(id)) return null;
    seen.add(id);
    result.push(id);
  }
  return result;
}

export function normalizeSidebarOrderPreferenceValue(value: unknown): SidebarOrderPreferenceValue | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const pinnedConversationIds = record.pinnedConversationIds === null
    ? null
    : normalizeOrderedSidebarIds(record.pinnedConversationIds);
  const briefingTopLevelIds = record.briefingTopLevelIds === null
    ? null
    : normalizeOrderedSidebarIds(record.briefingTopLevelIds);
  if (pinnedConversationIds === null && record.pinnedConversationIds !== null) return null;
  if (briefingTopLevelIds === null && record.briefingTopLevelIds !== null) return null;
  return { pinnedConversationIds, briefingTopLevelIds };
}

type SidebarOrderFile = {
  version: 1;
  userId: string;
  revision: number;
  value: SidebarOrderPreferenceValue;
};

function emptySidebarOrderFile(userId: string): SidebarOrderFile {
  return {
    version: 1,
    userId,
    revision: 0,
    value: { pinnedConversationIds: null, briefingTopLevelIds: null },
  };
}

function parseSidebarOrderFile(raw: string, userId: string): SidebarOrderFile {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new HostUserPreferencesError("invalid_file", "Sidebar order file contains invalid JSON.");
  }
  const record = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
  const order = normalizeSidebarOrderPreferenceValue(record?.value);
  if (record?.version !== 1 || record.userId !== userId
      || !Number.isSafeInteger(record.revision) || (record.revision as number) < 0 || order === null) {
    throw new HostUserPreferencesError("invalid_file", "Sidebar order file does not match schema version 1.");
  }
  return { version: 1, userId, revision: record.revision as number, value: order };
}

function sidebarOrderSnapshot(file: SidebarOrderFile): SidebarOrderPreference {
  return { version: 1, key: "sidebar_order", value: file.value, revision: file.revision };
}

function emptyFile(userId: string): HostUserPreferencesFile {
  return {
    version: 1,
    userId,
    revision: 0,
    settings: { chatShownProjects: [], appTheme: null },
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
  const appTheme = settings?.appTheme === undefined || settings.appTheme === null
    ? null
    : normalizeAppTheme(settings.appTheme);
  if (
    record?.version !== 1
    || record.userId !== userId
    || !Number.isSafeInteger(record.revision)
    || (record.revision as number) < 0
    || shownProjects === null
    || (settings?.appTheme !== undefined && settings.appTheme !== null && appTheme === null)
  ) {
    throw new HostUserPreferencesError("invalid_file", "Host preference file does not match schema version 1.");
  }
  return {
    version: 1,
    userId,
    revision: record.revision as number,
    settings: { chatShownProjects: shownProjects, appTheme },
  };
}

export function normalizeAppTheme(value: unknown): HostAppTheme | null {
  return value === "system" || value === "light" || value === "dark" ? value : null;
}

function appThemeSnapshot(file: HostUserPreferencesFile): AppThemePreference {
  return { version: 1, key: "app_theme", value: file.settings.appTheme, revision: file.revision };
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

async function readSidebarOrderFileOrDefault(filePath: string, userId: string): Promise<SidebarOrderFile> {
  try {
    return parseSidebarOrderFile(await fs.promises.readFile(filePath, "utf8"), userId);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptySidebarOrderFile(userId);
    throw error;
  }
}

async function writeFileAtomically(filePath: string, value: HostUserPreferencesFile | SidebarOrderFile): Promise<void> {
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

  private sidebarOrderFilePath(userId: string): string {
    return path.join(this.root, `${safeUserId(userId)}.sidebar-order.json`);
  }

  async readChatShownProjects(userId: string): Promise<ChatShownProjectsPreference> {
    const safeId = safeUserId(userId);
    return snapshot(await readFileOrDefault(this.filePath(safeId), safeId));
  }

  async readAppTheme(userId: string): Promise<AppThemePreference> {
    const safeId = safeUserId(userId);
    return appThemeSnapshot(await readFileOrDefault(this.filePath(safeId), safeId));
  }

  async readSidebarOrder(userId: string): Promise<SidebarOrderPreference> {
    const safeId = safeUserId(userId);
    return sidebarOrderSnapshot(await readSidebarOrderFileOrDefault(this.sidebarOrderFilePath(safeId), safeId));
  }

  async writeSidebarOrder(
    userId: string,
    expectedRevision: number,
    value: SidebarOrderPreferenceValue,
  ): Promise<SidebarOrderPreference> {
    const safeId = safeUserId(userId);
    const filePath = this.sidebarOrderFilePath(safeId);
    await fs.promises.mkdir(this.root, { recursive: true, mode: 0o700 });
    const release = await acquireLock(`${filePath}.lock`);
    try {
      const current = await readSidebarOrderFileOrDefault(filePath, safeId);
      if (current.revision !== expectedRevision) {
        throw new HostUserPreferencesRevisionConflict(expectedRevision, sidebarOrderSnapshot(current));
      }
      const next: SidebarOrderFile = {
        version: 1,
        userId: safeId,
        revision: current.revision + 1,
        value,
      };
      await writeFileAtomically(filePath, next);
      return sidebarOrderSnapshot(next);
    } finally {
      await release();
    }
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
        settings: { ...current.settings, chatShownProjects: value },
      };
      await writeFileAtomically(filePath, next);
      return snapshot(next);
    } finally {
      await release();
    }
  }


  async writeAppTheme(
    userId: string,
    expectedRevision: number,
    value: HostAppTheme,
  ): Promise<AppThemePreference> {
    const safeId = safeUserId(userId);
    const filePath = this.filePath(safeId);
    await fs.promises.mkdir(this.root, { recursive: true, mode: 0o700 });
    const release = await acquireLock(`${filePath}.lock`);
    try {
      const current = await readFileOrDefault(filePath, safeId);
      if (current.revision !== expectedRevision) {
        throw new HostUserPreferencesRevisionConflict(expectedRevision, appThemeSnapshot(current));
      }
      const next: HostUserPreferencesFile = {
        version: 1,
        userId: safeId,
        revision: current.revision + 1,
        settings: { ...current.settings, appTheme: value },
      };
      await writeFileAtomically(filePath, next);
      return appThemeSnapshot(next);
    } finally {
      await release();
    }
  }
}
