import { useEffect, useMemo, useState } from 'preact/hooks';
import { computeDiffStats, FileEditBlock } from './FileEditBlock';
import { MessageActions } from '../shared/MessageActions';
import type { PersistedBlockSource } from '../stream-renderer/types';

export type ToolResultContent =
  | string
  | Array<{ type: 'text'; text: string }>
  | Array<{ type: 'image'; source: { type: string; media_type: string; data: string } }>;

export type ToolResultContentBlock = {
  type: 'tool_result';
  tool_use_id: string;
  content: ToolResultContent;
  is_error?: boolean;
  truncated?: boolean;
  fullText?: string;
  omittedCharacters?: number;
  source?: PersistedBlockSource;
};

export type ToolUseBlockProps = {
  toolName: string;
  toolUseId?: string;
  input: Record<string, unknown> | string;
  result?: ToolResultContentBlock | null;
  defaultExpanded?: boolean;
  expanded?: boolean;
  onExpandedChange?: (expanded: boolean) => void;
  compact?: boolean;
  statusEmoji?: string;
  resultSelected?: boolean;
  selectMode?: boolean;
  onToggleResultSelect?: (shiftKey: boolean) => void;
  onForkResult?: () => void;
  onResumeResult?: () => void;
};

export type ToolVisualKind =
  | 'read'
  | 'edit'
  | 'delete'
  | 'move'
  | 'search'
  | 'execute'
  | 'think'
  | 'fetch'
  | 'switch_mode'
  | 'mcp'
  | 'other';

export type ToolVisual = {
  kind: ToolVisualKind;
  icon: string;
  verb: string;
};

type ToolStatus = 'pending' | 'running' | 'success' | 'failed';

const RESULT_COLLAPSED_LIMIT = 900;
const INPUT_AUTO_COLLAPSE_LINES = 5;

const TOOL_VISUALS: Record<ToolVisualKind, ToolVisual> = {
  read: { kind: 'read', icon: 'R', verb: 'Read' },
  edit: { kind: 'edit', icon: 'E', verb: 'Edit' },
  delete: { kind: 'delete', icon: 'D', verb: 'Delete' },
  move: { kind: 'move', icon: 'M', verb: 'Move' },
  search: { kind: 'search', icon: 'S', verb: 'Search' },
  execute: { kind: 'execute', icon: '$', verb: 'Run' },
  think: { kind: 'think', icon: '?', verb: 'Think' },
  fetch: { kind: 'fetch', icon: 'F', verb: 'Fetch' },
  switch_mode: { kind: 'switch_mode', icon: '>', verb: 'Switch mode' },
  mcp: { kind: 'mcp', icon: 'MCP', verb: 'Use MCP tool' },
  other: { kind: 'other', icon: '*', verb: 'Use tool' },
};

