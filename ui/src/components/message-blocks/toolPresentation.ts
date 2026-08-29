export type ToolCategory =
  | 'read' | 'edit' | 'delete' | 'move' | 'search' | 'execute'
  | 'think' | 'fetch' | 'browser' | 'switch_mode' | 'mcp' | 'other';

export type ToolPresentation = {
  category: ToolCategory;
  icon: string;
  phrase: string;
  target: string;
};

const DEFINITIONS: Record<ToolCategory, { icon: string; phrase: string }> = {
  read: { icon: '↗', phrase: 'Read' },
  edit: { icon: '±', phrase: 'Edited' },
  delete: { icon: '−', phrase: 'Removed' },
  move: { icon: '→', phrase: 'Moved' },
  search: { icon: '⌕', phrase: 'Searched' },
  execute: { icon: '$', phrase: 'Ran' },
  think: { icon: '·', phrase: 'Thought' },
  fetch: { icon: '↓', phrase: 'Fetched' },
  browser: { icon: '◎', phrase: 'Browsed' },
  switch_mode: { icon: '→', phrase: 'Switched mode' },
  mcp: { icon: '◇', phrase: 'Called' },
  other: { icon: '·', phrase: 'Used' },
};

export function toolInputObject(input: Record<string, unknown> | string): Record<string, unknown> {
  if (typeof input !== 'string') return input;
  try {
    const parsed: unknown = JSON.parse(input);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function firstString(input: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = input[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

export function classifyTool(toolName: string): ToolCategory {
  const name = toolName.trim().toLowerCase();
  if (name.includes('browser') || name === 'web__run' || ['click', 'navigate', 'screenshot'].includes(name)) return 'browser';
  if (name.startsWith('mcp__') || name.includes(':mcp') || name.includes('mcp')) return 'mcp';
  if (['read', 'view', 'open'].includes(name)) return 'read';
  if (['edit', 'multiedit', 'write', 'patch', 'create', 'apply_patch'].includes(name)) return 'edit';
  if (['delete', 'remove', 'rm'].includes(name)) return 'delete';
  if (['move', 'rename', 'mv'].includes(name)) return 'move';
  if (['grep', 'glob', 'search', 'websearch', 'find'].includes(name)) return 'search';
  if (['bash', 'execute', 'run', 'shell', 'terminal', 'command', 'exec_command'].includes(name)) return 'execute';
  if (['think', 'thinking'].includes(name)) return 'think';
  if (['switch_mode', 'switchmode'].includes(name)) return 'switch_mode';
  if (['webfetch', 'fetch', 'http', 'open_url'].includes(name)) return 'fetch';
  return 'other';
}

export function toolTarget(toolName: string, inputValue: Record<string, unknown> | string): string {
  const input = toolInputObject(inputValue);
  const name = toolName.trim().toLowerCase();
  if (classifyTool(toolName) === 'browser') {
    for (const key of ['search_query', 'image_query', 'open', 'click', 'find']) {
      const rows = input[key];
      if (!Array.isArray(rows) || !rows.length || !rows[0] || typeof rows[0] !== 'object') continue;
      const first = rows[0] as Record<string, unknown>;
      const target = firstString(first, ['q', 'ref_id', 'pattern', 'url']);
      if (target) return target;
    }
    return firstString(input, ['url', 'ref_id', 'query', 'q', 'selector']);
  }
  if (['move', 'rename', 'mv'].includes(name)) {
    const from = firstString(input, ['source', 'from', 'old_path', 'file_path', 'path']);
    const to = firstString(input, ['destination', 'to', 'new_path']);
    return to ? `${from} → ${to}` : from;
  }
  if (['bash', 'execute', 'run', 'shell', 'terminal', 'command', 'exec_command'].includes(name)) {
    return firstString(input, ['description', 'cmd', 'command']);
  }
  if (['grep', 'glob', 'search', 'find'].includes(name)) {
    const query = firstString(input, ['pattern', 'query']);
    const scope = firstString(input, ['path', 'directory', 'include']);
    return scope ? `${query} in ${scope}` : query;
  }
  return firstString(input, [
    'path', 'file_path', 'target', 'pattern', 'query', 'url', 'uri',
    'ref_id', 'selector', 'description', 'command', 'cmd',
  ]);
}

export function presentTool(toolName: string, input: Record<string, unknown> | string): ToolPresentation {
  const category = classifyTool(toolName);
  const definition = DEFINITIONS[category];
  return { category, ...definition, target: toolTarget(toolName, input) };
}

export function summarizeToolRun(
  tools: ReadonlyArray<{ name: string; input: Record<string, unknown> | string }>,
): string {
  const counts = new Map<ToolCategory, number>();
  for (const tool of tools) {
    const category = classifyTool(tool.name);
    counts.set(category, (counts.get(category) ?? 0) + 1);
  }
  const labels = Array.from(counts.entries()).map(([category, count]) => {
    const phrase = DEFINITIONS[category].phrase.toLowerCase();
    return count === 1 ? phrase : `${phrase} ×${count}`;
  });
  return `${tools.length} tool calls · ${labels.join(', ')}`;
}
