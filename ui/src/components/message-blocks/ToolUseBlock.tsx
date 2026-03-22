// SHARED COMPONENT — used by BOTH Chat (StreamRenderer) and History (conversations.tsx).
// Changes here affect BOTH views. If you modify rendering for one view,
// the other MUST update automatically because they use this same component.

// Bug: bce7370 — Unified tool use renderer (full + compact modes)

import { useMemo, useState } from 'preact/hooks';
import { FileEditBlock } from './FileEditBlock';

// ---- Types ----

export type ToolResultContent =
  | string
  | Array<{ type: 'text'; text: string }>
  | Array<{ type: 'image'; source: { type: string; media_type: string; data: string } }>;

export type ToolResultContentBlock = {
  type: 'tool_result';
  tool_use_id: string;
  content: ToolResultContent;
  is_error?: boolean;
};

export type ToolUseBlockProps = {
  toolName: string;
  toolUseId?: string;
  input: Record<string, unknown> | string;
  result?: ToolResultContentBlock | null;
  defaultExpanded?: boolean;
  compact?: boolean;
  statusEmoji?: string;
};

// ---- JSON syntax highlighter (inline, no external dep) ----

function highlightJson(json: string): string {
  const escaped = json.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return escaped.replace(
    /("(\\u[a-zA-Z0-9]{4}|\\[^u]|[^\\"])*"(\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d*)?(?:[eE][+\-]?\d+)?)/g,
    (match) => {
      let cls = 'json-number';
      if (/^"/.test(match)) {
        cls = /:$/.test(match) ? 'json-key' : 'json-string';
      } else if (/true|false/.test(match)) {
        cls = 'json-boolean';
      } else if (/null/.test(match)) {
        cls = 'json-null';
      }
      return `<span class="${cls}">${match}</span>`;
    },
  );
}

// ---- Result content rendering helpers ----

function extractResultText(content: ToolResultContent): string {
  if (typeof content === 'string') {
    return content;
  }
  if (Array.isArray(content)) {
    const textItems = (content as Array<{ type: string; text?: string }>).filter(
      (item) => item.type === 'text',
    );
    if (textItems.length > 0) {
      return textItems.map((item) => item.text ?? '').join('\n');
    }
  }
  return '';
}

function hasImages(content: ToolResultContent): boolean {
  if (!Array.isArray(content)) {
    return false;
  }
  return (content as Array<{ type: string }>).some((item) => item.type === 'image');
}

type ImageSource = { type: string; media_type: string; data: string };

function extractImages(content: ToolResultContent): ImageSource[] {
  if (!Array.isArray(content)) {
    return [];
  }
  return (content as Array<{ type: string; source?: ImageSource }>)
    .filter((item) => item.type === 'image' && item.source)
    .map((item) => item.source as ImageSource);
}

// ---- Tool description helpers ----

function getToolDescription(toolName: string, input: Record<string, unknown>): string {
  switch (toolName) {
    case 'Read': {
      const p = input.file_path ?? input.path;
      return typeof p === 'string' ? p : JSON.stringify(input).slice(0, 80);
    }
    case 'Edit':
    case 'MultiEdit': {
      const p = input.file_path ?? input.path;
      return typeof p === 'string' ? p : JSON.stringify(input).slice(0, 80);
    }
    case 'Write': {
      const p = input.file_path ?? input.path;
      return typeof p === 'string' ? p : JSON.stringify(input).slice(0, 80);
    }
    case 'Bash': {
      const cmd = input.command;
      if (typeof cmd === 'string') {
        return cmd.slice(0, 60) + (cmd.length > 60 ? '\u2026' : '');
      }
      return JSON.stringify(input).slice(0, 80);
    }
    case 'Grep': {
      const pat = input.pattern;
      const path = input.path ?? input.directory;
      if (typeof pat === 'string') {
        return typeof path === 'string' ? `${pat} in ${path}` : pat;
      }
      return JSON.stringify(input).slice(0, 80);
    }
    case 'Glob': {
      const pat = input.pattern;
      return typeof pat === 'string' ? pat : JSON.stringify(input).slice(0, 80);
    }
    case 'WebSearch': {
      const q = input.query;
      return typeof q === 'string' ? q.slice(0, 60) : JSON.stringify(input).slice(0, 80);
    }
    case 'WebFetch': {
      const url = input.url;
      return typeof url === 'string' ? url.slice(0, 60) : JSON.stringify(input).slice(0, 80);
    }
    default:
      return JSON.stringify(input).slice(0, 80);
  }
}

// ---- Primary arg extractor (used in compact mode) ----

function primaryToolArg(toolName: string, input: Record<string, unknown>): string {
  const priority: string[] = (() => {
    switch (toolName) {
      case 'Read': case 'Write': case 'Edit': return ['file_path'];
      case 'Bash': return ['description', 'command'];
      case 'Grep': return ['pattern', 'path'];
      case 'Glob': return ['pattern', 'path'];
      case 'WebFetch': return ['url'];
      case 'WebSearch': return ['query'];
      default: return ['path', 'file_path', 'pattern', 'query', 'url', 'command'];
    }
  })();
  for (const key of priority) {
    if (typeof input[key] === 'string' && input[key]) {
      const val = input[key] as string;
      return val.length > 80 ? val.slice(0, 80) + '\u2026' : val;
    }
  }
  for (const v of Object.values(input)) {
    if (typeof v === 'string' && v) return v.length > 80 ? v.slice(0, 80) + '\u2026' : v;
  }
  return '';
}

