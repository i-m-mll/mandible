export function extractMandibleIssueRefs(message: string): string[] {
  if (!message) return [];
  const refs: string[] = [];
  const regex = /^Mandible-Issue:\s+(\S+)/gm;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(message)) !== null) {
    refs.push(match[1]);
  }
  return refs;
}
