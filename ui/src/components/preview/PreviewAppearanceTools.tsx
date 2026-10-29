import type { JSX } from 'preact';
import { useEffect, useId, useLayoutEffect, useRef, useState } from 'preact/hooks';
import type { InstanceInfo } from '../../api';
import type { ChromeAppearancePreviewController } from '../../hooks/useChromeAppearancePreview';
import { usePersistedViewState } from '../../hooks/usePersistedViewState';
import { Icon } from '../icons/Icon';
import { appTip } from '../shared/AppHoverTips';
import { DetailPaneShell } from '../shared/DetailPaneShell';
import { DetailPaneHeader } from '../shared/DetailPaneHeader';
import { OverlayCloseButton } from '../shared/OverlayCloseButton';
import { PreviewCopyNotice } from '../shared/PreviewCopyNotice';
import { ChromeAppearanceActions, ChromeAppearanceControls } from './ChromeAppearanceControls';
import { APPEARANCE_PANEL_DEFAULTS, normalizeAppearancePanelState, type PanelPoint } from './appearance-panel-state';

function useModalSuspension(): boolean {
  const [suspended, setSuspended] = useState(false);
  useLayoutEffect(() => {
    const inspect = () => setSuspended([...document.querySelectorAll<HTMLElement>('[aria-modal="true"], dialog[open]')].some(modal =>
      !modal.closest('[hidden], [inert]') && modal.getClientRects().length > 0
      && getComputedStyle(modal).visibility !== 'hidden'));
    inspect();
    const observer = new MutationObserver(inspect);
    observer.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['hidden', 'open', 'aria-modal', 'class', 'style'] });
    return () => observer.disconnect();
  }, []);
  return suspended;
}

function viewport() {
  const visible = window.visualViewport;
  return { x: visible?.offsetLeft ?? 0, y: visible?.offsetTop ?? 0, width: visible?.width ?? window.innerWidth, height: visible?.height ?? window.innerHeight };
}

export function PreviewAppearanceTools({ instance, controller }: { instance: InstanceInfo | null; controller: ChromeAppearancePreviewController | null }): JSX.Element | null {
  if (instance?.role !== 'preview' || !controller) return <PreviewCopyNotice instance={instance} />;
  return <AppearancePanel key={instance.instance_id} instance={instance} controller={controller} />;
}

