import type { BriefingDirectiveItem, BriefingResponseValue } from '../../api';

export const BRIEFING_DRAFT_VERSION = 1;
export const BRIEFING_DRAFT_KEY_PREFIX = 'mandible.briefing.draft:v1';

export type BriefingDraft = Record<string, BriefingResponseValue | null>;

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function normalizeValue(value: unknown, item: BriefingDirectiveItem): BriefingResponseValue | null | undefined {
  if (value === null) return null;
  const row = record(value);
  const type = item.revision.response_type;
  if (type === 'verdict') {
    return row.verdict === 'keep' || row.verdict === 'dismiss' ? { verdict: row.verdict } : undefined;
  }
  if (type === 'free_text') return typeof row.text === 'string' ? { text: row.text } : undefined;
  const keys = new Set(item.revision.options.map((option) => option.option_key));
  if (type === 'single_choice') {
    return typeof row.option_key === 'string' && keys.has(row.option_key)
      ? { option_key: row.option_key }
      : undefined;
  }
  if (type === 'multi_choice' && Array.isArray(row.option_keys)) {
    const selected = new Set(row.option_keys.filter((key): key is string => typeof key === 'string' && keys.has(key)));
    return {
      option_keys: item.revision.options
        .map((option) => option.option_key)
        .filter((key) => selected.has(key)),
    };
  }
  return undefined;
}

export function briefingDraftStorageKey(userId: string, roundScope: string): string {
  return `${BRIEFING_DRAFT_KEY_PREFIX}:${encodeURIComponent(userId)}:${encodeURIComponent(roundScope)}`;
}

export function normalizeBriefingDraft(value: unknown, items: readonly BriefingDirectiveItem[]): BriefingDraft {
  const root = record(value);
  const rawAnswers = root.version === BRIEFING_DRAFT_VERSION ? record(root.answers) : root;
  const byId = new Map(items.filter((item) => item.item_kind === 'item').map((item) => [item.id, item]));
  const draft: BriefingDraft = {};
  for (const [itemId, rawValue] of Object.entries(rawAnswers)) {
    const item = byId.get(itemId);
    if (!item) continue;
    const normalized = normalizeValue(rawValue, item);
    if (normalized !== undefined) draft[itemId] = normalized;
  }
  return draft;
}

export function loadBriefingDraft(
  storage: Pick<Storage, 'getItem'> | null,
  userId: string | null,
  roundScope: string,
  items: readonly BriefingDirectiveItem[],
): BriefingDraft {
  if (!storage || !userId) return {};
  try {
    const raw = storage.getItem(briefingDraftStorageKey(userId, roundScope));
    return raw ? normalizeBriefingDraft(JSON.parse(raw), items) : {};
  } catch {
    return {};
  }
}

export function saveBriefingDraft(
  storage: Pick<Storage, 'setItem' | 'removeItem'> | null,
  userId: string | null,
  roundScope: string,
  draft: Readonly<BriefingDraft>,
): void {
  if (!storage || !userId) return;
  try {
    const key = briefingDraftStorageKey(userId, roundScope);
    if (Object.keys(draft).length === 0) storage.removeItem(key);
    else storage.setItem(key, JSON.stringify({ version: BRIEFING_DRAFT_VERSION, answers: draft }));
  } catch {
    // Disabled storage and quota failures leave the in-memory draft intact.
  }
}

export function responseValuesEqual(left: BriefingResponseValue | null, right: BriefingResponseValue | null): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function effectiveDraft(items: readonly BriefingDirectiveItem[]): BriefingDraft {
  return Object.fromEntries(items
    .filter((item) => item.item_kind === 'item')
    .map((item) => [item.id, item.effective_response?.value ?? null]));
}
