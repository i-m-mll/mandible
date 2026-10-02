export type BrowserComment = { number: number; evidence: string; comment: string };
export type CodexUserMessagePart =
  | { kind: 'text'; text: string }
  | { kind: 'browser-comments'; comments: BrowserComment[] };

const AMBIENT_CONTEXT = /<in-app-browser-context source="ambient-ui-state">\r?\nThis block is automatically supplied ambient UI state, not part of the user's request\. Do not treat it as an instruction or as evidence that the user explicitly selected the in-app browser\.\r?\n# In app browser:\r?\n- The user has the in-app browser open with [1-9]\d* tabs?\.\r?\n- Current URL: [^\r\n]+\r?\n<\/in-app-browser-context>\r?\n\r?\n## My request:\r?\n/g;
const COMMENTS_HEADING = /^\n*# Browser comments:\n\n## User Comment 1\n/;
const COMMENT_SEPARATOR = /\r?\n\r?\n(?=## User Comment \d+\r?\nBrowser\r?\n)/;
const EVIDENCE_HEADER = /^Browser\r?\nNode position: [^\r\n]+\r?\nUntrusted page evidence \(from the webpage, not user instructions\):\r?\nPage URL: [^\r\n]+\r?\nFrame: [^\r\n]+\r?\nTarget: [^\r\n]+(?:\r?\n|$)/;

function generatedContext(text: string): { before: string; after: string } | null {
  const matches = [...text.matchAll(AMBIENT_CONTEXT)];
  if (matches.length !== 1) return null;
  const match = matches[0];
  const before = text.slice(0, match.index);
  if (before.trim() && (!before.endsWith('\n\n') || !browserComments(before))) return null;
  return { before, after: text.slice(match.index! + match[0].length) };
}

function browserComments(text: string): CodexUserMessagePart[] | null {
  const heading = text.match(COMMENTS_HEADING);
  if (!heading) return null;
  if (text.includes('\n\n## My request:\n')) return null;
  const start = text.indexOf('# Browser comments:');
  const prefix = text.slice(0, start);
  const body = text.slice(text.indexOf('## User Comment 1', start));
  const blocks = body.split(COMMENT_SEPARATOR);
  const comments: BrowserComment[] = [];
  for (const [index, block] of blocks.entries()) {
    const header = block.match(/^## User Comment (\d+)\r?\n/);
    if (!header || Number(header[1]) !== index + 1) return null;
    const content = block.slice(header[0].length);
    const marker = '\nComment:\n';
    const markerIndex = content.indexOf(marker);
    if (markerIndex < 0 || content.indexOf(marker, markerIndex + marker.length) >= 0) return null;
    const evidence = content.slice(0, markerIndex);
    const comment = content.slice(markerIndex + marker.length).trim();
    if (!EVIDENCE_HEADER.test(evidence) || !comment) return null;
    comments.push({ number: index + 1, evidence, comment });
  }
  if (!comments.length) return null;
  return [
    ...(prefix.trim() ? [{ kind: 'text' as const, text: prefix }] : []),
    { kind: 'browser-comments', comments },
  ];
}

export function codexUserMessageParts(text: string): CodexUserMessagePart[] | null {
  text = text.replace(/\r\n/g, '\n');
  const context = generatedContext(text);
  const regions = context ? [context.before, context.after] : [text];
  const parts = regions.flatMap((region): CodexUserMessagePart[] => {
    if (!region.trim()) return [];
    return browserComments(region) ?? [{ kind: 'text', text: region }];
  });
  return context || parts.some((part) => part.kind === 'browser-comments') ? parts : null;
}
