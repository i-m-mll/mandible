/** Native Claude local-command envelopes, not arbitrary markup in a transcript. */
export function claudeCommandInvocation(content: string): { name: string; args: string } | null {
  const match = /^\s*<command-name>(\/[^<>\s]+)<\/command-name>\s*<command-message>[^<>]*<\/command-message>\s*<command-args>([\s\S]*?)<\/command-args>\s*$/.exec(content);
  return match ? { name: match[1], args: match[2] } : null;
}

export function claudeCommandOutput(content: string): { stream: 'stdout' | 'stderr'; summary: string; body: string } | null {
  const match = /^\s*<local-command-(stdout|stderr)>([\s\S]*)<\/local-command-\1>\s*$/.exec(content);
  if (!match) return null;
  const lines = match[2].trim().split(/\r?\n/);
  return { stream: match[1] as 'stdout' | 'stderr', summary: lines[0], body: lines.slice(1).join('\n').trim() };
}
