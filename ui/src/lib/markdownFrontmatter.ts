export type MarkdownFrontmatter = {
  start: number;
  end: number;
  raw: string;
  body: string;
  entries: MarkdownFrontmatterEntry[];
};

export type MarkdownFrontmatterEntry = {
  key: string;
  value: string;
};

function displayScalar(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2) {
    const first = trimmed[0];
    const last = trimmed[trimmed.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return trimmed.slice(1, -1);
    }
  }
  return trimmed;
}

function frontmatterEntries(body: string): MarkdownFrontmatterEntry[] {
  const entries: MarkdownFrontmatterEntry[] = [];
  let current: { key: string; inline: string; continuation: string[] } | null = null;
  const flush = () => {
    if (!current) return;
    const continuation = current.continuation.filter((line) => line.trim());
    const list = continuation.length > 0 && continuation.every((line) => /^\s*-\s+/.test(line));
    const nestedValue = list
      ? continuation.map((line) => displayScalar(line.replace(/^\s*-\s+/, ''))).join(', ')
      : continuation.map((line) => line.trim()).join('\n');
    entries.push({
      key: current.key,
      value: displayScalar(current.inline) || nestedValue || '—',
    });
    current = null;
  };

  for (const line of body.split(/\r?\n/)) {
    const topLevel = /^([A-Za-z0-9_.-]+)[ \t]*:[ \t]*(.*)$/.exec(line);
    if (topLevel) {
      flush();
      current = { key: topLevel[1], inline: topLevel[2], continuation: [] };
    } else if (current) {
      current.continuation.push(line);
    }
  }
  flush();
  return entries;
}

/**
 * Find one complete YAML frontmatter block at the start of a Markdown source.
 * A later thematic rule and an unterminated opening fence remain ordinary
 * Markdown. Offsets are UTF-16 source offsets, matching DOM selection and the
 * Briefing annotation contract.
 */
export function leadingMarkdownFrontmatter(source: string): MarkdownFrontmatter | null {
  const opening = /^(?:\uFEFF)?---[ \t]*(?:\r?\n)/.exec(source);
  if (!opening) return null;
  const fence = /^(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/gm;
  fence.lastIndex = opening[0].length;
  const closing = fence.exec(source);
  if (!closing) return null;
  const end = closing.index + closing[0].length;
  const body = source.slice(opening[0].length, closing.index);
  return {
    start: 0,
    end,
    raw: source.slice(0, end),
    body,
    entries: frontmatterEntries(body),
  };
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Fixed, escaped presentation used by Artifact and Briefing Markdown views. */
export function renderMarkdownFrontmatter(frontmatter: MarkdownFrontmatter): string {
  const facts = frontmatter.entries
    .map(({ key, value }) => '<div class="markdown-frontmatter__fact">'
      + `<dt>${escapeHtml(key)}</dt><dd>${escapeHtml(value)}</dd>`
      + '</div>')
    .join('');
  return '<section class="markdown-frontmatter" aria-label="Document frontmatter">'
    + '<div class="markdown-frontmatter__label">Frontmatter</div>'
    + `<dl class="markdown-frontmatter__facts">${facts}</dl>`
    + '</section>';
}
