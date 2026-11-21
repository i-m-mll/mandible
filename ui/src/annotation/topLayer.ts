import { useEffect, useState } from 'preact/hooks';

/**
 * Keeps the embed above everything the host page draws. Each of the embed's layers
 * (its shadow host, Agentation's portal) is a manual popover, so it is in the top
 * layer, above any z-index. A modal dialog makes everything outside itself inert,
 * so while the host has one open the layers live inside the newest one. A host
 * layer that enters the top layer after ours (a popover, a fullscreen element) is
 * answered by showing ours again, which puts them last. Keys typed into the
 * embed stop at its layers, so the host's key handling never sees them.
 */

const PORTAL = '[data-agentation-portal]';
const LAYER_STYLE = 'position:fixed;inset:0 auto auto 0;margin:0;padding:0;border:0;background:transparent;'
  + 'width:0;height:0;overflow:visible';

const KEY_EVENTS = ['keydown', 'keyup', 'keypress'] as const;
const sealed = new WeakSet<HTMLElement>();

function typedIntoField(event: Event): boolean {
  const origin = event.composedPath()[0];
  return origin instanceof HTMLElement && (origin.matches('input, textarea, select') || origin.isContentEditable);
}

/**
 * Stops key events at `layer` once the embed's own handlers inside it have run.
 * Agentation's page shortcuts listen on the document and skip keys typed into a
 * field, so its portal stops only those; the embed's host stops every key.
 */
function seal(layer: HTMLElement, stops: (event: Event) => boolean): void {
  if (sealed.has(layer)) return;
  sealed.add(layer);
  for (const type of KEY_EVENTS) {
    layer.addEventListener(type, (event) => { if (stops(event)) event.stopPropagation(); });
  }
}

/** The host's open modal dialogs, oldest first. */
let modals: HTMLDialogElement[] = [];
const listeners = new Set<() => void>();

function container(): HTMLElement {
  return modals.at(-1) ?? document.body;
}

function trackModals(): void {
  const open = [...document.querySelectorAll<HTMLDialogElement>('dialog:modal')];
  const next = [...modals.filter((dialog) => open.includes(dialog)), ...open.filter((dialog) => !modals.includes(dialog))];
  if (next.length === modals.length && next.every((dialog, index) => dialog === modals[index])) return;
  modals = next;
  listeners.forEach((listener) => listener());
}

function deepActiveElement(): HTMLElement | null {
  let focused = document.activeElement;
  while (focused?.shadowRoot?.activeElement) focused = focused.shadowRoot.activeElement;
  return focused instanceof HTMLElement ? focused : null;
}

/**
 * Shows `layer`, and the popovers open in its shadow root, last in the top layer,
 * inside `into` when given. Moving a popover closes it, and so does hiding it to
 * show it again; the focus it held is restored.
 */
function raise(layer: HTMLElement, into?: HTMLElement): void {
  const nested = [...(layer.shadowRoot?.querySelectorAll<HTMLElement>(':popover-open') ?? [])];
  const focused = deepActiveElement();
  const restore = focused && layer.contains(document.activeElement) ? focused : null;
  if (into && layer.parentNode !== into) into.appendChild(layer);
  for (const open of [layer, ...nested]) {
    if (open.matches(':popover-open')) open.hidePopover();
    open.showPopover();
  }
  restore?.focus({ preventScroll: true });
}

/** Mounts the embed's shadow host in the top layer and keeps it there. */
export function keepOnTop(host: HTMLElement): void {
  host.setAttribute('popover', 'manual');
  host.style.cssText = LAYER_STYLE;
  seal(host, () => true);
  const place = () => raise(host, container());
  listeners.add(place);
  place();
  trackModals();
  new MutationObserver(trackModals)
    .observe(document, { subtree: true, childList: true, attributes: true, attributeFilter: ['open'] });
  const raiseAll = () => {
    const portal = document.querySelector<HTMLElement>(PORTAL);
    // The portal's own toggle raises the host after it.
    if (portal?.matches(':popover-open')) raise(portal);
    else raise(host);
  };
  document.addEventListener('toggle', (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement) || target === host || (event as ToggleEvent).newState !== 'open') return;
    if (target.matches(PORTAL)) {
      seal(target, typedIntoField);
      raise(host);
    }
    else raiseAll();
  }, true);
  document.addEventListener('fullscreenchange', raiseAll);
}

/** Where Agentation mounts: the host's newest modal dialog, or the body. */
export function useTopLayerContainer(): HTMLElement {
  const [current, setCurrent] = useState(container);
  useEffect(() => {
    const listener = () => setCurrent(container());
    listeners.add(listener);
    listener();
    return () => { listeners.delete(listener); };
  }, []);
  return current;
}
