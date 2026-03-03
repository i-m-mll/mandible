// Bug: aa35aeb — Console tab renderer: markdown text block

import { useMemo } from 'preact/hooks';
import { marked } from 'marked';
import type { TextBlockProps } from './types';

// Configure marked to be synchronous
marked.setOptions({ async: false });

export function TextBlock({ text }: TextBlockProps): JSX.Element {
  const html = useMemo(() => {
    try {
      const result = marked.parse(text);
      // marked.parse returns string | Promise<string>; we configured async: false
      if (typeof result === 'string') {
        return result;
      }
      return text;
    } catch {
      return text;
    }
  }, [text]);

  return (
    <div
      className="stream-text-block"
      // eslint-disable-next-line react/no-danger
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
