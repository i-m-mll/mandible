import type { ToolResultContent, ToolResultContentBlock } from '../../../../src/presentation/types';
import { ActivityPayloadBox } from '../shared/ActivityPayloadBox';
import { projectToolProgram } from '../../../../src/presentation/tool-program';
import { programResults, projectToolResult, framedToolResult } from '../../../../src/presentation/tool-transport';
import { projectExecution, type ExecutionResultPresentation } from '../../../../src/presentation/execution-presentation';
import { ExecutionInput } from './ExecutionInput';
import { Icon } from '../icons/Icon';
import type { ComponentChildren } from 'preact';
import type { IconName } from '../icons/Icon';
import { useMemo } from 'preact/hooks';
import { computeDiffStats, FileEditBlock } from './FileEditBlock';
import { MessageActions } from '../shared/MessageActions';
import { OverflowFade } from '../shared/OverflowFade';
import { CompactActivityRow } from '../shared/ChatDisclosure';
import { presentTool, toolInputObject, toolTarget, type ToolCategory, type ToolPresentation } from './toolPresentation';

export type { ToolResultContent, ToolResultContentBlock } from '../../../../src/presentation/types';

export type ToolUseBlockProps = {
  toolName: string;
  toolKind?: string;
  toolUseId?: string;
  input?: Record<string, unknown> | string;
  header?: ToolPresentation;
  result?: ToolResultContentBlock | null;
  defaultExpanded?: boolean;
  expanded?: boolean;
  onExpandedChange?: (expanded: boolean, trigger?: HTMLElement) => void;
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
  headerMetadata?: ComponentChildren;
  resultPresentation?: ExecutionResultPresentation;
};

export type ToolVisualKind = ToolCategory;

export type ToolVisual = {
  kind: ToolVisualKind;
  icon: IconName;
  verb: string;
  target: string;
};

type ToolStatus = 'pending' | 'running' | 'success' | 'failed';

