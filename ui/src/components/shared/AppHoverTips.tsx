import { createPortal } from 'preact/compat';
import { useLayoutEffect, useRef, useState } from 'preact/hooks';
import '../../styles/app-hover-tips.css';

export const APP_HOVER_TIP_DELAY_MS = 120;
export function appTip(label: string | undefined, placement: 'bottom' | 'right' = 'bottom') {
  return { 'data-app-tip': label, 'data-app-tip-placement': placement };
}

export function AppHoverTips(): JSX.Element | null {
  const [tip, setTip] = useState<{ anchor: HTMLElement; text: string } | null>(null);
  const element = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    let pending: ReturnType<typeof setTimeout> | undefined;
    let anchor: HTMLElement | null = null;
    const hide = () => { clearTimeout(pending); anchor = null; setTip(null); };
    const show = (target: EventTarget | null) => {
      const next = target instanceof Element ? target.closest<HTMLElement>('[data-app-tip]') : null;
      if (next === anchor) return;
      hide(); anchor = next;
      if (next?.dataset.appTip) pending = setTimeout(() => {
        if (next.isConnected) setTip({ anchor: next, text: next.dataset.appTip! });
      }, APP_HOVER_TIP_DELAY_MS);
    };
    const enter = (event: Event) => show(event.target);
    const leave = (event: PointerEvent | FocusEvent) => {
      if (!(event.relatedTarget instanceof Node) || !anchor?.contains(event.relatedTarget)) hide();
    };
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') hide(); };
    document.addEventListener('pointerover', enter);
    document.addEventListener('pointerout', leave);
    document.addEventListener('focusin', enter);
    document.addEventListener('focusout', leave);
    document.addEventListener('pointerdown', hide, true);
    document.addEventListener('click', hide, true);
    document.addEventListener('scroll', hide, true);
    document.addEventListener('keydown', key);
    window.addEventListener('resize', hide);
    window.addEventListener('blur', hide);
    return () => {
      hide(); document.removeEventListener('pointerover', enter); document.removeEventListener('pointerout', leave);
      document.removeEventListener('focusin', enter); document.removeEventListener('focusout', leave);
      document.removeEventListener('pointerdown', hide, true); document.removeEventListener('scroll', hide, true);
      document.removeEventListener('click', hide, true);
      document.removeEventListener('keydown', key); window.removeEventListener('resize', hide); window.removeEventListener('blur', hide);
    };
  }, []);
  useLayoutEffect(() => {
    const node = element.current;
    if (!tip || !node) return;
    const anchor = tip.anchor.getBoundingClientRect();
    const bounds = node.getBoundingClientRect();
    const right = tip.anchor.dataset.appTipPlacement === 'right';
    let left = right ? anchor.right + 8 : anchor.left + (anchor.width - bounds.width) / 2;
    let top = right ? anchor.top + (anchor.height - bounds.height) / 2 : anchor.bottom + 8;
    if (right && left + bounds.width > window.innerWidth - 8) left = anchor.left - bounds.width - 8;
    if (!right && top + bounds.height > window.innerHeight - 8) top = anchor.top - bounds.height - 8;
    node.style.left = `${Math.max(8, Math.min(left, window.innerWidth - bounds.width - 8))}px`;
    node.style.top = `${Math.max(8, Math.min(top, window.innerHeight - bounds.height - 8))}px`;
    const ids = new Set((tip.anchor.getAttribute('aria-describedby') ?? '').split(/\s+/).filter(Boolean));
    ids.add('app-hover-tip'); tip.anchor.setAttribute('aria-describedby', [...ids].join(' '));
    return () => {
      const remaining = (tip.anchor.getAttribute('aria-describedby') ?? '').split(/\s+/).filter(id => id && id !== 'app-hover-tip');
      if (remaining.length) tip.anchor.setAttribute('aria-describedby', remaining.join(' '));
      else tip.anchor.removeAttribute('aria-describedby');
    };
  }, [tip]);
  return tip ? createPortal(<div id="app-hover-tip" role="tooltip" className="app-hover-tip" ref={element}>{tip.text}</div>, document.body) : null;
}
