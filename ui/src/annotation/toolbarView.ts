import { useEffect, useState } from 'preact/hooks';

/** Whether the Agentation toolbar is mounted: browser view state shared by the rail control and by actions that show pins. */

const VISIBLE_KEY = 'mandible.agentation.visible:v1';
const LAUNCHER = '[aria-label="Start feedback mode"]';
const EXPANDED = '[aria-label="Exit"]';
const MOUNT_FRAMES = 300;

function storedVisible(): boolean {
  try { return window.localStorage.getItem(VISIBLE_KEY) === 'true'; }
  catch { return false; }
}

let visible = storedVisible();
let expansion = 0;
const listeners = new Set<() => void>();

export function setToolbarVisible(next: boolean): void {
  if (next === visible) return;
  visible = next;
  try { window.localStorage.setItem(VISIBLE_KEY, String(next)); }
  catch { /* The toolbar works without a stored view preference. */ }
  listeners.forEach((listener) => listener());
}

export function useToolbarVisible(): boolean {
  const [value, setValue] = useState(visible);
  useEffect(() => {
    setValue(visible);
    const listener = () => setValue(visible);
    listeners.add(listener);
    return () => listeners.delete(listener);
  }, []);
  return value;
}

/**
 * Shows the toolbar and expands it. Agentation draws pins only while it is
 * expanded and offers no prop for that, so this presses its launcher, found by
 * its accessible name in the toolbar's open shadow root (stable for the pinned
 * package), once the toolbar has mounted.
 */
export function revealToolbarPins(): void {
  setToolbarVisible(true);
  const attempt = (expansion += 1);
  let frames = 0;
  const step = () => {
    if (attempt !== expansion) return;
    const root = document.querySelector('agentation-toolbar')?.shadowRoot;
    const launcher = root?.querySelector<HTMLElement>(LAUNCHER);
    if (launcher) {
      launcher.click();
      return;
    }
    if (root?.querySelector(EXPANDED)) return;
    frames += 1;
    if (frames > MOUNT_FRAMES) {
      console.error('The Agentation toolbar did not mount; its pins stay hidden.');
      return;
    }
    window.requestAnimationFrame(step);
  };
  window.requestAnimationFrame(step);
}
