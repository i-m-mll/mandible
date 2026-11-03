import type { ToolResultContent, ToolResultContentBlock } from '../../../../src/presentation/types';
import { toolObservation } from '../../../../src/presentation/tool-observation';
import { operationPhrase, operationState, operationResult, patchFileChanges, substantiveToolResult, threadReports, type ThreadReport } from '../../../../src/presentation/tool-operation';
import { chatRouteHref } from '../../chat/messageLinks';
import type { ToolOperationContext, ToolExecutionEvidence } from '../../../../src/parsers/types';
import { ActivityPayloadBox } from '../shared/ActivityPayloadBox';
import { ActivityEventItem } from '../shared/ActivityEventItem';
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
  operationContext?: ToolOperationContext;
  executionEvidence?: ToolExecutionEvidence;
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
  withinCollection?: boolean;
  getDisclosureExpanded?: (key:string,defaultExpanded:boolean)=>boolean;
  onDisclosureExpandedChange?: (key:string,expanded:boolean,trigger?:HTMLElement)=>void;
};

export type ToolVisualKind = ToolCategory;

export type ToolVisual = {
  kind: ToolVisualKind;
  icon: IconName;
  verb: string;
  target: string;
};

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

function formatInput(input: Record<string, unknown> | string): string {
  return typeof input === 'string' ? input : JSON.stringify(input, null, 2);
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

function ResultBody({ result, commandLike, projected, reports }: {
  reports?:ThreadReport[] | null;
  result: ToolResultContentBlock;
  commandLike: boolean;
  projected: ExecutionResultPresentation;
}): JSX.Element {
  const content=projected.content ?? (!projected.decoded && Array.isArray(result.content) ? result.content : [{type:'text' as const,text:projected.text}]);
  const blocks=typeof content==='string' ? [{type:'text' as const,text:content}] : content;
  return (
    <div className={`tool-card__result${result.is_error || projected.failed ? ' tool-card__result--error' : ''}`}>
      {reports?.length ? reports.map((report,index)=><div key={index}><a href={chatRouteHref({type:'session',id:report.threadId},window.location.hash)}>{report.threadId}</a>{report.hostId ? <small>{report.hostId}</small> : null}<OverflowFade lines={10}><pre>{report.text}</pre></OverflowFade>{report.truncated ? <span className="tool-card__result-note">Truncated{report.originalChars!==undefined ? ` · ${report.originalChars.toLocaleString()} original chars` : ''}</span> : null}</div>) : blocks.map((block,index)=>block.type==='text' ? (block.text ? <OverflowFade key={index} lines={10}>
        <pre className={commandLike ? 'tool-card__terminal-output' : undefined}>{commandLike ? <AnsiText text={block.text} /> : block.text}</pre>
      </OverflowFade> : null) : <img key={index} className="tool-card__image" src={`data:${block.source.media_type};base64,${block.source.data}`} alt="Tool output" />)}
      {projected.stderr && <OverflowFade lines={10}><pre className="tool-card__terminal-output ansi-red">{projected.stderr}</pre></OverflowFade>}
      {projected.wallTimeSeconds !== undefined && projected.wallTimeSeconds > 0 && <small style={{display: 'block', textAlign: 'right'}}>{projected.wallTimeSeconds} s</small>}
      {result.truncated && result.omittedCharacters != null && (
        <span className="tool-card__result-note">
          {result.omittedCharacters.toLocaleString()} chars hidden
        </span>
      )}
    </div>
  );
}

function hasVisibleResult(result: ToolResultContentBlock, projected: ExecutionResultPresentation): boolean {
  return substantiveToolResult(projected) || Boolean(result.truncated && result.omittedCharacters);
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
  executionEvidence,
  toolKind,
  toolUseId,
  input,
  header,
  result,
  defaultExpanded,
  expanded,
  onExpandedChange,
  compact,
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
  withinCollection = false,
  getDisclosureExpanded,
  onDisclosureExpandedChange,
}: ToolUseBlockProps): JSX.Element {
  const inputObj = useMemo(() => input === undefined ? {} : toolInputObject(input), [input]);
  const presentation = useMemo(() => header ?? presentTool(toolName,input,toolKind),[header,toolName,input,toolKind]);
  const visual = useMemo(() => {
    return { kind: presentation.category, icon: presentation.icon, verb: presentation.phrase, target: presentation.target };
  }, [presentation]);
  const execution = useMemo(() => input === undefined ? null : projectExecution(toolName, input, toolKind), [toolName, input, toolKind]);
  const program = useMemo(() => input === undefined ? null : projectToolProgram(toolName,input,toolKind),[toolName,input,toolKind]);
  const originalResultText = result?.fullText ?? (result ? extractResultText(result.content) : '');
  const framedResult = useMemo(() => framedToolResult(originalResultText,result?.source?.toolFrame),[originalResultText,result?.source?.toolFrame]);
  const resultText = framedResult.text;
  const projectedResult = useMemo(() => operationResult(presentation,resultPresentation ?? projectToolResult(execution,originalResultText,result?.source?.toolFrame,result?.presentation,program)),[presentation,execution,originalResultText,result?.source?.toolFrame,result?.presentation,resultPresentation,program]);
  const operationResults = useMemo(() => program ? programResults(program,resultText) : null,[program,resultText]);
  const projectedChildren = program && (program.operations.length > 1 || !execution || execution.facts.kind !== 'command')
    ? program.operations.map(operation=>({name:operation.name,input:operation.input,header:presentTool(operation.name,operation.input)}))
    : header?.children?.map(child=>({...child,input:undefined}));
  const nestedProgram = Boolean(projectedChildren?.length);
  const executionFacts=execution?.facts ?? header?.execution;
  const displayTarget = visual.kind==='execute' ? visual.target : leftTruncateTarget(visual.target);
  const state = operationState(executionEvidence?.state ?? result?.source?.toolExecution?.state,result ? {failed:projectedResult.failed,is_error:result.is_error} : undefined,active);
  const phrase = operationPhrase(presentation,state,projectedResult);
  const reports = presentation.operation==='thread-wait' && !projectedResult.failed ? threadReports(projectedResult.text) : null;
  const semanticInput = !['thread-read','thread-wait','sleep','tool-discovery','execution-wait'].includes(presentation.operation ?? '');
  const patch = toolName.toLowerCase()==='apply_patch' && typeof input==='string' ? patchFileChanges(input) : [];
  const commandLike = visual.kind === 'execute';
  const editLike = visual.kind === 'edit' && typeof inputObj.file_path === 'string';

  const diffStats = useMemo(() => {
    if (!editLike) return null;
    return computeDiffStats(
      typeof inputObj.old_string === 'string' ? inputObj.old_string : '',
      typeof inputObj.new_string === 'string' ? inputObj.new_string : '',
    );
  }, [editLike, inputObj]);

  function renderProgramChildren(): JSX.Element {
    return <>{projectedChildren!.map((operation,index) => {
      const key=`operation:${index}`;
      return <ToolCard key={index} toolName={operation.name} input={operation.input} header={operation.header}
        detailsAvailable={operation.input===undefined} withinCollection
        headerMetadata={withinCollection && index===projectedChildren!.length-1 ? headerMetadata : undefined}
        expanded={getDisclosureExpanded?.(key,withinCollection && Boolean(expanded))}
        onExpandedChange={(next,trigger)=>onDisclosureExpandedChange?.(key,next,trigger)}
        getDisclosureExpanded={getDisclosureExpanded ? (childKey,defaultExpanded)=>getDisclosureExpanded(`${key}:${childKey}`,defaultExpanded) : undefined}
        onDisclosureExpandedChange={onDisclosureExpandedChange ? (childKey,next,trigger)=>onDisclosureExpandedChange(`${key}:${childKey}`,next,trigger) : undefined}
        result={operationResults ? {type:'tool_result',tool_use_id:'',content:operationResults[index].text,is_error:operationResults[index].failed} : null}
        resultPresentation={operationResults?.[index]} />;
    })}</>;
  }

  function renderInputPanel(): JSX.Element {
    if (projectedChildren) return renderProgramChildren();
    if (input === undefined || (detailsAvailable && (input === '' || (typeof input === 'object' && Object.keys(input).length === 0)))) {
      return <div className="tool-card__input" aria-busy="true">Loading tool input…</div>;
    }
    if (patch.length) return <>{patch.map(file=><FileEditBlock key={file.filePath} {...file} />)}</>;
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

  const summary = `${phrase}${displayTarget ? ` ${displayTarget}` : ''}${state === 'failed' ? ' · Failed' : state === 'cancelled' ? ' · Cancelled' : ''}`;
  const collectionChildren = nestedProgram ? withinCollection ? renderInputPanel() : <div className="activity-nested-headers">{renderInputPanel()}</div> : null;
  const collectionTiming = framedResult.wallTimeSeconds !== undefined && framedResult.wallTimeSeconds > 0 && !operationResults?.some(result => result.wallTimeSeconds !== undefined)
    ? <ActivityEventItem><small style={{ display: 'block', textAlign: 'right' }}>{framedResult.wallTimeSeconds} s</small></ActivityEventItem> : null;
  const details = nestedProgram
    ? operationResults
      ? renderResult(<>{collectionChildren}{collectionTiming}</>, false)
      : <>{collectionChildren}{result && hasVisibleResult(result, projectedResult)
        ? <ActivityEventItem>{renderResult(<ResultBody result={result} commandLike={commandLike} projected={projectedResult} reports={reports} />)}</ActivityEventItem> : null}</>
    : (
    <div className="tool-card__body">
      {semanticInput && <ActivityPayloadBox className="tool-card__input-wrapper">
        {diffStats ? <div className="tool-card__diff-stats">+{diffStats.additions} / -{diffStats.deletions}</div> : null}
        {renderInputPanel()}
      </ActivityPayloadBox>}
      {result && hasVisibleResult(result, projectedResult)
        ? renderResult(<ResultBody result={result} commandLike={commandLike} projected={projectedResult} reports={reports} />)
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
      {nestedProgram && withinCollection ? details : <CompactActivityRow
        collection={nestedProgram}
        icon={<Icon name={visual.icon} />}
        summary={summary}
        expandedSummary={executionFacts?.kind === 'command' && executionFacts.count === 1 ? `${operationPhrase({...presentation,phrase:'Ran command'},state,projectedResult)}${state === 'failed' ? ' · Failed' : ''}` : undefined}
        metadata={headerMetadata}
        summaryContent={presentation.threadTargets?.length ? <>{phrase.replace(/threads?$/, '')}{presentation.threadTargets.map((target,index)=><>{index ? ', ' : ''}<a key={target.id} href={chatRouteHref(target,window.location.hash)}>thread{presentation.threadTargets!.length>1 ? ` ${target.id}` : ''}</a></>)}{state==='failed' ? ' · Failed' : state==='cancelled' ? ' · Cancelled' : ''}</> : undefined}
        memberRefs={[memberRefs, result?.source?.blockId].filter(Boolean).join(' ')}
        disclosure={semanticInput || nestedProgram || (result && hasVisibleResult(result,projectedResult)) || (detailsAvailable && presentation.hasDetails!==false) ? {
          content: details,
          regionLabel: `${operationPhrase(presentation,'unknown')} details`,
          defaultExpanded,
          expanded,
          onExpandedChange,
        } : undefined}
      />}
    </div>
  );
}

export function ToolUseBlock(props: ToolUseBlockProps): JSX.Element {
  const context=props.operationContext ?? props.result?.source?.toolOperation;
  const operationName=context?.name ?? props.toolName;
  const operationInput=context && (typeof context.input==='string' || (context.input && typeof context.input==='object' && !Array.isArray(context.input))) ? context.input as string | Record<string,unknown> : props.input;
  const operationKind=context?.kind ?? props.toolKind;
  const observation=toolObservation(operationName,operationInput,operationKind,props.result ? {text:props.result.fullText ?? extractResultText(props.result.content),content:props.result.content,frame:props.result.source?.toolFrame,native:props.result.presentation,failed:props.result.is_error} : undefined,props.header);
  return <ToolCard {...props} toolName={observation.name} toolKind={observation.kind} input={operationInput===undefined ? undefined : observation.input} header={observation.header} resultPresentation={observation.result} />;
}
