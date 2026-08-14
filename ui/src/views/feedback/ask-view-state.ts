import type { AskItem, AskResponseValue } from '../../api';

export const ASK_DRAFT_VERSION = 1;
export const ASK_DRAFT_KEY_PREFIX = 'mandible.ask.draft:v1';

export type AskDraft = Record<string, AskResponseValue | null>;

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function normalizeValue(value: unknown, item: AskItem): AskResponseValue | null | undefined {
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

export function askDraftStorageKey(userId: string, askId: string): string {
  return `${ASK_DRAFT_KEY_PREFIX}:${encodeURIComponent(userId)}:${encodeURIComponent(askId)}`;
}

export function normalizeAskDraft(value: unknown, items: readonly AskItem[]): AskDraft {
  const root = record(value);
  const rawAnswers = root.version === ASK_DRAFT_VERSION ? record(root.answers) : root;
  const byId = new Map(items.filter((item) => item.item_kind === 'item').map((item) => [item.id, item]));
  const draft: AskDraft = {};
  for (const [itemId, rawValue] of Object.entries(rawAnswers)) {
    const item = byId.get(itemId);
    if (!item) continue;
    const normalized = normalizeValue(rawValue, item);
    if (normalized !== undefined) draft[itemId] = normalized;
  }
  return draft;
}

export function loadAskDraft(
  storage: Pick<Storage, 'getItem'> | null,
  userId: string | null,
  askId: string,
  items: readonly AskItem[],
): AskDraft {
  if (!storage || !userId) return {};
  try {
    const raw = storage.getItem(askDraftStorageKey(userId, askId));
    return raw ? normalizeAskDraft(JSON.parse(raw), items) : {};
  } catch {
    return {};
  }
}

export function saveAskDraft(
  storage: Pick<Storage, 'setItem' | 'removeItem'> | null,
  userId: string | null,
  askId: string,
  draft: Readonly<AskDraft>,
): void {
  if (!storage || !userId) return;
  try {
    const key = askDraftStorageKey(userId, askId);
    if (Object.keys(draft).length === 0) storage.removeItem(key);
    else storage.setItem(key, JSON.stringify({ version: ASK_DRAFT_VERSION, answers: draft }));
  } catch {
    // Disabled storage and quota failures leave the in-memory draft intact.
  }
}

export function responseValuesEqual(left: AskResponseValue | null, right: AskResponseValue | null): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function effectiveDraft(items: readonly AskItem[]): AskDraft {
  return Object.fromEntries(items
    .filter((item) => item.item_kind === 'item')
    .map((item) => [item.id, item.effective_response?.value ?? null]));
}
