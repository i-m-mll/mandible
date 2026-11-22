import { useLayoutEffect, useRef, useState } from "preact/hooks";
import {
  VirtualizedFileDiff,
  Virtualizer,
  type FileContents,
  type FileDiffMetadata,
  type FileDiffOptions,
  type SelectedLineRange,
} from "@pierre/diffs";
import { getOrCreateWorkerPoolSingleton, terminateWorkerPoolSingleton } from "@pierre/diffs/worker";
import workerAsset from "@pierre/diffs/worker/worker-portable.js?url";

export type DiffMode = "unified" | "split";

export type DiffLineRange = {
  side: "before" | "after";
  startLine: number;
  endLine: number;
};

export type PierreDiffInput =
  | { kind: "contents"; before: FileContents; after: FileContents }
  | { kind: "patch"; file: FileDiffMetadata };

type PierreFileDiffProps = {
  input: PierreDiffInput;
  mode: DiffMode;
  wrap?: boolean;
  wholeFile: boolean;
  ariaLabel: string;
  onLineSelection?: (range: DiffLineRange | null) => void;
};

let activeDiffs = 0;

function acquireWorker() {
  const pool = getOrCreateWorkerPoolSingleton({
    poolOptions: {
      poolSize: 2,
      workerFactory: () => new Worker(new URL(workerAsset, import.meta.url), { type: "module" }),
    },
    highlighterOptions: { lineDiffType: "word", preferredHighlighter: "shiki-wasm" },
  });
  activeDiffs += 1;
  return {
    pool,
    release() {
      activeDiffs -= 1;
      if (activeDiffs === 0) terminateWorkerPoolSingleton();
    },
  };
}

function toFileRange(range: SelectedLineRange | null): DiffLineRange | null {
  if (!range?.side || (range.endSide && range.endSide !== range.side)) return null;
  return {
    side: range.side === "deletions" ? "before" : "after",
    startLine: Math.min(range.start, range.end),
    endLine: Math.max(range.start, range.end),
  };
}

export function PierreFileDiff({ input, mode, wrap = true, wholeFile, ariaLabel, onLineSelection }: PierreFileDiffProps) {
  const scroll = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const [workerError, setWorkerError] = useState(false);
  const instance = useRef<VirtualizedFileDiff>();
  const options = useRef<FileDiffOptions<undefined, undefined>>({});
  const selection = useRef(onLineSelection);
  selection.current = onLineSelection;

  options.current = {
    overflow: wrap ? "wrap" : "scroll",
    lineDiffType: "word",
    diffStyle: mode,
    themeType: document.documentElement.dataset.theme === "light" ? "light" : "dark",
    expandUnchanged: wholeFile,
    disableFileHeader: true,
    enableLineSelection: true,
    onLineSelected: (range) => selection.current?.(toFileRange(range)),
  };

  useLayoutEffect(() => {
    const root = scroll.current;
    const target = content.current;
    if (!root || !target) return;

    const worker = acquireWorker();
    const virtualizer = new Virtualizer();
    virtualizer.setup(root, target);
    const renderer = new VirtualizedFileDiff(options.current, virtualizer, undefined, worker.pool);
    instance.current = renderer;
    let disposed = false;
    const theme = () => {
      const themeType = document.documentElement.dataset.theme === "light" ? "light" : "dark";
      options.current.themeType = themeType;
      renderer.setThemeType(themeType);
    };
    const observer = new MutationObserver(theme);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    void worker.pool.initialize().then(() => {
      if (disposed) return;
      renderer.render({
        containerWrapper: target,
        ...(input.kind === "contents"
          ? { oldFile: input.before, newFile: input.after }
          : { fileDiff: input.file }),
      });
      theme();
    }).catch(() => { if (!disposed) setWorkerError(true); });

    return () => {
      disposed = true;
      observer.disconnect();
      instance.current = undefined;
      renderer.cleanUp();
      virtualizer.cleanUp();
      worker.release();
    };
  }, [input]);

  useLayoutEffect(() => {
    instance.current?.setOptions(options.current);
  }, [mode, wrap, wholeFile]);

  return (
    <div class="pierre-file-diff" ref={scroll} role="region" aria-label={ariaLabel} tabIndex={0} style={{ overflow: "auto", maxHeight: "65vh" }}>
      <div ref={content} />
      {workerError && <div role="alert">Diff highlighting unavailable</div>}
    </div>
  );
}
