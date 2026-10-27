import { navigateAppHash } from '../app-history';
import type { ComponentChildren } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import type { ChatEntityClickAction } from '../../../src/contracts';
import {
  previewableResourceFromAnchor,
  type PreviewableResourceRef,
} from '../resource-refs';
import { useAnchoredMenu } from '../hooks/useAnchoredMenu';

export type ChatPreviewTarget = PreviewableResourceRef;
export type ChatPreviewTargetResolver = (anchor: HTMLAnchorElement) => ChatPreviewTarget | null;

type LinkMenu = {
  target: ChatPreviewTarget;
};

export function chatEntityLinkAction(
  defaultAction: ChatEntityClickAction,
  platform: 'mac' | 'other',
  modifiers: { metaKey: boolean; ctrlKey: boolean },
): ChatEntityClickAction {
  const alternate = platform === 'mac' ? modifiers.metaKey : modifiers.ctrlKey;
  if (!alternate) return defaultAction;
  return defaultAction === 'preview' ? 'open' : 'preview';
}

export function currentChatPlatform(navigatorValue: Navigator = navigator): 'mac' | 'other' {
  const platform = navigatorValue.platform || navigatorValue.userAgent;
  return /mac|iphone|ipad|ipod/i.test(platform) ? 'mac' : 'other';
}

export function openChatEntityNormally(target: ChatPreviewTarget): void {
  const url = new URL(target.href, window.location.href);
  if (url.origin === window.location.origin && url.hash) {
    navigateAppHash(url.hash);
    return;
  }
  window.location.assign(url.href);
}

export function ChatEntityLinkBoundary({
  children,
  defaultAction,
  onPreview,
  resolveTarget = previewableResourceFromAnchor,
  onOpenNormally = openChatEntityNormally,
}: {
  children: ComponentChildren;
  defaultAction: ChatEntityClickAction | null;
  onPreview: (target: ChatPreviewTarget) => void;
  resolveTarget?: ChatPreviewTargetResolver;
  onOpenNormally?: (target: ChatPreviewTarget) => void;
}): JSX.Element {
  const [menu, setMenu] = useState<LinkMenu | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const anchorRef = useRef<HTMLAnchorElement>(null);
  const menuStyle = useAnchoredMenu({
    open: menu !== null,
    anchorRef,
    menuRef,
    focusRef: anchorRef,
    onDismiss: () => setMenu(null),
    placement: 'bottom-start',
  });

  useEffect(() => {
    if (!menu) return undefined;
    menuRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus();
    return undefined;
  }, [menu]);

  const anchorFromEvent = (event: Event): HTMLAnchorElement | null => {
    const target = event.target as Element | null;
    return target?.closest?.('a[href]') as HTMLAnchorElement | null;
  };

  const openMenu = (anchor: HTMLAnchorElement, target: ChatPreviewTarget) => {
    anchorRef.current = anchor;
    setMenu({ target });
  };

  return (
    <div
      className="chat-entity-link-boundary"
      onClickCapture={(event) => {
        if (!defaultAction) return;
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
        if (!defaultAction) return;
        const anchor = anchorFromEvent(event);
        const target = anchor ? resolveTarget(anchor) : null;
        if (!target) return;
        event.preventDefault();
        openMenu(anchor!, target);
      }}
      onKeyDownCapture={(event) => {
        if (!defaultAction) return;
        if (!(event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey))) return;
        const anchor = anchorFromEvent(event);
        const target = anchor ? resolveTarget(anchor) : null;
        if (!target || !anchor) return;
        event.preventDefault();
        openMenu(anchor, target);
      }}
    >
      {children}
      {menu ? (
        <div
          ref={menuRef}
          className="chat-entity-link-menu app-anchored-menu"
          role="menu"
          popover="manual"
          aria-label={`Actions for ${menu.target.label}`}
          style={menuStyle}
        >
          <button type="button" role="menuitem" onClick={() => { onPreview(menu.target); setMenu(null); }}>
            Preview in sidebar
          </button>
          <button type="button" role="menuitem" onClick={() => { onOpenNormally(menu.target); setMenu(null); }}>
            Open normally
          </button>
        </div>
      ) : null}
    </div>
  );
}
