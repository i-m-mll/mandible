import { useLayoutEffect, useState } from 'preact/hooks';

/** One visible-content paint boundary for message menus and source-owner focus. */
export function useMessagePaint(actionRoot: { current: HTMLElement | null }, menuOpen: boolean) {
  const [focused, setFocused] = useState(false);
  useLayoutEffect(() => {
    const owner = actionRoot.current?.parentElement;
    if (!owner) return;
    const sync = () => setFocused(owner.ownerDocument.activeElement === owner);
    sync(); owner.addEventListener('focusin', sync); owner.addEventListener('focusout', sync);
    return () => { owner.removeEventListener('focusin', sync); owner.removeEventListener('focusout', sync); };
  }, [actionRoot]);
  useLayoutEffect(() => {
    if (!menuOpen && !focused) return;
    const owner = actionRoot.current?.parentElement;
    const content = owner?.querySelector<HTMLElement>(':scope > .msg-text-block, :scope > .user-bubble, :scope > .instruction-message-block');
    if (!owner || !content) return;
    const paint = () => {
      const bounds = owner.getBoundingClientRect();
      const rects: DOMRect[] = [];
      if (content.matches('.msg-text-block')) {
        const walker = owner.ownerDocument.createTreeWalker(content, NodeFilter.SHOW_TEXT);
        while (walker.nextNode()) {
          if (!walker.currentNode.textContent?.trim() || walker.currentNode.parentElement?.closest('pre,table,svg')) continue;
          const range = owner.ownerDocument.createRange(); range.selectNodeContents(walker.currentNode);
          rects.push(...Array.from(range.getClientRects()));
        }
        for (const block of content.querySelectorAll('pre,table,img,video,svg,canvas,hr')) {
          const box = block.getBoundingClientRect();
          let left = box.left; let right = box.right; let top = box.top; let bottom = box.bottom;
          for (let parent = block.parentElement; parent && content.contains(parent); parent = parent.parentElement) {
            const style = getComputedStyle(parent); const clip = parent.getBoundingClientRect();
            if (style.overflowX !== 'visible') { left = Math.max(left, clip.left); right = Math.min(right, clip.right); }
            if (style.overflowY !== 'visible') { top = Math.max(top, clip.top); bottom = Math.min(bottom, clip.bottom); }
          }
          rects.push(new DOMRect(left, top, Math.max(0, right - left), Math.max(0, bottom - top)));
        }
      } else rects.push(content.getBoundingClientRect());
      const visible = rects.filter(rect => rect.width > 0 && rect.height > 0);
      if (!visible.length) return;
      const left = Math.min(...visible.map(rect => rect.left));
      const top = Math.min(...visible.map(rect => rect.top));
      const right = Math.max(...visible.map(rect => rect.right));
      const bottom = Math.max(...visible.map(rect => rect.bottom));
      owner.style.setProperty('--message-ink-left', `${left - bounds.left - owner.clientLeft}px`);
      owner.style.setProperty('--message-ink-top', `${top - bounds.top - owner.clientTop}px`);
      owner.style.setProperty('--message-ink-width', `${right - left}px`);
      owner.style.setProperty('--message-ink-height', `${bottom - top}px`);
      const text = content.matches('.msg-text-block');
      owner.dataset.messagePaint = text ? 'text' : 'surface';
      if (menuOpen) owner.dataset.messageMenuPaint = text ? 'text' : 'surface';
      if (svg && focusPaint) {
        svg.setAttribute('width', String(right - left)); svg.setAttribute('height', String(bottom - top));
        const style = getComputedStyle(owner);
        const inline = text ? parseFloat(style.getPropertyValue('--space-3')) : 0;
        const block = text ? parseFloat(style.getPropertyValue('--space-2')) : 0;
        focusPaint.setAttribute('x', String(-inline)); focusPaint.setAttribute('y', String(-block));
        focusPaint.setAttribute('width', String(right - left + 2 * inline));
        focusPaint.setAttribute('height', String(bottom - top + 2 * block));
        focusPaint.setAttribute('rx', String(parseFloat(style.getPropertyValue('--radius-chat-surface'))));
        owner.dataset.messageFocusPaint = '';
      }
    };
    const svg = focused ? owner.ownerDocument.createElementNS('http://www.w3.org/2000/svg', 'svg') : null;
    const focusPaint = svg ? owner.ownerDocument.createElementNS('http://www.w3.org/2000/svg', 'rect') : null;
    if (svg && focusPaint) {
      svg.classList.add('message-focus-paint'); svg.setAttribute('aria-hidden', 'true');
      svg.append(focusPaint); owner.append(svg);
    }
    paint();
    const observer = new ResizeObserver(paint); observer.observe(content);
    const mutations = new MutationObserver(paint); mutations.observe(content, { childList: true, characterData: true, subtree: true });
    return () => {
      observer.disconnect(); mutations.disconnect(); delete owner.dataset.messageMenuPaint; delete owner.dataset.messagePaint; delete owner.dataset.messageFocusPaint; svg?.remove();
      for (const name of ['left', 'top', 'width', 'height']) owner.style.removeProperty(`--message-ink-${name}`);
    };
  }, [menuOpen, focused, actionRoot]);
}
