import type { RefObject } from 'preact';
import { useLayoutEffect } from 'preact/hooks';
import { readPersistedViewState, writePersistedViewState } from './usePersistedViewState';

function normalizeOffset(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
}

/** Preserve plain scroll-owner position while delayed content reconciles. */
export function usePersistedScrollPosition(ref: RefObject<HTMLElement>, storageKey: string): void {
  useLayoutEffect(() => {
    const node = ref.current;
    if (!node) return;
    let position = readPersistedViewState(storageKey, normalizeOffset, 0);
    let pending: number | null = position;
    let applied = node.scrollTop;
    let resize: ResizeObserver | undefined;
    let mutations: MutationObserver | undefined;
    const stopRestoring = () => {
      resize?.disconnect();
      mutations?.disconnect();
    };
    const save = (offset: number) => {
      position = normalizeOffset(offset);
      writePersistedViewState(storageKey, position);
    };
    const restore = () => {
      if (pending === null) return;
      node.scrollTop = Math.min(pending, Math.max(0, node.scrollHeight - node.clientHeight));
      applied = node.scrollTop;
      if (Math.abs(applied - pending) < 1) {
        pending = null;
        stopRestoring();
      }
    };
    const observeContent = () => {
      restore();
      if (pending === null || !resize) return;
      resize.observe(node);
      for (const child of node.children) resize.observe(child);
    };
    const onScroll = () => {
      if (node.scrollTop === applied) return;
      pending = null;
      stopRestoring();
      applied = node.scrollTop;
      save(applied);
    };
    const onIntent = () => {
      if (pending === null) return;
      pending = null;
      stopRestoring();
      save(node.scrollTop);
    };
    const onKey = (event: KeyboardEvent) => {
      if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(event.key)) onIntent();
    };
    const flush = () => {
      if (pending === null) save(node.scrollTop);
    };
    restore();
    if (pending !== null) {
      resize = new ResizeObserver(observeContent);
      mutations = new MutationObserver(observeContent);
      mutations.observe(node, { subtree: true, childList: true, characterData: true, attributes: true });
      observeContent();
    }
    node.addEventListener('scroll', onScroll, { passive: true });
    node.addEventListener('wheel', onIntent, { passive: true });
    node.addEventListener('touchstart', onIntent, { passive: true });
    node.addEventListener('pointerdown', onIntent, { passive: true });
    node.addEventListener('keydown', onKey);
    node.addEventListener('load', observeContent, true);
    window.addEventListener('pagehide', flush);
    return () => {
      stopRestoring();
      node.removeEventListener('scroll', onScroll);
      node.removeEventListener('wheel', onIntent);
      node.removeEventListener('touchstart', onIntent);
      node.removeEventListener('pointerdown', onIntent);
      node.removeEventListener('keydown', onKey);
      node.removeEventListener('load', observeContent, true);
      window.removeEventListener('pagehide', flush);
      writePersistedViewState(storageKey, position);
    };
  }, [ref, storageKey]);
}
