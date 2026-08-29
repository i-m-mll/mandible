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
  read: { icon: '↗', phrase: 'Read a file' },
  edit: { icon: '±', phrase: 'Edited a file' },
  delete: { icon: '−', phrase: 'Removed a file' },
  move: { icon: '→', phrase: 'Moved a file' },
  search: { icon: '⌕', phrase: 'Searched' },
  execute: { icon: 'terminal', phrase: 'Ran a command' },
  think: { icon: '·', phrase: 'Thought' },
  fetch: { icon: '↓', phrase: 'Fetched' },
  browser: { icon: '◎', phrase: 'Used the browser' },
  switch_mode: { icon: '→', phrase: 'Switched mode' },
  mcp: { icon: '◇', phrase: 'Called a tool' },
  other: { icon: '·', phrase: 'Used a tool' },
};

const PLURAL_PHRASES: Record<ToolCategory, string> = {
  read: 'Read some files',
  edit: 'Edited some files',
  delete: 'Removed some files',
  move: 'Moved some files',
  search: 'Searched several times',
  execute: 'Ran some commands',
  think: 'Thought several times',
  fetch: 'Fetched several resources',
  browser: 'Used the browser several times',
  switch_mode: 'Switched modes several times',
  mcp: 'Called some tools',
  other: 'Used some tools',
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
  if (['bash', 'execute', 'run', 'shell', 'terminal', 'command', 'exec', 'exec_command'].includes(name)) return 'execute';
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
  if (['bash', 'execute', 'run', 'shell', 'terminal', 'command', 'exec', 'exec_command'].includes(name)) {
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
    const phrase = count === 1 ? DEFINITIONS[category].phrase : PLURAL_PHRASES[category];
    return phrase.charAt(0).toLowerCase() + phrase.slice(1);
  });
  const summary = labels.join(', ');
  return summary.charAt(0).toUpperCase() + summary.slice(1);
}
