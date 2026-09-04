import type { ComponentChildren } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import type { ChatEntityClickAction } from '../../../src/contracts';
import {
  chatEntityLinkAction,
  currentChatPlatform,
  issuePreviewTargetFromAnchor,
  type ChatPreviewTarget,
  type ChatPreviewTargetResolver,
} from './chatEntityLinks';

type LinkMenu = {
  target: ChatPreviewTarget;
  left: number;
  top: number;
};

export function openChatEntityNormally(target: ChatPreviewTarget): void {
  const url = new URL(target.href, window.location.href);
  if (url.origin === window.location.origin && url.hash) {
    window.location.hash = url.hash;
    return;
  }
  window.location.assign(url.href);
}

export function ChatEntityLinkBoundary({
  children,
  defaultAction,
  onPreview,
  resolveTarget = issuePreviewTargetFromAnchor,
  onOpenNormally = openChatEntityNormally,
}: {
  children: ComponentChildren;
  defaultAction: ChatEntityClickAction;
  onPreview: (target: ChatPreviewTarget) => void;
  resolveTarget?: ChatPreviewTargetResolver;
  onOpenNormally?: (target: ChatPreviewTarget) => void;
}): JSX.Element {
  const [menu, setMenu] = useState<LinkMenu | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menu) return undefined;
    menuRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus();
    const close = (event: MouseEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setMenu(null);
    };
    window.addEventListener('mousedown', close);
    return () => window.removeEventListener('mousedown', close);
  }, [menu]);

  const anchorFromEvent = (event: Event): HTMLAnchorElement | null => {
    const target = event.target as Element | null;
    return target?.closest?.('a[href]') as HTMLAnchorElement | null;
  };

  const openMenu = (target: ChatPreviewTarget, left: number, top: number) => {
    setMenu({ target, left, top });
  };

  return (
    <div
      className="chat-entity-link-boundary"
      onClickCapture={(event) => {
        if (event.button !== 0) return;
        const anchor = anchorFromEvent(event);
        const target = anchor ? resolveTarget(anchor) : null;
        if (!target) return;
        const action = chatEntityLinkAction(defaultAction, currentChatPlatform(), event);
        if (action === 'preview') {
          event.preventDefault();
          event.stopPropagation();
          onPreview(target);
        }
      }}
      onContextMenuCapture={(event) => {
        const anchor = anchorFromEvent(event);
        const target = anchor ? resolveTarget(anchor) : null;
        if (!target) return;
        event.preventDefault();
        openMenu(target, event.clientX, event.clientY);
      }}
      onKeyDownCapture={(event) => {
        if (!(event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey))) return;
        const anchor = anchorFromEvent(event);
        const target = anchor ? resolveTarget(anchor) : null;
        if (!target || !anchor) return;
        event.preventDefault();
        const bounds = anchor.getBoundingClientRect();
        openMenu(target, bounds.left, bounds.bottom);
      }}
    >
      {children}
      {menu ? (
        <div
          ref={menuRef}
          className="chat-entity-link-menu"
          role="menu"
          aria-label={`Actions for ${menu.target.label}`}
          style={{ left: `${menu.left}px`, top: `${menu.top}px` }}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.preventDefault();
              setMenu(null);
            }
          }}
        >
          <button type="button" role="menuitem" onClick={() => { onPreview(menu.target); setMenu(null); }}>
            Preview in footer
          </button>
          <button type="button" role="menuitem" onClick={() => { onOpenNormally(menu.target); setMenu(null); }}>
            Open normally
          </button>
        </div>
      ) : null}
    </div>
  );
}
