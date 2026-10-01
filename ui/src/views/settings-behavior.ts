export type SettingSave = (key: string, value: string) => Promise<void>;

export function shouldPersistSettingValue(
  value: string,
  persistedValue: string | null,
  lastSavedValue: string | null,
  inFlightValue: string | null,
): boolean {
  if (value === inFlightValue) return false;
  const isCurrentValue = value === persistedValue || value === lastSavedValue;
  return !isCurrentValue || inFlightValue !== null;
}

export function shouldFlushPendingSettingWrite(
  pending: boolean,
  effectGeneration: number,
  currentGeneration: number,
): boolean {
  return pending && effectGeneration === currentGeneration;
}

export function createOrderedSettingSave(save: SettingSave): SettingSave {
  const pending = new Map<string, Promise<void>>();
  return (key, value) => {
    const prior = pending.get(key) ?? Promise.resolve();
    const next = prior.catch(() => undefined).then(() => save(key, value));
    pending.set(key, next);
    const clear = () => {
      if (pending.get(key) === next) pending.delete(key);
    };
    void next.then(clear, clear);
    return next;
  };
}

export function normalizeQuietHours(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed === '') return '';
  const match = /^(\d{2}):(\d{2})-(\d{2}):(\d{2})$/.exec(trimmed);
  if (!match) return null;
  const [, startHour, startMinute, endHour, endMinute] = match;
  if ([startHour, endHour].some((hour) => Number(hour) > 23)
    || [startMinute, endMinute].some((minute) => Number(minute) > 59)) return null;
  return trimmed;
}

export function normalizeProtectedBranches(value: string): string | null {
  if (!value.trim()) return '';
  const branches = value.split(',').map((branch) => branch.trim());
  if (branches.some((branch) => !branch || branch.includes('\n') || branch.includes('\r'))) return null;
  return branches.join(', ');
}