function parseInput(input: Record<string, unknown> | string): Record<string, unknown> {
  if (typeof input !== 'string') {
    return input;
  }
  try {
    const parsed = JSON.parse(input);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

export function getToolVisual(toolName: string): ToolVisual {
  const normalized = toolName.trim().toLowerCase();
  if (normalized.startsWith('mcp__') || normalized.includes(':mcp') || normalized.includes('mcp')) {
    return TOOL_VISUALS.mcp;
  }
  if (['read', 'view', 'open'].includes(normalized)) return TOOL_VISUALS.read;
  if (['edit', 'multiedit', 'write', 'patch', 'create'].includes(normalized)) return TOOL_VISUALS.edit;
  if (['delete', 'remove', 'rm'].includes(normalized)) return TOOL_VISUALS.delete;
  if (['move', 'rename', 'mv'].includes(normalized)) return TOOL_VISUALS.move;
  if (['grep', 'glob', 'search', 'websearch'].includes(normalized)) return TOOL_VISUALS.search;
  if (['bash', 'execute', 'run', 'shell', 'terminal', 'command'].includes(normalized)) return TOOL_VISUALS.execute;
  if (['think', 'thinking'].includes(normalized)) return TOOL_VISUALS.think;
  if (['webfetch', 'fetch', 'http'].includes(normalized)) return TOOL_VISUALS.fetch;
  if (['switch_mode', 'switchmode'].includes(normalized)) return TOOL_VISUALS.switch_mode;
  if (
    ['read', 'edit', 'delete', 'move', 'search', 'execute', 'think', 'fetch', 'switch_mode', 'other']
      .includes(normalized)
  ) {
    return TOOL_VISUALS[normalized as ToolVisualKind];
  }
  return { ...TOOL_VISUALS.other, verb: toolName || TOOL_VISUALS.other.verb };
}

function firstString(input: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = input[key];
    if (typeof value === 'string' && value.trim()) {
      return value;
    }
  }
  return '';
}

export function getToolTarget(toolName: string, input: Record<string, unknown>): string {
  const normalized = toolName.trim().toLowerCase();
  if (['read', 'write', 'edit', 'multiedit', 'delete', 'remove'].includes(normalized)) {
    return firstString(input, ['file_path', 'path', 'target']);
  }
  if (['move', 'rename'].includes(normalized)) {
    const source = firstString(input, ['source', 'from', 'old_path', 'file_path', 'path']);
    const destination = firstString(input, ['destination', 'to', 'new_path']);
    return destination ? `${source} -> ${destination}` : source;
  }
  if (['bash', 'execute', 'run', 'shell', 'terminal', 'command'].includes(normalized)) {
    return firstString(input, ['description', 'command']);
  }
  if (['grep', 'glob', 'search'].includes(normalized)) {
    const pattern = firstString(input, ['pattern', 'query']);
    const scope = firstString(input, ['path', 'directory', 'include']);
    return scope ? `${pattern} in ${scope}` : pattern;
  }
  if (['websearch'].includes(normalized)) {
    return firstString(input, ['query']);
  }
  if (['webfetch', 'fetch', 'http'].includes(normalized)) {
    return firstString(input, ['url', 'uri']);
  }
  return firstString(input, ['path', 'file_path', 'target', 'pattern', 'query', 'url', 'command'])
    || JSON.stringify(input).slice(0, 120);
}

export function leftTruncateTarget(target: string, maxChars = 72): string {
  if (target.length <= maxChars) {
    return target;
  }
  const slashIndex = Math.max(target.lastIndexOf('/'), target.lastIndexOf('\\'));
  const filename = slashIndex >= 0 ? target.slice(slashIndex + 1) : '';
  if (filename && filename.length + 6 < maxChars) {
    const prefixLength = maxChars - filename.length - 5;
    return `...${target.slice(0, prefixLength)}/${filename}`;
  }
  return `...${target.slice(target.length - maxChars + 3)}`;
}

export function extractResultText(content: ToolResultContent): string {
  if (typeof content === 'string') {
    return content;
  }
  if (Array.isArray(content)) {
    return (content as Array<{ type: string; text?: string }>)
      .filter((item) => item.type === 'text')
      .map((item) => item.text ?? '')
      .join('\n');
  }
  return '';
}

function extractImages(content: ToolResultContent): Array<{ type: string; media_type: string; data: string }> {
  if (!Array.isArray(content)) {
    return [];
  }
  return (content as Array<{ type: string; source?: { type: string; media_type: string; data: string } }>)
    .filter((item) => item.type === 'image' && item.source)
    .map((item) => item.source as { type: string; media_type: string; data: string });
}

function countInputLines(input: Record<string, unknown> | string): number {
  const text = typeof input === 'string' ? input : JSON.stringify(input, null, 2);
  return text.split('\n').length;
}

function formatInput(input: Record<string, unknown> | string): string {
  return typeof input === 'string' ? input : JSON.stringify(input, null, 2);
}

function statusFor(result?: ToolResultContentBlock | null, statusEmoji?: string): ToolStatus {
  if (statusEmoji && /run|hourglass|⏳|…/.test(statusEmoji.toLowerCase())) {
    return 'running';
  }
  if (!result) {
    return 'pending';
  }
  return result.is_error ? 'failed' : 'success';
}

function StatusBadge({ status }: { status: ToolStatus }): JSX.Element {
  const label = status === 'pending'
    ? 'Pending'
    : status === 'running'
      ? 'Running'
      : status === 'failed'
        ? 'Failed'
        : 'Success';
  return (
    <span className={`tool-card__status tool-card__status--${status}`}>
      {label}
    </span>
  );
}

function isEditTool(toolName: string): boolean {
  const normalized = toolName.trim().toLowerCase();
  return normalized === 'edit' || normalized === 'multiedit';
}

function isCommandTool(toolName: string): boolean {
  const normalized = toolName.trim().toLowerCase();
  return ['bash', 'execute', 'run', 'shell', 'terminal', 'command'].includes(normalized);
}

function ansiClass(code: string): string | null {
  if (code === '31') return 'ansi-red';
  if (code === '32') return 'ansi-green';
  if (code === '33') return 'ansi-yellow';
  if (code === '34') return 'ansi-blue';
  if (code === '35') return 'ansi-magenta';
  if (code === '36') return 'ansi-cyan';
  if (code === '90') return 'ansi-muted';
  return null;
}

function AnsiText({ text }: { text: string }): JSX.Element {
  const parts: Array<{ text: string; className: string | null }> = [];
  const pattern = /\x1b\[([0-9;]+)m/g;
  let lastIndex = 0;
  let currentClass: string | null = null;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    if (match.index > lastIndex) {
      parts.push({ text: text.slice(lastIndex, match.index), className: currentClass });
    }
    const codes = match[1].split(';');
    currentClass = codes.includes('0') ? null : (codes.map(ansiClass).find(Boolean) ?? currentClass);
    lastIndex = pattern.lastIndex;
  }
  if (lastIndex < text.length) {
    parts.push({ text: text.slice(lastIndex), className: currentClass });
  }
  return (
    <>
      {parts.map((part, index) => (
        <span key={index} className={part.className ?? undefined}>{part.text}</span>
      ))}
    </>
  );
}

function ResultBody({ result, commandLike }: {
  result: ToolResultContentBlock;
  commandLike: boolean;
}): JSX.Element {
  const [expanded, setExpanded] = useState(false);
  const text = result.fullText ?? extractResultText(result.content);
  const images = extractImages(result.content);
  const canToggle = text.length > RESULT_COLLAPSED_LIMIT;
  const visibleText = expanded || text.length <= RESULT_COLLAPSED_LIMIT
    ? text
    : `${text.slice(0, RESULT_COLLAPSED_LIMIT)}\n...`;

  return (
    <div className={`tool-card__result${result.is_error ? ' tool-card__result--error' : ''}`}>
      {text && (
        <pre className={commandLike ? 'tool-card__terminal-output' : undefined}>
          {commandLike ? <AnsiText text={visibleText} /> : visibleText}
        </pre>
      )}
      {images.map((src, index) => (
        <img
          key={index}
          className="tool-card__image"
          src={`data:${src.media_type};base64,${src.data}`}
          alt="Tool output"
        />
      ))}
      {result.truncated && result.omittedCharacters != null && !expanded && (
        <span className="tool-card__result-note">
          {result.omittedCharacters.toLocaleString()} chars hidden
        </span>
      )}
      {canToggle && (
        <button
          type="button"
          className="tool-card__secondary-action"
          onClick={(event) => {
            event.stopPropagation();
            setExpanded((value) => !value);
          }}
        >
          {expanded ? 'Collapse output' : 'Open full'}
        </button>
      )}
    </div>
  );
}

function JsonInputPanel({ input }: { input: Record<string, unknown> | string }): JSX.Element {
  return (
    <div className="tool-card__input">
      <pre>{formatInput(input)}</pre>
    </div>
  );
}

function CommandInputPanel({ input }: { input: Record<string, unknown> }): JSX.Element {
  const command = firstString(input, ['command', 'cmd', 'description']) || JSON.stringify(input, null, 2);
  return (
    <div className="tool-card__terminal">
      <pre><AnsiText text={command} /></pre>
    </div>
  );
}

function WriteInputPanel({ input }: { input: Record<string, unknown> }): JSX.Element {
  const content = typeof input.content === 'string' ? input.content : JSON.stringify(input, null, 2);
  return (
    <div className="tool-card__input">
      <pre>{content}</pre>
    </div>
  );
}

export function ToolCard({
  toolName,
  toolUseId,
  input,
  result,
  defaultExpanded,
  expanded,
  onExpandedChange,
  compact,
  statusEmoji,
  resultSelected,
  selectMode,
  onToggleResultSelect,
  onForkResult,
  onResumeResult,
}: ToolUseBlockProps): JSX.Element {
  const inputObj = useMemo(() => parseInput(input), [input]);
  const visual = useMemo(() => getToolVisual(toolName), [toolName]);
  const target = useMemo(() => getToolTarget(toolName, inputObj), [toolName, inputObj]);
  const displayTarget = useMemo(() => leftTruncateTarget(target), [target]);
  const status = statusFor(result, statusEmoji);
  const commandLike = isCommandTool(toolName);
  const editLike = isEditTool(toolName) && typeof inputObj.file_path === 'string';
  const inputLineCount = useMemo(() => countInputLines(input), [input]);
  const initialExpanded = defaultExpanded !== undefined
    ? defaultExpanded
    : (status === 'pending' || status === 'running' || inputLineCount < INPUT_AUTO_COLLAPSE_LINES);
  const [localExpanded, setLocalExpanded] = useState(initialExpanded);
  const [userToggled, setUserToggled] = useState(false);
  const isExpanded = expanded ?? localExpanded;

  useEffect(() => {
    if (expanded !== undefined || defaultExpanded !== undefined || userToggled) {
      return;
    }
    if ((status === 'success' || status === 'failed') && inputLineCount >= INPUT_AUTO_COLLAPSE_LINES) {
      setLocalExpanded(false);
    }
  }, [defaultExpanded, expanded, inputLineCount, status, userToggled]);

  const diffStats = useMemo(() => {
    if (!editLike) return null;
    return computeDiffStats(
      typeof inputObj.old_string === 'string' ? inputObj.old_string : '',
      typeof inputObj.new_string === 'string' ? inputObj.new_string : '',
    );
  }, [editLike, inputObj]);

  const resultSummary = useMemo(() => {
    if (!result) return '';
    const text = extractResultText(result.content).replace(/\s+/g, ' ').trim();
    return text.length > 180 ? `${text.slice(0, 180)}...` : text;
  }, [result]);

  function renderInputPanel(): JSX.Element {
    if (editLike) {
      return (
        <FileEditBlock
          filePath={inputObj.file_path as string}
          oldString={typeof inputObj.old_string === 'string' ? inputObj.old_string : ''}
          newString={typeof inputObj.new_string === 'string' ? inputObj.new_string : ''}
        />
      );
    }
    if (commandLike) {
      return <CommandInputPanel input={inputObj} />;
    }
    if (toolName === 'Write') {
      return <WriteInputPanel input={inputObj} />;
    }
    return <JsonInputPanel input={input} />;
  }

  function setExpandedValue(nextExpanded: boolean): void {
    setUserToggled(true);
    if (expanded === undefined) {
      setLocalExpanded(nextExpanded);
    }
    onExpandedChange?.(nextExpanded);
  }

  function renderResult(content: JSX.Element): JSX.Element {
    if (!result) return content;
    const source = result.source;
    return (
      <div className="message-block-wrapper tool-card__result-wrapper" data-block-id={source?.blockId}>
        {content}
        <MessageActions
          onCopy={() => { navigator.clipboard.writeText(result.fullText ?? extractResultText(result.content)).catch(() => {}); }}
          onSelect={onToggleResultSelect}
          isSelected={resultSelected}
          selectMode={selectMode}
          onFork={onForkResult}
          onResume={onResumeResult}
          dagUuid={source?.dagUuid}
          metadata={{ timestamp: source?.timestamp }}
        />
      </div>
    );
  }

  return (
    <section
      className={`tool-card${isExpanded ? ' tool-card--expanded' : ' tool-card--collapsed'}${compact ? ' tool-card--compact' : ''}`}
      data-tool={toolName}
      data-tool-kind={visual.kind}
      data-id={toolUseId}
    >
      <button
        type="button"
        className="tool-card__header"
        aria-expanded={isExpanded}
        onClick={() => setExpandedValue(!isExpanded)}
      >
        <span className="tool-card__chevron">{isExpanded ? 'v' : '>'}</span>
        <span className="tool-card__icon" aria-hidden="true">{visual.icon}</span>
        <span className="tool-card__verb">{visual.verb}</span>
        {toolName !== visual.verb && (
          <span className="tool-card__tool-name">{toolName}</span>
        )}
        {target && (
          <span className="tool-card__target" title={target}>
            {displayTarget}
          </span>
        )}
        {diffStats && (
          <span className="tool-card__stat-chip">+{diffStats.additions} / -{diffStats.deletions}</span>
        )}
        {commandLike && (
          <span className="tool-card__stat-chip">
            {status === 'pending' || status === 'running' ? 'running' : result?.is_error ? 'exit failed' : 'exit ok'}
          </span>
        )}
        <StatusBadge status={status} />
      </button>
      {isExpanded ? (
        <div className="tool-card__body">
          {renderInputPanel()}
          {result && renderResult(<ResultBody result={result} commandLike={commandLike} />)}
        </div>
      ) : resultSummary ? (
        renderResult(<div className="tool-card__summary">{resultSummary}</div>)
      ) : null}
    </section>
  );
}

export function ToolUseBlock(props: ToolUseBlockProps): JSX.Element {
  return <ToolCard {...props} />;
}