export function getToolVisual(toolName: string, toolKind?: string): ToolVisual {
  const presentation = presentTool(toolName, {}, toolKind);
  return { kind: presentation.category, icon: presentation.icon, verb: presentation.phrase, target: presentation.target };
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

function ResultBody({ result, commandLike, projected }: {
  result: ToolResultContentBlock;
  commandLike: boolean;
  projected: ExecutionResultPresentation;
}): JSX.Element {
  const content=projected.content ?? (!projected.decoded && Array.isArray(result.content) ? result.content : [{type:'text' as const,text:projected.text}]);
  const blocks=typeof content==='string' ? [{type:'text' as const,text:content}] : content;
  return (
    <div className={`tool-card__result${result.is_error || projected.failed ? ' tool-card__result--error' : ''}`}>
      {blocks.map((block,index)=>block.type==='text' ? (block.text ? <OverflowFade key={index} lines={10}>
        <pre className={commandLike ? 'tool-card__terminal-output' : undefined}>{commandLike ? <AnsiText text={block.text} /> : block.text}</pre>
      </OverflowFade> : null) : <img key={index} className="tool-card__image" src={`data:${block.source.media_type};base64,${block.source.data}`} alt="Tool output" />)}
      {projected.stderr && <OverflowFade lines={10}><pre className="tool-card__terminal-output ansi-red">{projected.stderr}</pre></OverflowFade>}
      {projected.wallTimeSeconds !== undefined && <small style={{display: 'block', textAlign: 'right'}}>{projected.wallTimeSeconds} s</small>}
      {result.truncated && result.omittedCharacters != null && (
        <span className="tool-card__result-note">
          {result.omittedCharacters.toLocaleString()} chars hidden
        </span>
      )}
    </div>
  );
}

function hasVisibleResult(result: ToolResultContentBlock, projected: ExecutionResultPresentation): boolean {
  const text = result.fullText ?? extractResultText(result.content);
  return Boolean(projected.decoded || text || extractImages(result.content).length > 0 || (result.truncated && result.omittedCharacters != null));
}

function JsonInputPanel({ input }: { input: Record<string, unknown> | string }): JSX.Element {
  return (
    <div className="tool-card__input">
      <OverflowFade lines={10}><pre>{formatInput(input)}</pre></OverflowFade>
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
  header,
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
  headerMetadata,
  resultPresentation,
}: ToolUseBlockProps): JSX.Element {
  const inputObj = useMemo(() => input === undefined ? {} : toolInputObject(input), [input]);
  const visual = useMemo(() => {
    const presentation = header ?? presentTool(toolName, input, toolKind);
    return { kind: presentation.category, icon: presentation.icon, verb: presentation.phrase, target: presentation.target };
  }, [toolName, input, toolKind, header]);
  const execution = useMemo(() => input === undefined ? null : projectExecution(toolName, input, toolKind), [toolName, input, toolKind]);
  const program = useMemo(() => input === undefined ? null : projectToolProgram(toolName,input,toolKind),[toolName,input,toolKind]);
  const originalResultText = result?.fullText ?? (result ? extractResultText(result.content) : '');
  const framedResult = useMemo(() => framedToolResult(originalResultText,result?.source?.toolFrame),[originalResultText,result?.source?.toolFrame]);
  const resultText = framedResult.text;
  const projectedResult = useMemo(() => resultPresentation ?? projectToolResult(execution,originalResultText,result?.source?.toolFrame,result?.presentation,program),[execution,originalResultText,result?.source?.toolFrame,result?.presentation,resultPresentation,program]);
  const operationResults = useMemo(() => program ? programResults(program,resultText) : null,[program,resultText]);
  const nestedProgram = program && (program.operations.length > 1 || !execution || execution.facts.kind !== 'command');
  const displayTarget = visual.kind==='execute' ? visual.target : leftTruncateTarget(visual.target);
  const status = result?.is_error || projectedResult.failed ? 'failed' : projectedResult.running ? 'running' : statusFor(result, statusEmoji);
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
    if (input === undefined || (detailsAvailable && (input === '' || (typeof input === 'object' && Object.keys(input).length === 0)))) {
      return <div className="tool-card__input" aria-busy="true">Loading tool input…</div>;
    }
    if (nestedProgram && program) return <>{program.operations.map((operation,index) => <ToolCard key={index}
      toolName={operation.name} input={operation.input} expanded
      result={operationResults ? {type:'tool_result',tool_use_id:'',content:operationResults[index].text,is_error:operationResults[index].failed} : null}
      resultPresentation={operationResults?.[index]} />)}</>;
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
    if (execution) return <ExecutionInput execution={execution} />;
    if (visual.kind === 'write') {
      return <WriteInputPanel input={inputObj} />;
    }
    return <JsonInputPanel input={input} />;
  }

  function renderResult(content: JSX.Element, boxed = true): JSX.Element {
    if (!result) return content;
    const source = result.source;
    const Container = boxed ? ActivityPayloadBox : 'div';
    return (
      <Container className="message-block-wrapper tool-card__result-wrapper" data-block-id={source?.blockId}>
        {content}
        <MessageActions
          blockId={source?.blockId}
          onCopy={() => { navigator.clipboard.writeText(projectedResult.text).catch(() => {}); }}
          onSelect={onToggleResultSelect}
          isSelected={resultSelected}
          selectMode={selectMode}
          onFork={onForkResult}
          onResume={onResumeResult}
          dagUuid={source?.dagUuid}
          metadata={{ timestamp: source?.timestamp }}
        />
      </Container>
    );
  }

  const summary = `${visual.verb}${displayTarget ? ` ${displayTarget}` : ''}${status === 'failed' ? ' · Failed' : status === 'running' ? ' · Running' : ''}`;
  const details = (
    <div className="tool-card__body">
      {nestedProgram ? (operationResults ? renderResult(<>{renderInputPanel()}{framedResult.wallTimeSeconds!==undefined && !operationResults.some(result=>result.wallTimeSeconds!==undefined) ? <small style={{display:'block',textAlign:'right'}}>{framedResult.wallTimeSeconds} s</small> : null}</>,false) : renderInputPanel()) : <ActivityPayloadBox className="tool-card__input-wrapper">
        {diffStats ? <div className="tool-card__diff-stats">+{diffStats.additions} / -{diffStats.deletions}</div> : null}
        {renderInputPanel()}
      </ActivityPayloadBox>}
      {result && !(nestedProgram && operationResults) && hasVisibleResult(result, projectedResult)
        ? renderResult(<ResultBody result={result} commandLike={commandLike} projected={projectedResult} />)
        : null}
    </div>
  );

  return (
    <div
      className={`tool-card${active ? ' tool-card--active' : ''}${compact ? ' tool-card--compact' : ''}`}
      data-tool={toolName}
      data-tool-kind={visual.kind}
      data-id={toolUseId}
      data-member-refs={memberRefs}
    >
      <CompactActivityRow
        icon={<Icon name={visual.icon} />}
        summary={summary}
        expandedSummary={execution?.facts.kind === 'command' && execution.facts.count === 1 ? `Ran command${status === 'failed' ? ' · Failed' : status === 'running' ? ' · Running' : ''}` : undefined}
        metadata={headerMetadata}
        memberRefs={[memberRefs, result?.source?.blockId].filter(Boolean).join(' ')}
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
