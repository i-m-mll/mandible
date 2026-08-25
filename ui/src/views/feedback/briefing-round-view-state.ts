import type { BriefingDirectiveItem, BriefingDocumentProfile, BriefingResponseValue } from '../../api';

export const BRIEFING_DRAFT_VERSION = 2;
export const BRIEFING_DRAFT_KEY_PREFIX = 'mandible.briefing.draft:v2';

export type BriefingDraft = Record<string, BriefingResponseValue | null>;
export type BriefingDraftScope = {
  briefingId: string;
  roundId: string;
  artifactVersionId: string;
  profile: BriefingDocumentProfile;
};

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function exactKeys(row: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(row).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function normalizeValue(value: unknown, item: BriefingDirectiveItem): BriefingResponseValue | null | undefined {
  if (value === null) return null;
  const row = record(value);
  const type = item.revision.response_type;
  if (type === 'verdict') {
    return exactKeys(row, ['verdict']) && (row.verdict === 'keep' || row.verdict === 'dismiss') ? { verdict: row.verdict } : undefined;
  }
  if (type === 'short_text' || type === 'long_text') {
    const maximum = type === 'short_text' ? 240 : 4000;
    return exactKeys(row, ['text']) && typeof row.text === 'string' && Boolean(row.text.trim()) && row.text.length <= maximum ? { text: row.text } : undefined;
  }
  if (type === 'rating') {
    return exactKeys(row, ['rating']) && Number.isSafeInteger(row.rating) && (row.rating as number) >= 1 && (row.rating as number) <= 5
      ? { rating: row.rating as number } : undefined;
  }
  const keys = new Set(item.revision.options.map((option) => option.key));
  if (type === 'single_choice') {
    return exactKeys(row, ['option_key']) && typeof row.option_key === 'string' && keys.has(row.option_key) ? { option_key: row.option_key } : undefined;
  }
  if (type === 'multi_choice' && exactKeys(row, ['option_keys']) && Array.isArray(row.option_keys)) {
    if (row.option_keys.length === 0 || row.option_keys.some((key) => typeof key !== 'string' || !keys.has(key))) return undefined;
    const selected = new Set(row.option_keys as string[]);
    if (selected.size !== row.option_keys.length) return undefined;
    return { option_keys: item.revision.options.map((option) => option.key).filter((key) => selected.has(key)) };
  }
  return undefined;
}

export function briefingDraftStorageKey(userId: string, scope: BriefingDraftScope): string {
  const segments = [userId, scope.briefingId, scope.roundId, scope.artifactVersionId, scope.profile];
  return `${BRIEFING_DRAFT_KEY_PREFIX}:${segments.map(encodeURIComponent).join(':')}`;
}

export function normalizeBriefingDraft(value: unknown, items: readonly BriefingDirectiveItem[]): BriefingDraft {
  const root = record(value);
  if (root.version !== BRIEFING_DRAFT_VERSION) return {};
  const rawAnswers = record(root.answers);
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

export function loadBriefingDraft(storage: Pick<Storage, 'getItem'> | null, userId: string | null, scope: BriefingDraftScope, items: readonly BriefingDirectiveItem[]): BriefingDraft {
  if (!storage || !userId) return {};
  try {
    const raw = storage.getItem(briefingDraftStorageKey(userId, scope));
    return raw ? normalizeBriefingDraft(JSON.parse(raw), items) : {};
  } catch {
    return {};
  }
}

export function saveBriefingDraft(storage: Pick<Storage, 'setItem' | 'removeItem'> | null, userId: string | null, scope: BriefingDraftScope, draft: Readonly<BriefingDraft>): void {
  if (!storage || !userId) return;
  try {
    const key = briefingDraftStorageKey(userId, scope);
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
  return Object.fromEntries(items.filter((item) => item.item_kind === 'item').map((item) => [item.id, item.effective_response?.value ?? null]));
}
