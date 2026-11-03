const eventName = 'reading-layout-ready';

export function registerReadingLayoutReadiness(element: HTMLElement, settle: () => void): () => void {
  element.setAttribute('data-reading-layout-ready', '');
  element.addEventListener(eventName, settle);
  return () => { element.removeEventListener(eventName, settle); element.removeAttribute('data-reading-layout-ready'); };
}

/** Asset-dependent rendering settles before the shared service accepts exact geometry. */
export function settleReadingLayout(root: HTMLElement): void {
  for (const element of root.querySelectorAll('[data-reading-layout-ready]')) element.dispatchEvent(new Event(eventName));
}