// ---- Status indicator ----

type StatusIndicatorProps = {
  pending: boolean;
  isError: boolean;
  emoji?: string;
};

function StatusIndicator({ pending, isError, emoji }: StatusIndicatorProps): JSX.Element {
  if (emoji) {
    return <span className="tool-use-block__status" aria-label="Status">{emoji}</span>;
  }
  if (pending) {
    return <span className="tool-use-block__status tool-use-block__status--pending" aria-label="Pending">{'\u23F3'}</span>;
  }
  if (isError) {
    return <span className="tool-use-block__status tool-use-block__status--error" aria-label="Error">{'\u2717'}</span>;
  }
  return <span className="tool-use-block__status tool-use-block__status--ok" aria-label="Done">{'\u2713'}</span>;
}

// ---- Result rendering ----

function ToolResult({ result }: { result: ToolResultContentBlock }): JSX.Element {
  if (result.is_error) {
    const text = extractResultText(result.content);
    return (
      <div className="tool-use-block__result tool-result--error">
        <pre>{text || '(error \u2014 no message)'}</pre>
      </div>
    );
  }

  const images = hasImages(result.content) ? extractImages(result.content) : [];
  const text = extractResultText(result.content);

  return (
    <div className="tool-use-block__result">
      {text && <pre>{text}</pre>}
      {images.map((src, i) => (
        <img
          key={i}
          src={`data:${src.media_type};base64,${src.data}`}
          alt="Tool output"
          style={{ maxWidth: '100%', borderRadius: '8px', marginTop: '8px' }}
        />
      ))}
    </div>
  );
}

// ---- Special tool renderers (full mode) ----

function BashInputPanel({ input }: { input: Record<string, unknown> }): JSX.Element {
  const command = typeof input.command === 'string' ? input.command : JSON.stringify(input);
  return (
    <div className="tool-use-block__input">
      <pre><code>{command}</code></pre>
    </div>
  );
}

function WriteInputPanel({ input }: { input: Record<string, unknown> }): JSX.Element {
  const content = typeof input.content === 'string' ? input.content : JSON.stringify(input, null, 2);
  return (
    <div className="tool-use-block__input">
      <pre><code>{content}</code></pre>
    </div>
  );
}

function JsonInputPanel({ input }: { input: Record<string, unknown> }): JSX.Element {
  const jsonStr = JSON.stringify(input, null, 2);
  const highlighted = highlightJson(jsonStr);
  return (
    <div
      className="tool-use-block__input"
      dangerouslySetInnerHTML={{ __html: `<pre>${highlighted}</pre>` }}
    />
  );
}

// ---- Compact mode renderer (for History) ----

function CompactToolUseBlock({
  toolName,
  input,
  result,
  statusEmoji,
}: {
  toolName: string;
  input: Record<string, unknown> | string;
  result?: ToolResultContentBlock | null;
  statusEmoji?: string;
}): JSX.Element {
  const [expanded, setExpanded] = useState(false);
  const inputObj = typeof input === 'string' ? (() => { try { return JSON.parse(input); } catch { return {}; } })() : input;
  const primary = primaryToolArg(toolName, inputObj);
  const hasResult = result != null;
  const isError = hasResult && result.is_error === true;
  const isPending = !hasResult;

  // Result summary for compact display
  const resultSummary = useMemo(() => {
    if (!result) return null;
    const text = extractResultText(result.content);
    if (!text) return null;
    return text.length > 120 ? text.slice(0, 120) + '\u2026' : text;
  }, [result]);

  const fullContent = typeof input === 'string' ? input : JSON.stringify(input, null, 2);

  // Bug: 0a1ad82 — Click-anywhere-to-toggle for compact mode
  const handleCompactClick = (e: MouseEvent) => {
    const target = e.target as HTMLElement;
    if (expanded && target.closest('.tool-use-block--compact__body')) return;
    setExpanded((p) => !p);
  };

  return (
    <div className="tool-use-block tool-use-block--compact" data-tool={toolName} onClick={handleCompactClick} style={{ cursor: 'pointer' }}>
      <div className="tool-use-card__header">
        <StatusIndicator pending={isPending} isError={isError} emoji={statusEmoji} />
        <span className="tool-use-card__name">{toolName}</span>
        {primary && <span className="tool-use-card__arg">{primary}</span>}
        <span className="tool-use-card__expand">
          {expanded ? 'less' : 'more'}
        </span>
      </div>
      {expanded && (
        <div className="tool-use-block--compact__body">
          <pre className="block-pre tool-use-card__full">{fullContent}</pre>
          {result && (
            <>
              <div className="tool-use-block__divider" />
              <ToolResult result={result} />
            </>
          )}
        </div>
      )}
      {!expanded && resultSummary && (
        <div className="tool-use-block--compact__summary">
          <span className="tool-use-block--compact__summary-text">{resultSummary}</span>
        </div>
      )}
    </div>
  );
}

