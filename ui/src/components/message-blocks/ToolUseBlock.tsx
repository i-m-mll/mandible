import { useMemo } from 'preact/hooks';
import { computeDiffStats, FileEditBlock } from './FileEditBlock';
import { MessageActions } from '../shared/MessageActions';
import { OverflowFade } from '../shared/OverflowFade';
import type { PersistedBlockSource } from '../stream-renderer/types';
import { CompactActivityRow } from '../shared/ChatDisclosure';
import { presentTool, toolInputObject, toolTarget, type ToolCategory } from './toolPresentation';
import { ToolActivityIcon } from './ToolActivityIcon';

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
  toolKind?: string;
  toolUseId?: string;
  input: Record<string, unknown> | string;
  result?: ToolResultContentBlock | null;
  defaultExpanded?: boolean;
  expanded?: boolean;
  onExpandedChange?: (expanded: boolean) => void;
  compact?: boolean;
  statusEmoji?: string;
  active?: boolean;
  detailsAvailable?: boolean;
  resultSelected?: boolean;
  selectMode?: boolean;
  onToggleResultSelect?: (shiftKey: boolean) => void;
  onForkResult?: () => void;
  onResumeResult?: () => void;
  memberRefs?: string;
};

export type ToolVisualKind = ToolCategory;

export type ToolVisual = {
  kind: ToolVisualKind;
  icon: string;
  verb: string;
  target: string;
};

type ToolStatus = 'pending' | 'running' | 'success' | 'failed';

export function getToolVisual(toolName: string, toolKind?: string): ToolVisual {
  const presentation = presentTool(toolName, {}, toolKind);
  return { kind: presentation.category, icon: presentation.icon, verb: presentation.phrase, target: presentation.target };
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
  return toolTarget(toolName, input);
}

export function leftTruncateTarget(target: string, maxChars = 72): string {
  if (target.length <= maxChars) return target;
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
  const text = result.fullText ?? extractResultText(result.content);
  const images = extractImages(result.content);

  return (
    <div className={`tool-card__result${result.is_error ? ' tool-card__result--error' : ''}`}>
      {text && (
        <OverflowFade lines={10}>
          <pre className={commandLike ? 'tool-card__terminal-output' : undefined}>
            {commandLike ? <AnsiText text={text} /> : text}
          </pre>
        </OverflowFade>
      )}
      {images.map((src, index) => (
        <img
          key={index}
          className="tool-card__image"
          src={`data:${src.media_type};base64,${src.data}`}
          alt="Tool output"
        />
      ))}
      {result.truncated && result.omittedCharacters != null && (
        <span className="tool-card__result-note">
          {result.omittedCharacters.toLocaleString()} chars hidden
        </span>
      )}
    </div>
  );
}

function hasVisibleResult(result: ToolResultContentBlock): boolean {
  const text = result.fullText ?? extractResultText(result.content);
  return Boolean(text || extractImages(result.content).length > 0 || (result.truncated && result.omittedCharacters != null));
}

function JsonInputPanel({ input }: { input: Record<string, unknown> | string }): JSX.Element {
  return (
    <div className="tool-card__input">
      <OverflowFade lines={10}><pre>{formatInput(input)}</pre></OverflowFade>
    </div>
  );
}

function CommandInputPanel({ input, inputObj }: {
  input: Record<string, unknown> | string;
  inputObj: Record<string, unknown>;
}): JSX.Element {
  const structuredCommand = firstString(inputObj, ['command', 'cmd', 'description']);
  const command = structuredCommand || (typeof input === 'string' ? input : JSON.stringify(inputObj, null, 2));
  return (
    <div className="tool-card__terminal">
      <OverflowFade lines={10}><pre><AnsiText text={command} /></pre></OverflowFade>
    </div>
  );
}

function WriteInputPanel({ input }: { input: Record<string, unknown> }): JSX.Element {
  const content = typeof input.content === 'string' ? input.content : JSON.stringify(input, null, 2);
  return (
    <div className="tool-card__input">
      <OverflowFade lines={10}><pre>{content}</pre></OverflowFade>
    </div>
  );
}

