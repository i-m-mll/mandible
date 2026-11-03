import { projectToolProgram } from './tool-program.js';
import { projectExecution, type ExecutionFacts } from './execution-presentation.js';
export type PresentationIcon = 'toolRead' | 'toolEdit' | 'toolWrite' | 'toolDelete' | 'toolMove' | 'toolSearch' | 'toolExecute' | 'toolJavascript' | 'history' | 'thought' | 'toolFetch' | 'toolBrowser' | 'toolSwitchMode' | 'monitor' | 'chat' | 'terminal' | 'info' | 'issues';
type IconName = PresentationIcon;

export type ToolCategory =
  | 'read' | 'edit' | 'write' | 'delete' | 'move' | 'search' | 'execute'
  | 'javascript' | 'wait' | 'think' | 'fetch' | 'browser' | 'switch_mode' | 'other';

export type ToolPresentation = {
  category: ToolCategory;
  icon: IconName;
  phrase: string;
  target: string;
  execution?: ExecutionFacts;
  operations?: ToolRunFact[];
  /** Source-hydrated ordered child headers; never retained in compact manifest facts. */
  children?: Array<{name:string;header:ToolPresentation}>;
};

const DEFINITIONS: Record<ToolCategory, { icon: IconName; phrase: string; plural: string }> = {
  read: { icon: 'toolRead', phrase: 'Read a file', plural: 'Read some files' },
  edit: { icon: 'toolEdit', phrase: 'Edited a file', plural: 'Edited some files' },
  write: { icon: 'toolWrite', phrase: 'Wrote a file', plural: 'Wrote some files' },
  delete: { icon: 'toolDelete', phrase: 'Removed a file', plural: 'Removed some files' },
  move: { icon: 'toolMove', phrase: 'Moved a file', plural: 'Moved some files' },
  search: { icon: 'toolSearch', phrase: 'Searched', plural: 'Searched several times' },
  execute: { icon: 'toolExecute', phrase: 'Ran command', plural: 'Ran several commands' },
  javascript: { icon: 'toolJavascript', phrase: 'Ran JavaScript', plural: 'Ran JavaScript several times' },
  wait: { icon: 'history', phrase: 'Waited', plural: 'Waited several times' },
  think: { icon: 'thought', phrase: 'Thought', plural: 'Thought several times' },
  fetch: { icon: 'toolFetch', phrase: 'Fetched a resource', plural: 'Fetched several resources' },
  browser: { icon: 'toolBrowser', phrase: 'Used the browser', plural: 'Used the browser several times' },
  switch_mode: { icon: 'toolSwitchMode', phrase: 'Switched mode', plural: 'Switched modes several times' },
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
  const program = projectToolProgram(toolName, inputValue, toolKind);
  const children = program?.operations.map(operation=>({name:operation.name,header:presentTool(operation.name,operation.input)}));
  if (program && !program.operations.every(operation => projectExecution(operation.name,operation.input)?.facts.kind === 'command')) {
    const facts = toolRunFacts(program.operations);
    const one = program.operations.length === 1 ? presentTool(program.operations[0].name,program.operations[0].input) : null;
    const summary=summarizeToolRunFacts(facts).join('; ');
    return {...(one ?? {category:'other',icon:facts[0]?.presentation.icon ?? 'monitor',phrase:summary.charAt(0).toUpperCase()+summary.slice(1),target:''}), operations:facts,children};
  }
  const execution = projectExecution(toolName, inputValue, toolKind);
  if (execution) {
    const command = execution.facts.kind === 'command';
    return {category: command ? 'execute' : 'javascript', icon: command ? 'toolExecute' : 'toolJavascript',
      phrase: command ? execution.operations.length === 1 ? 'Ran' : 'Ran several commands' : 'Ran JavaScript',
      target: command && execution.operations.length === 1 ? execution.operations[0].command : '', execution: execution.facts,...(children && children.length>1 ? {children} : {})};
  }
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
    return firstString(input, ['cmd', 'command'])
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

export type ToolOperationInput = {name: string; toolKind?: string; input?: Record<string, unknown> | string; execution?: ExecutionFacts; operations?: ToolRunFact[]};
export type ToolRunFact = { category: ToolCategory; presentation: ToolPresentation; count: number; names: string[] };
export function toolRunFacts(tools: readonly ToolOperationInput[]): ToolRunFact[] {
  return mergeToolRunFacts([], tools.flatMap(tool => {
    if (tool.operations) return tool.operations;
    const projected = presentTool(tool.name, tool.input, tool.toolKind);
    const execution = tool.execution ?? projected.execution;
    if (projected.operations) return projected.operations;
    const category = execution ? execution.kind === 'command' ? 'execute' : 'javascript' : projected.category;
    const presentation = {category, icon: DEFINITIONS[category].icon, phrase: category === 'other' ? projected.phrase : DEFINITIONS[category].phrase, target: '', ...(execution ? {execution} : {})};
    return [{category, presentation, count: execution?.kind === 'command' ? execution.count : 1, names: [normalizedName(tool.name)]}];
  }));
}
export function mergeToolRunFacts(left: readonly ToolRunFact[], right: readonly ToolRunFact[]): ToolRunFact[] {
  const counts = new Map(left.map(fact => [fact.category, { ...fact, names: [...fact.names] }]));
  for (const fact of right) {
    const prior = counts.get(fact.category);
    if (prior) { prior.count += fact.count; prior.names = [...new Set([...prior.names, ...fact.names])]; }
    else counts.set(fact.category, { ...fact, names: [...fact.names] });
  }
  return [...counts.values()];
}
export function summarizeToolRunFacts(facts: readonly ToolRunFact[]): string[] {
  return facts.map(({presentation,count,names}) => {
    const phrase = count === 1 ? presentation.phrase : presentation.category === 'other'
      ? names.length === 1 ? presentation.phrase + ' several times' : DEFINITIONS.other.plural
      : DEFINITIONS[presentation.category].plural;
    return phrase.charAt(0).toLowerCase() + phrase.slice(1);
  });
}
export function summarizeToolRunParts(tools: readonly ToolOperationInput[]): string[] {
  return summarizeToolRunFacts(toolRunFacts(tools));
}

export function summarizeToolRun(
  tools: readonly ToolOperationInput[],
): string {
  const labels = summarizeToolRunParts(tools);
  const summary = labels.join(', ');
  return summary.charAt(0).toUpperCase() + summary.slice(1);
}

export function toolRunIcon(
  tools: readonly ToolOperationInput[],
): IconName {
  if(tools[0]?.operations?.length) return tools[0].operations[0].presentation.icon;
  return tools[0]?.execution?.kind === 'command' ? 'toolExecute' : presentTool(tools[0]?.name ?? '', tools[0]?.input, tools[0]?.toolKind).icon;
}

/** Reconstruct shared labels from the compact operation domain. */
export function compactToolRunFacts(facts: readonly import('../conversations/conversation-index.js').OperationFacts[]): ToolRunFact[] {
  return facts.map(fact => ({ ...fact, presentation: {category:fact.category,icon:DEFINITIONS[fact.category].icon,
    phrase:fact.category === 'other' ? fact.nativeName!==undefined ? 'Used '+fact.nativeName
      : fact.otherKind==='function' ? 'Called a function' :fact.otherKind==='custom' ? 'Used a custom tool' : DEFINITIONS.other.phrase : DEFINITIONS[fact.category].phrase,target:''} }));
}
export function compactToolOperation(fact:ToolRunFact):import('../conversations/conversation-index.js').OperationFacts {
  const result:import('../conversations/conversation-index.js').OperationFacts={category:fact.category,count:fact.count,names:fact.names};
  if(fact.category!=='other')return result;
  const phrase=fact.presentation.phrase;
  if(phrase===DEFINITIONS.other.phrase)return result;
  if(phrase==='Called a function')return {...result,otherKind:'function'};
  if(phrase==='Used a custom tool')return {...result,otherKind:'custom'};
  if(phrase.startsWith('Used '))return {...result,nativeName:phrase.slice(5)};
  throw new Error('Unknown native tool operation presentation');
}
