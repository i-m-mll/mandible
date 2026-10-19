/** Any connection that can read the settings table. */
interface SettingsReader {
  prepare(sql: string): { get(...params: unknown[]): unknown };
}

/**
 * Mandible's protection config: the global `protected_branches` setting plus
 * each registered checkout's default branch.
 *
 * A missing setting row means the shipped default. An explicitly empty value
 * means no globally protected names; checkout default branches still apply.
 */
export const DEFAULT_PROTECTED_BRANCHES_SETTING = "main,develop";

export function parseProtectedBranchSetting(value: string): string[] {
  return value.split(",").map((branch) => branch.trim()).filter(Boolean);
}

export function readProtectedBranchSetting(db: SettingsReader): string[] {
  const row = db
    .prepare("SELECT value FROM settings WHERE key = 'protected_branches'")
    .get() as { value?: string } | undefined;
  return parseProtectedBranchSetting(String(row?.value ?? DEFAULT_PROTECTED_BRANCHES_SETTING));
}

/** Protected branch names for one checkout: global names plus its default branch. */
export function protectedBranchNames(db: SettingsReader, defaultBranch: string | null | undefined): Set<string> {
  const names = new Set(readProtectedBranchSetting(db));
  const fallback = defaultBranch?.trim();
  if (fallback) names.add(fallback);
  return names;
}
