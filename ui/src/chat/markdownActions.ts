export function openMarkdownDocument(markdown: string): void {
  const blob = new Blob([markdown], { type: 'text/markdown;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  window.open(url, '_blank', 'noopener,noreferrer');
  window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

/** Reserve the browsing context during the user gesture while source export is pending. */
export function openMarkdownSource(markdown: Promise<string>): Promise<void> {
  const target = window.open('about:blank', '_blank');
  if (!target) return Promise.reject(new Error('The document window was blocked.'));
  target.opener = null;
  return markdown.then(content => {
    const url = URL.createObjectURL(new Blob([content], { type: 'text/markdown;charset=utf-8' }));
    target.location.replace(url);
    window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
  }, error => { target.close(); throw error; });
}
