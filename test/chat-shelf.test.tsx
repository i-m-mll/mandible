import { cleanup, fireEvent, render, screen } from "@testing-library/preact";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Shelf, type ShelfItem } from "../ui/src/chat/Shelf";

function installStorage(): void {
  const store = new Map<string, string>();
  const storage: Storage = {
    get length() {
      return store.size;
    },
    clear: () => store.clear(),
    getItem: (key: string) => (store.has(key) ? store.get(key)! : null),
    key: (index: number) => Array.from(store.keys())[index] ?? null,
    removeItem: (key: string) => {
      store.delete(key);
    },
    setItem: (key: string, value: string) => {
      store.set(key, value);
    },
  };
  Object.defineProperty(globalThis, "localStorage", { value: storage, configurable: true });
}

beforeEach(() => {
  installStorage();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function items(onActivate = vi.fn()): ShelfItem[] {
  return [
    { id: "a", icon: "↳", label: "Inspect parser", status: "finished", meta: ["2 blocks"], onActivate },
    { id: "b", icon: "↳", label: "Inspect UI", status: "active", meta: ["3 blocks"], onActivate },
  ];
}

describe("Shelf", () => {
  it("persists expansion per conversation", () => {
    const { rerender } = render(
      <Shelf conversationId="conv-1" title="Subagents" items={items()} />,
    );

    fireEvent.click(screen.getByRole("button", { name: /subagents/i }));
    expect(screen.queryByRole("button", { name: /inspect parser/i })).toBeNull();

    rerender(<Shelf conversationId="conv-1" title="Subagents" items={items()} />);
    expect(screen.queryByRole("button", { name: /inspect parser/i })).toBeNull();

    rerender(<Shelf conversationId="conv-2" title="Subagents" items={items()} />);
    expect(screen.getByRole("button", { name: /inspect parser/i })).toBeTruthy();
  });

  it("supports row keyboard navigation, activation, and escape", () => {
    const onActivate = vi.fn();
    const onEscape = vi.fn();
    render(
      <Shelf conversationId="conv-1" title="Subagents" items={items(onActivate)} onEscape={onEscape} />,
    );

    const first = screen.getByRole("button", { name: /inspect parser/i });
    first.focus();
    fireEvent.keyDown(first, { key: "ArrowDown" });
    expect(screen.getByRole("button", { name: /inspect ui/i })).toBe(document.activeElement);

    fireEvent.keyDown(document.activeElement as HTMLElement, { key: "Enter" });
    expect(onActivate).toHaveBeenCalledTimes(1);

    fireEvent.keyDown(document.activeElement as HTMLElement, { key: "Escape" });
    expect(onEscape).toHaveBeenCalledTimes(1);
  });
});
