const INTERACTIVE = 'a,button,input,textarea,select,option,summary,[role="button"],[role="link"],[role="menuitem"],[role="tab"],[role="slider"],[role="separator"],[tabindex]:not([tabindex="-1"]),[contenteditable]:not([contenteditable="false"]),[data-native-drag-exclude]';

export function installNativeTopBarDragging(root: Document, startDrag: () => Promise<void>): () => void {
  const down = (event: MouseEvent) => {
    const target = event.target instanceof Element ? event.target : null;
    if (event.defaultPrevented || event.button !== 0 || !target?.closest('[data-native-drag-boundary]') || target.closest(INTERACTIVE)) return;
    event.preventDefault();
    void startDrag().catch(error => console.error('Failed to drag native window:', error));
  };
  root.addEventListener('mousedown', down);
  return () => root.removeEventListener('mousedown', down);
}
