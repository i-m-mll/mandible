import { Icon, type IconName } from '../icons/Icon';
export type PlanEntryStatus = 'pending' | 'in_progress' | 'completed';

export type PlanEntry = {
  text: string;
  status: PlanEntryStatus;
  priority?: string;
};

export type PlanBlockProps = {
  content: string;
};

function normalizeStatus(value: unknown): PlanEntryStatus {
  const status = String(value ?? '').toLowerCase().replace(/[-\s]/g, '_');
  if (status === 'completed' || status === 'complete' || status === 'done') {
    return 'completed';
  }
  if (status === 'in_progress' || status === 'active' || status === 'running') {
    return 'in_progress';
  }
  return 'pending';
}

function entryFromObject(value: Record<string, unknown>): PlanEntry | null {
  const text = value.text ?? value.title ?? value.content ?? value.task;
  if (typeof text !== 'string' || !text.trim()) {
    return null;
  }
  const priority = value.priority;
  return {
    text: text.trim(),
    status: normalizeStatus(value.status ?? value.state),
    priority: typeof priority === 'string' && priority.trim() ? priority.trim() : undefined,
  };
}

function parseJsonPlan(content: string): PlanEntry[] | null {
  try {
    const parsed = JSON.parse(content) as unknown;
    const entries = Array.isArray(parsed)
      ? parsed
      : parsed && typeof parsed === 'object' && Array.isArray((parsed as { entries?: unknown }).entries)
        ? (parsed as { entries: unknown[] }).entries
        : null;
    if (!entries) {
      return null;
    }
    return entries
      .map((entry) => {
        if (typeof entry === 'string') {
          return { text: entry, status: 'pending' as const };
        }
        if (entry && typeof entry === 'object') {
          return entryFromObject(entry as Record<string, unknown>);
        }
        return null;
      })
      .filter((entry): entry is PlanEntry => entry !== null);
  } catch {
    return null;
  }
}

function parseMarkdownPlan(content: string): PlanEntry[] {
  return content
    .split('\n')
    .map((line) => {
      const trimmed = line.trim();
      const checkbox = trimmed.match(/^[-*]\s+\[([ xX~>-])\]\s+(.+)$/);
      if (checkbox) {
        const marker = checkbox[1].toLowerCase();
        return {
          text: checkbox[2].trim(),
          status: marker === 'x' ? 'completed' : marker === '~' || marker === '>' ? 'in_progress' : 'pending',
        } satisfies PlanEntry;
      }
      const bullet = trimmed.match(/^[-*]\s+(.+)$/);
      if (bullet) {
        return { text: bullet[1].trim(), status: 'pending' as const };
      }
      return null;
    })
    .filter((entry): entry is PlanEntry => entry !== null);
}

export function parsePlanEntries(content: string): PlanEntry[] {
  const jsonEntries = parseJsonPlan(content);
  if (jsonEntries && jsonEntries.length > 0) {
    return jsonEntries;
  }
  const markdownEntries = parseMarkdownPlan(content);
  if (markdownEntries.length > 0) {
    return markdownEntries;
  }
  const fallback = content.trim();
  return fallback ? [{ text: fallback, status: 'pending' }] : [];
}

export function latestPlanIndex(blocks: Array<{ type: string }>): number {
  for (let index = blocks.length - 1; index >= 0; index -= 1) {
    if (blocks[index].type === 'plan') {
      return index;
    }
  }
  return -1;
}

const statusIcons = {
  completed: 'planCompleted', in_progress: 'planInProgress', pending: 'planPending',
} satisfies Record<PlanEntryStatus, IconName>;

export function PlanBlock({ content }: PlanBlockProps): JSX.Element {
  const entries = parsePlanEntries(content);
  if (entries.length === 0) {
    return <div className="plan-card">Plan updated</div>;
  }
  return (
    <section className="plan-card" aria-label="Plan">
      <div className="plan-card__header">
        <span className="plan-card__icon" aria-hidden="true"><Icon name="plan" /></span>
        <span className="plan-card__title">Plan</span>
      </div>
      <ol className="plan-card__list">
        {entries.map((entry, index) => (
          <li key={`${entry.status}-${index}-${entry.text}`} className={`plan-card__item plan-card__item--${entry.status}`}>
            <span className="plan-card__status" aria-hidden="true"><Icon name={statusIcons[entry.status]} /></span>
            <span className="plan-card__text">{entry.text}</span>
            {entry.priority && <span className="plan-card__priority">{entry.priority}</span>}
          </li>
        ))}
      </ol>
    </section>
  );
}