// ---- Auto-collapse threshold ----
// Bug: 0a1ad82 — Don't auto-collapse short tool uses (< N lines).
// TODO: make this threshold configurable via settings.
const TOOL_USE_AUTO_COLLAPSE_LINES = 5;

/** Count lines in the serialized tool input. */
function countInputLines(input: Record<string, unknown> | string): number {
  const text = typeof input === 'string' ? input : JSON.stringify(input, null, 2);
  return text.split('\n').length;
}

// ---- Main ToolUseBlock ----

export function ToolUseBlock({
  toolName,
  toolUseId,
  input,
  result,
  defaultExpanded,
  compact,
  statusEmoji,
}: ToolUseBlockProps): JSX.Element {
  // Compact mode delegates to a simpler renderer
  if (compact) {
    return (
      <CompactToolUseBlock
        toolName={toolName}
        input={input}
        result={result}
        statusEmoji={statusEmoji}
      />
    );
  }

  // Full mode (Chat)
  const inputObj = typeof input === 'string' ? (() => { try { return JSON.parse(input); } catch { return {}; } })() : input;
  const hasResult = result != null;
  const isError = hasResult && (result.is_error === true);
  const isPending = !hasResult;

  // Bug: 0a1ad82 — Auto-collapse threshold: short inputs stay expanded even after result
  const inputLineCount = useMemo(() => countInputLines(input), [input]);
  const isShortInput = inputLineCount < TOOL_USE_AUTO_COLLAPSE_LINES;

  // Default: expanded while pending, collapsed after result arrives (unless short)
  const initialExpanded = defaultExpanded !== undefined
    ? defaultExpanded
    : (isPending || isShortInput);
  const [expanded, setExpanded] = useState(initialExpanded);

  const description = useMemo(() => getToolDescription(toolName, inputObj), [toolName, inputObj]);

  // Bug: 0a1ad82 — First line of input for collapsed preview
  const firstInputLine = useMemo(() => {
    const text = typeof input === 'string' ? input : JSON.stringify(input, null, 2);
    const line = text.split('\n')[0] ?? '';
    return line.length > 80 ? line.slice(0, 80) + '\u2026' : line;
  }, [input]);

  // Determine which input panel to render
  function renderInputPanel(): JSX.Element {
    if ((toolName === 'Edit' || toolName === 'MultiEdit') && typeof inputObj.file_path === 'string') {
      const filePath = inputObj.file_path as string;
      const oldString = typeof inputObj.old_string === 'string' ? inputObj.old_string : '';
      const newString = typeof inputObj.new_string === 'string' ? inputObj.new_string : '';
      return (
        <FileEditBlock
          filePath={filePath}
          oldString={oldString}
          newString={newString}
        />
      );
    }
    if (toolName === 'Bash') {
      return <BashInputPanel input={inputObj} />;
    }
    if (toolName === 'Write') {
      return <WriteInputPanel input={inputObj} />;
    }
    return <JsonInputPanel input={inputObj} />;
  }

  // Bug: 0a1ad82 — Click-anywhere-to-toggle: entire block is clickable
  const handleBlockClick = (e: MouseEvent) => {
    // Don't toggle if user is selecting text or clicking interactive elements inside body
    const target = e.target as HTMLElement;
    if (expanded && target.closest('.tool-use-block__body')) return;
    setExpanded((prev) => !prev);
  };

  return (
    <div
      className={`tool-use-block${expanded ? '' : ' tool-use-block--collapsed'}`}
      data-tool={toolName}
      data-id={toolUseId}
      onClick={handleBlockClick}
      style={{ cursor: 'pointer' }}
    >
      {/* Bug: 0a1ad82 — Collapsed: two-line display (name + more, then first input line) */}
      {!expanded ? (
        <div className="tool-use-block__header" aria-expanded={false}>
          <span className="tool-use-block__chevron">{'\u25B8'}</span>
          <StatusIndicator pending={isPending} isError={isError} emoji={statusEmoji} />
          <span className="tool-use-block__name">{toolName}</span>
          <span className="tool-use-block__more">more</span>
          {firstInputLine && (
            <div className="tool-use-block__preview">{firstInputLine}</div>
          )}
        </div>
      ) : (
        <>
          <div className="tool-use-block__header" aria-expanded={true}>
            <span className="tool-use-block__chevron">{'\u25BE'}</span>
            <StatusIndicator pending={isPending} isError={isError} emoji={statusEmoji} />
            <span className="tool-use-block__name">{toolName}</span>
            <span className="tool-use-block__desc">{description}</span>
          </div>
          <div className="tool-use-block__body">
            {renderInputPanel()}
            {hasResult && (
              <>
                <div className="tool-use-block__divider" />
                <ToolResult result={result} />
              </>
            )}
          </div>
        </>
      )}
    </div>
  );
}
