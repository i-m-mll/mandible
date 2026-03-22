// Bug: aa35aeb — Console tab renderer: collapsible tool call block with result embedding

import { useMemo, useState } from 'preact/hooks';
import type { ToolResultContent, ToolResultContentBlock, ToolUseBlockProps } from './types';
import { FileEditBlock } from './FileEditBlock';

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
type ImageItem = { type: 'image'; source: ImageSource };

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
        return cmd.slice(0, 60) + (cmd.length > 60 ? '…' : '');
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

// ---- Status indicator ----

type StatusIndicatorProps = {
  pending: boolean;
  isError: boolean;
};

function StatusIndicator({ pending, isError }: StatusIndicatorProps): JSX.Element {
  if (pending) {
    return <span className="tool-use-block__status tool-use-block__status--pending" aria-label="Pending">⏳</span>;
  }
  if (isError) {
    return <span className="tool-use-block__status tool-use-block__status--error" aria-label="Error">✗</span>;
  }
  return <span className="tool-use-block__status tool-use-block__status--ok" aria-label="Done">✓</span>;
}

// ---- Result rendering ----

function ToolResult({ result }: { result: ToolResultContentBlock }): JSX.Element {
  if (result.is_error) {
    const text = extractResultText(result.content);
    return (
      <div className="tool-use-block__result tool-result--error">
        <pre>{text || '(error — no message)'}</pre>
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

// ---- Special tool renderers ----

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

// ---- Main ToolUseBlock ----

export function ToolUseBlock({
  toolName,
  toolUseId,
  input,
  result,
  defaultExpanded,
}: ToolUseBlockProps): JSX.Element {
  const hasResult = result != null;
  const isError = hasResult && (result.is_error === true);
  const isPending = !hasResult;

  // Default: expanded while pending, collapsed after result arrives
  const initialExpanded = defaultExpanded !== undefined ? defaultExpanded : isPending;
  const [expanded, setExpanded] = useState(initialExpanded);

  // Collapse once result arrives (if we were auto-expanded while pending)
  const prevHasResult = useMemo(() => hasResult, [hasResult]);
  if (hasResult && !prevHasResult && expanded && defaultExpanded === undefined) {
    // Can't call setState in render; this is handled via initial state logic.
    // The component will start expanded (pending) and we don't retroactively collapse.
    // Users can collapse manually. This matches common tool UX patterns.
  }

  const description = useMemo(() => getToolDescription(toolName, input), [toolName, input]);

  // Determine which input panel to render
  function renderInputPanel(): JSX.Element {
    if ((toolName === 'Edit' || toolName === 'MultiEdit') && typeof input.file_path === 'string') {
      const filePath = input.file_path as string;
      const oldString = typeof input.old_string === 'string' ? input.old_string : '';
      const newString = typeof input.new_string === 'string' ? input.new_string : '';
      return (
        <FileEditBlock
          filePath={filePath}
          oldString={oldString}
          newString={newString}
        />
      );
    }
    if (toolName === 'Bash') {
      return <BashInputPanel input={input} />;
    }
    if (toolName === 'Write') {
      return <WriteInputPanel input={input} />;
    }
    return <JsonInputPanel input={input} />;
  }

  return (
    <div className="tool-use-block" data-tool={toolName} data-id={toolUseId}>
      <button
        type="button"
        className="tool-use-block__header"
        onClick={() => setExpanded((prev) => !prev)}
        aria-expanded={expanded}
      >
        <span className="tool-use-block__chevron">{expanded ? '▾' : '▸'}</span>
        <span className="tool-use-block__name">{toolName}</span>
        <StatusIndicator pending={isPending} isError={isError} />
        <span className="tool-use-block__desc">{description}</span>
      </button>
      {expanded && (
        <div className="tool-use-block__body">
          {renderInputPanel()}
          {hasResult && (
            <>
              <div className="tool-use-block__divider" />
              <ToolResult result={result} />
            </>
          )}
        </div>
      )}
    </div>
  );
}
