// Bug: aa35aeb — Console tab renderer: diff view for Edit tool calls

import { useMemo } from 'preact/hooks';
import type { FileEditBlockProps } from './types';

// diff2html bundles its own CSS (imported in style.css via @import)
// We import the JS API here.
import { html as diff2htmlHtml } from 'diff2html';

/**
 * Generate a minimal unified diff string from two string values.
 * We split on newlines and produce a standard unified diff header + hunks.
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
      // diff2html output is safe HTML generated from our own diff string
      dangerouslySetInnerHTML={{ __html: diffHtml }}
    />
  );
}
