// SHARED COMPONENT — used by BOTH Chat (StreamRenderer) and History (conversations.tsx).
// Changes here affect BOTH views. If you modify rendering for one view,
// the other MUST update automatically because they use this same component.

// Bug: bce7370 — Diff view for Edit tool calls (moved from stream-renderer)

import { useMemo } from 'preact/hooks';

// diff2html bundles its own CSS (imported in style.css via @import)
import { html as diff2htmlHtml } from 'diff2html';

export type FileEditBlockProps = {
  filePath: string;
  oldString: string;
  newString: string;
};

/**
 * Generate a minimal unified diff string from two string values.
 */
function generateUnifiedDiff(filePath: string, oldStr: string, newStr: string): string {
  const oldLines = oldStr.split('\n');
  const newLines = newStr.split('\n');

  const header = [
    `--- a/${filePath}`,
    `+++ b/${filePath}`,
    `@@ -1,${oldLines.length} +1,${newLines.length} @@`,
  ].join('\n');

  const removals = oldLines.map((l) => `-${l}`).join('\n');
  const additions = newLines.map((l) => `+${l}`).join('\n');

  return `${header}\n${removals}\n${additions}\n`;
}

export function FileEditBlock({ filePath, oldString, newString }: FileEditBlockProps): JSX.Element {
  const diffHtml = useMemo(() => {
    try {
      const diffStr = generateUnifiedDiff(filePath, oldString, newString);
      return diff2htmlHtml(diffStr, {
        inputFormat: 'diff',
        outputFormat: 'line-by-line',
        drawFileList: false,
        matching: 'lines',
      });
    } catch {
      return null;
    }
  }, [filePath, oldString, newString]);

  if (!diffHtml) {
    return (
      <div className="file-edit-block">
        <div className="tool-use-block__input">
          <pre>
            <code>
              {`--- ${filePath} (old)\n`}
              {oldString}
              {`\n+++ ${filePath} (new)\n`}
              {newString}
            </code>
          </pre>
        </div>
      </div>
    );
  }

  return (
    <div
      className="file-edit-block"
      dangerouslySetInnerHTML={{ __html: diffHtml }}
    />
  );
}