function AppearancePanel({ instance, controller }: { instance: InstanceInfo; controller: ChromeAppearancePreviewController }): JSX.Element {
  const [state, setState] = usePersistedViewState(`mandible.preview-appearance-panel.v1:${instance.instance_id}`, normalizeAppearancePanelState, APPEARANCE_PANEL_DEFAULTS);
  const [position, setPosition] = useState<PanelPoint>({ x: 8, y: 8 });
  const [bounds, setBounds] = useState(viewport);
  const panelRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const moveRef = useRef<HTMLButtonElement>(null);
  const focusRequested = useRef(false);
  const drag = useRef<{ pointerId: number; start: PanelPoint; origin: PanelPoint; current: PanelPoint; handle: HTMLElement } | null>(null);
  const suspended = useModalSuspension();
  const id = useId();
  const clamp = (point: PanelPoint): PanelPoint => {
    const rect = panelRef.current?.getBoundingClientRect();
    return { x: Math.max(bounds.x + 8, Math.min(point.x, bounds.x + bounds.width - (rect?.width ?? 360) - 8)),
      y: Math.max(bounds.y + 8, Math.min(point.y, bounds.y + bounds.height - (rect?.height ?? 40) - 8)) };
  };
  const place = (point: PanelPoint) => {
    const next = clamp(point);
    setPosition(current => current.x === next.x && current.y === next.y ? current : next);
    return next;
  };
  const finishDrag = () => {
    const current = drag.current;
    if (!current) return;
    drag.current = null;
    if (current.handle.hasPointerCapture?.(current.pointerId)) current.handle.releasePointerCapture(current.pointerId);
    setState(value => ({ ...value, position: current.current }));
  };
  useEffect(() => () => {
    const current = drag.current;
    drag.current = null;
    if (current?.handle.hasPointerCapture?.(current.pointerId)) current.handle.releasePointerCapture(current.pointerId);
  }, []);
  useLayoutEffect(() => {
    const resize = () => setBounds(viewport());
    window.addEventListener('resize', resize);
    window.visualViewport?.addEventListener('resize', resize);
    window.visualViewport?.addEventListener('scroll', resize);
    return () => {
      window.removeEventListener('resize', resize);
      window.visualViewport?.removeEventListener('resize', resize);
      window.visualViewport?.removeEventListener('scroll', resize);
    };
  }, []);
  useLayoutEffect(() => {
    if (suspended || !state.open) {
      finishDrag();
      focusRequested.current = false;
      return;
    }
    const update = () => {
      if (drag.current) return;
      const trigger = triggerRef.current?.getBoundingClientRect();
      const rect = panelRef.current?.getBoundingClientRect();
      const next = place(state.position ?? { x: (trigger?.right ?? bounds.width) - (rect?.width ?? 360), y: (trigger?.top ?? bounds.height) - (rect?.height ?? 40) - 8 });
      if (!state.position) setState(current => ({ ...current, position: next }));
    };
    update();
    const observer = new ResizeObserver(update);
    if (panelRef.current) observer.observe(panelRef.current);
    if (focusRequested.current) { moveRef.current?.focus({ preventScroll: true }); focusRequested.current = false; }
    return () => observer.disconnect();
  }, [state.open, state.collapsed, state.position, bounds, suspended]);
  const close = () => {
    finishDrag();
    setState(current => ({ ...current, open: false }));
    triggerRef.current?.focus({ preventScroll: true });
  };
  const move = (point: PanelPoint) => {
    const next = place(point);
    setState(current => ({ ...current, position: next }));
  };
  const startDrag = (event: JSX.TargetedPointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0 || !event.isPrimary || drag.current) return;
    const handle = event.currentTarget;
    drag.current = { pointerId: event.pointerId, start: { x: event.clientX, y: event.clientY }, origin: position, current: position, handle };
    handle.setPointerCapture(event.pointerId);
  };
  const moveDrag = (event: JSX.TargetedPointerEvent<HTMLButtonElement>) => {
    const current = drag.current;
    if (!current || current.pointerId !== event.pointerId) return;
    current.current = place({ x: current.origin.x + event.clientX - current.start.x, y: current.origin.y + event.clientY - current.start.y });
  };
  const endDrag = (event: JSX.TargetedPointerEvent<HTMLButtonElement>) => {
    if (drag.current?.pointerId === event.pointerId) finishDrag();
  };
  const moveKeys = (event: JSX.TargetedKeyboardEvent<HTMLButtonElement>) => {
    const delta = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[event.key];
    if (!delta) return;
    event.preventDefault();
    event.stopPropagation();
    const step = event.shiftKey ? 40 : 10;
    move({ x: position.x + delta[0] * step, y: position.y + delta[1] * step });
  };
  return <>
    <PreviewCopyNotice instance={instance} action={<button ref={triggerRef} type="button" className="preview-copy-banner__appearance"
      aria-label="Preview appearance" aria-controls={id} aria-expanded={state.open} {...appTip('Preview appearance')}
      onClick={() => { if (state.open) close(); else { focusRequested.current = true; setState(current => ({ ...current, open: true })); } }}>
      <Icon name="paintbrush" size={15} />
    </button>} />
    {state.open ? <div className="preview-appearance-layer" hidden={suspended}>
      <div id={id} ref={panelRef} role="dialog" aria-modal="false" aria-label="Preview appearance" className="preview-appearance-panel" data-collapsed={state.collapsed}
        style={{ left: position.x, top: position.y, width: Math.max(0, Math.min(360, bounds.width - 16)), maxHeight: Math.max(0, bounds.height - 16) }}
        onKeyDown={event => {
          if (event.key !== 'Escape' || event.defaultPrevented || (event.target as HTMLElement).closest('select, .app-anchored-menu')) return;
          event.preventDefault(); event.stopPropagation(); close();
        }}>
        <DetailPaneShell variant="compact" headerPlacement="pane" presentation="sidebar"
          header={<DetailPaneHeader variant="compact" title={<button ref={moveRef} type="button" className="preview-appearance-panel__move"
            aria-label="Move preview appearance" {...appTip('Drag to move, or use arrow keys')}
            onPointerDown={startDrag} onPointerMove={moveDrag} onPointerUp={endDrag} onPointerCancel={endDrag} onLostPointerCapture={endDrag} onKeyDown={moveKeys}>Preview appearance</button>}
            actions={<>
              <button type="button" className="overlay-close-button" aria-label={state.collapsed ? 'Expand preview appearance' : 'Collapse preview appearance'}
                aria-expanded={!state.collapsed} onClick={event => { finishDrag(); event.currentTarget.focus(); setState(current => ({ ...current, collapsed: !current.collapsed })); }}>
                <Icon name={state.collapsed ? 'disclosureTextCollapsed' : 'disclosureTextExpanded'} />
              </button>
              <OverlayCloseButton label="Close preview appearance" onClick={close} />
            </>} />}
          footer={{ content: <ChromeAppearanceActions controller={controller} /> }}>
          <ChromeAppearanceControls controller={controller} />
        </DetailPaneShell>
      </div>
    </div> : null}
  </>;
}
