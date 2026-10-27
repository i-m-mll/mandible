import type { IconName } from '../icons/Icon';

export type ToolCategory =
  | 'read' | 'edit' | 'write' | 'delete' | 'move' | 'search' | 'execute'
  | 'javascript' | 'wait' | 'think' | 'fetch' | 'browser' | 'switch_mode' | 'other';

export type ToolPresentation = {
  category: ToolCategory;
  icon: IconName;
  phrase: string;
  target: string;
};

const DEFINITIONS: Record<ToolCategory, { icon: IconName; phrase: string; plural: string }> = {
  read: { icon: 'toolRead', phrase: 'Read a file', plural: 'Read some files' },
  edit: { icon: 'toolEdit', phrase: 'Edited a file', plural: 'Edited some files' },
  write: { icon: 'toolWrite', phrase: 'Wrote a file', plural: 'Wrote some files' },
  delete: { icon: 'toolDelete', phrase: 'Removed a file', plural: 'Removed some files' },
  move: { icon: 'toolMove', phrase: 'Moved a file', plural: 'Moved some files' },
  search: { icon: 'toolSearch', phrase: 'Searched', plural: 'Searched several times' },
  execute: { icon: 'toolExecute', phrase: 'Ran a command', plural: 'Ran some commands' },
  javascript: { icon: 'toolJavascript', phrase: 'Ran JavaScript', plural: 'Ran JavaScript several times' },
  wait: { icon: 'history', phrase: 'Waited', plural: 'Waited several times' },
  think: { icon: 'thought', phrase: 'Thought', plural: 'Thought several times' },
  fetch: { icon: 'toolFetch', phrase: 'Fetched a resource', plural: 'Fetched several resources' },
  browser: { icon: 'toolBrowser', phrase: 'Used the browser', plural: 'Used the browser several times' },
  switch_mode: { icon: 'toolMove', phrase: 'Switched mode', plural: 'Switched modes several times' },
  other: { icon: 'monitor', phrase: 'Used a tool', plural: 'Used some tools' },
};

/** Exact provider tool names with an unambiguous user-facing operation. */
const TOOL_NAME_CATEGORIES: Readonly<Record<string, ToolCategory>> = {
  bash: 'execute',
  exec_command: 'execute',
  exec: 'other',
  read: 'read',
  edit: 'edit',
  multiedit: 'edit',
  write: 'write',
  delete: 'delete',
  move: 'move',
  grep: 'search',
  glob: 'search',
  websearch: 'search',
  webfetch: 'fetch',
  web__run: 'browser',
  mcp__github__search: 'search',
  mcp__browser__navigate: 'browser',
  js: 'javascript',
  wait: 'wait',
  think: 'think',
  thinking: 'think',
  switch_mode: 'switch_mode',
};

const TOOL_KIND_PRESENTATIONS: Readonly<Record<string, ToolPresentation>> = {
  function_call: { category: 'other', icon: 'monitor', phrase: 'Called a function', target: '' },
  custom_tool_call: { category: 'other', icon: 'monitor', phrase: 'Used a custom tool', target: '' },
  claude_tool_use: { category: 'other', icon: 'monitor', phrase: 'Used a tool', target: '' },
};

function normalizedName(value: string | undefined): string {
  return value?.trim().toLowerCase() ?? '';
}

export function classifyTool(toolName: string): ToolCategory {
  const name = normalizedName(toolName);
  return Object.hasOwn(TOOL_NAME_CATEGORIES, name) ? TOOL_NAME_CATEGORIES[name] : 'other';
}