export function ToolCard({
  toolName,
  toolKind,
  toolUseId,
  input,
  result,
  defaultExpanded,
  expanded,
  onExpandedChange,
  compact,
  statusEmoji,
  active = false,
  detailsAvailable = false,
  resultSelected,
  selectMode,
  onToggleResultSelect,
  onForkResult,
  onResumeResult,
  memberRefs,
}: ToolUseBlockProps): JSX.Element {
  const inputObj = useMemo(() => toolInputObject(input), [input]);
  const visual = useMemo(() => {
    const presentation = presentTool(toolName, input, toolKind);
    return { kind: presentation.category, icon: presentation.icon, verb: presentation.phrase, target: presentation.target };
  }, [toolName, input, toolKind]);
  const displayTarget = useMemo(() => leftTruncateTarget(visual.target), [visual.target]);
  const status = statusFor(result, statusEmoji);
  const commandLike = visual.kind === 'execute';
  const editLike = visual.kind === 'edit' && typeof inputObj.file_path === 'string';

  const diffStats = useMemo(() => {
    if (!editLike) return null;
    return computeDiffStats(
      typeof inputObj.old_string === 'string' ? inputObj.old_string : '',
      typeof inputObj.new_string === 'string' ? inputObj.new_string : '',
    );
  }, [editLike, inputObj]);

  function renderInputPanel(): JSX.Element {
    if (detailsAvailable && (input === '' || (typeof input === 'object' && Object.keys(input).length === 0))) {
      return <div className="tool-card__input" aria-busy="true">Loading tool input…</div>;
    }
    if (editLike) {
      return (
        <OverflowFade lines={10}>
          <FileEditBlock
            filePath={inputObj.file_path as string}
            oldString={typeof inputObj.old_string === 'string' ? inputObj.old_string : ''}
            newString={typeof inputObj.new_string === 'string' ? inputObj.new_string : ''}
          />
        </OverflowFade>
      );
    }
    if (commandLike) {
      return <CommandInputPanel input={input} inputObj={inputObj} />;
    }
    if (visual.kind === 'write') {
      return <WriteInputPanel input={inputObj} />;
    }
    return <JsonInputPanel input={input} />;
  }

  function renderResult(content: JSX.Element): JSX.Element {
    if (!result) return content;
    const source = result.source;
    return (
      <div className="message-block-wrapper tool-card__payload-box tool-card__result-wrapper" data-block-id={source?.blockId}>
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

  const summary = `${visual.verb}${displayTarget ? ` ${displayTarget}` : ''}${status === 'failed' ? ' · Failed' : ''}`;
  const details = (
    <div className="tool-card__body">
      <div className="tool-card__payload-box tool-card__input-wrapper">
        {diffStats ? <div className="tool-card__diff-stats">+{diffStats.additions} / -{diffStats.deletions}</div> : null}
        {renderInputPanel()}
      </div>
      {result && hasVisibleResult(result)
        ? renderResult(<ResultBody result={result} commandLike={commandLike} />)
        : null}
    </div>
  );

  return (
    <div
      className={`tool-card${active ? ' tool-card--active' : ''}${compact ? ' tool-card--compact' : ''}`}
      data-tool={toolName}
      data-tool-kind={visual.kind}
      data-id={toolUseId}
      data-block-id={result?.source?.blockId}
      data-member-refs={memberRefs}
    >
      <CompactActivityRow
        icon={<ToolActivityIcon icon={visual.icon} />}
        summary={summary}
        memberRefs={memberRefs}
        disclosure={{
          content: details,
          regionLabel: `${visual.verb} details`,
          defaultExpanded,
          expanded,
          onExpandedChange,
        }}
      />
    </div>
  );
}

export function ToolUseBlock(props: ToolUseBlockProps): JSX.Element {
  return <ToolCard {...props} />;
}