/** Classification uses provider metadata; targets use only fields defined by exact known names. */
export function presentTool(
  toolName: string,
  inputValue: Record<string, unknown> | string = {},
  toolKind?: string,
): ToolPresentation {
  const normalizedToolName = normalizedName(toolName);
  const normalizedToolKind = normalizedName(toolKind);
  const category = Object.hasOwn(TOOL_NAME_CATEGORIES, normalizedToolName)
    ? TOOL_NAME_CATEGORIES[normalizedToolName]
    : undefined;
  if (category) {
    const definition = DEFINITIONS[category];
    return {
      category,
      icon: definition.icon,
      phrase: category === 'other' ? 'Used ' + toolName.trim() : definition.phrase,
      target: toolTarget(toolName, inputValue),
    };
  }

  if (normalizedToolName && normalizedToolName !== 'tool' && normalizedToolName !== normalizedToolKind) {
    return {
      category: 'other',
      icon: DEFINITIONS.other.icon,
      phrase: 'Used ' + toolName.trim(),
      target: '',
    };
  }

  const byKind = Object.hasOwn(TOOL_KIND_PRESENTATIONS, normalizedToolKind)
    ? TOOL_KIND_PRESENTATIONS[normalizedToolKind]
    : undefined;
  return byKind ?? {
    category: 'other',
    icon: DEFINITIONS.other.icon,
    phrase: DEFINITIONS.other.phrase,
    target: '',
  };
}

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

function firstString(input: Record<string, unknown>, keys: readonly string[]): string {
  for (const key of keys) {
    const value = input[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

/** Show a target only after the explicit tool name identifies what it means. */
export function toolTarget(toolName: string, inputValue: Record<string, unknown> | string): string {
  const category = classifyTool(toolName);
  const input = toolInputObject(inputValue);
  if (category === 'browser') {
    for (const key of ['search_query', 'image_query', 'open', 'click', 'find']) {
      const rows = input[key];
      if (!Array.isArray(rows) || !rows.length || !rows[0] || typeof rows[0] !== 'object') continue;
      const target = firstString(rows[0] as Record<string, unknown>, ['q', 'ref_id', 'pattern', 'url']);
      if (target) return target;
    }
    return firstString(input, ['url', 'ref_id', 'query', 'q']);
  }
  if (category === 'move') {
    const from = firstString(input, ['source', 'from', 'old_path', 'file_path', 'path']);
    const to = firstString(input, ['destination', 'to', 'new_path']);
    return to ? (from ? from + ' → ' : '') + to : from;
  }
  if (category === 'execute') {
    return firstString(input, ['description', 'cmd', 'command'])
      || (typeof inputValue === 'string' ? inputValue.trim() : '');
  }
  if (category === 'read' || category === 'edit' || category === 'write' || category === 'delete') {
    return firstString(input, ['file_path', 'path']);
  }
  if (category === 'search') return firstString(input, ['pattern', 'query']);
  if (category === 'fetch') return firstString(input, ['url', 'uri']);
  if (category === 'switch_mode') return firstString(input, ['mode']);
  return '';
}

export function summarizeToolRunParts(
  tools: ReadonlyArray<{ name: string; toolKind?: string }>,
): string[] {
  const counts = new Map<string, { presentation: ToolPresentation; count: number; names: Set<string> }>();
  for (const tool of tools) {
    const presentation = presentTool(tool.name, {}, tool.toolKind);
    const category = classifyTool(tool.name);
    const key = category;
    const existing = counts.get(key);
    if (existing) {
      existing.count += 1;
      if (category === 'other') existing.names.add(normalizedName(tool.name));
    } else {
      counts.set(key, {
        presentation,
        count: 1,
        names: new Set([normalizedName(tool.name)]),
      });
    }
  }

  return Array.from(counts.values()).map(({ presentation, count, names }) => {
    const phrase = count === 1
      ? presentation.phrase
      : presentation.category === 'other'
        ? names.size === 1 ? presentation.phrase + ' several times' : DEFINITIONS.other.plural
        : DEFINITIONS[presentation.category].plural;
    return phrase.charAt(0).toLowerCase() + phrase.slice(1);
  });
}

export function summarizeToolRun(
  tools: ReadonlyArray<{ name: string; toolKind?: string }>,
): string {
  const labels = summarizeToolRunParts(tools);
  const summary = labels.join(', ');
  return summary.charAt(0).toUpperCase() + summary.slice(1);
}

export function toolRunIcon(
  tools: ReadonlyArray<{ name: string; toolKind?: string }>,
): IconName {
  return presentTool(tools[0]?.name ?? '', {}, tools[0]?.toolKind).icon;
}
