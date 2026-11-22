import { useLayoutEffect, useRef, useState } from "preact/hooks";
import {
  VirtualizedFile,
  VirtualizedFileDiff,
  Virtualizer,
  type FileContents,
  type FileDiffMetadata,
  type FileDiffOptions,
  type SelectedLineRange,
} from "@pierre/diffs";
import { Editor } from "@pierre/diffs/edit";
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
  input: PierreDiffInput | { kind: "file"; file: FileContents };
  mode: DiffMode;
  wrap?: boolean;
  wholeFile: boolean;
  ariaLabel: string;
  lineTarget?: DiffLineRange & { token: string };
  onLineSelection?: (range: DiffLineRange | null) => void;
  onEditChange?: (text: string) => void;
};

type SurfaceOptions = Pick<FileDiffOptions<undefined, undefined>,
  "overflow" | "lineDiffType" | "diffStyle" | "themeType" | "expandUnchanged" |
  "disableFileHeader" | "enableLineSelection" | "onLineSelected">;

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

export function PierreFileDiff({ input, mode, wrap = true, wholeFile, ariaLabel, onLineSelection, lineTarget, onEditChange }: PierreFileDiffProps) {
  const scroll = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const [workerError, setWorkerError] = useState(false);
  const [rendered, setRendered] = useState<PierreFileDiffProps["input"]>();
  const instance = useRef<VirtualizedFile | VirtualizedFileDiff>();
  const options = useRef<SurfaceOptions>({});
  const selection = useRef(onLineSelection);
  selection.current = onLineSelection;
  const onEdit = useRef(onEditChange);
  onEdit.current = onEditChange;

  options.current = {
    overflow: wrap ? "wrap" : "scroll",
    lineDiffType: "word",
    diffStyle: mode,
    themeType: document.documentElement.dataset.theme === "light" ? "light" : "dark",
    expandUnchanged: wholeFile || Boolean(lineTarget),
    disableFileHeader: true,
    enableLineSelection: input.kind !== "file",
    onLineSelected: (range) => selection.current?.(toFileRange(range)),
  };

  useLayoutEffect(() => {
    const root = scroll.current;
    const target = content.current;
    if (!root || !target) return;

    const worker = acquireWorker();
    const virtualizer = new Virtualizer();
    virtualizer.setup(root, target);
    const surface = input.kind === "file"
      ? { kind: "file" as const, renderer: new VirtualizedFile(options.current, virtualizer, undefined, worker.pool), props: { file: input.file } }
      : { kind: "diff" as const, renderer: new VirtualizedFileDiff(options.current, virtualizer, undefined, worker.pool),
        props: input.kind === "contents" ? { oldFile: input.before, newFile: input.after } : { fileDiff: input.file } };
    const { renderer } = surface;
    instance.current = renderer;
    let disposed = false;
    let stopEditing: (() => void) | undefined;
    const theme = () => {
      const themeType = document.documentElement.dataset.theme === "light" ? "light" : "dark";
      options.current.themeType = themeType;
      renderer.setThemeType(themeType);
    };
    const observer = new MutationObserver(theme);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    void worker.pool.initialize().then(() => {
      if (disposed) return;
      if (surface.kind === "file") {
        surface.renderer.render({ containerWrapper: target, ...surface.props });
        const editor = new Editor("file", { onChange: event => onEdit.current?.(event.file.contents) });
        stopEditing = editor.edit(surface.renderer);
      } else {
        surface.renderer.render({ containerWrapper: target, ...surface.props });
      }
      theme();
      setRendered(input);
    }).catch(() => { if (!disposed) setWorkerError(true); });

    return () => {
      disposed = true;
      observer.disconnect();
      instance.current = undefined;
      stopEditing?.();
      renderer.cleanUp();
      virtualizer.cleanUp();
      worker.release();
    };
  }, [input]);

  useLayoutEffect(() => {
    instance.current?.setOptions(options.current);
  }, [mode, wrap, wholeFile, Boolean(lineTarget)]);

  useLayoutEffect(() => {
    if (!lineTarget || rendered !== input || !(instance.current instanceof VirtualizedFileDiff) || !scroll.current) return;
    const renderer = instance.current;
    const side = lineTarget.side === "before" ? "deletions" : "additions";
    renderer.setSelectedLines({ side, start: lineTarget.startLine, end: lineTarget.endLine }, { notify: false });
    const position = renderer.getLinePosition(lineTarget.startLine, side);
    if (position) scroll.current.scrollTop = position.top;
  }, [lineTarget?.token, rendered, input]);

  return (
    <div class="pierre-file-diff" ref={scroll} role="region" aria-label={ariaLabel} tabIndex={0} style={{ overflow: "auto", maxHeight: "65vh" }}>
      <div ref={content} />
      {workerError && <div role="alert">{input.kind === "file" ? "File editor unavailable" : "Diff highlighting unavailable"}</div>}
    </div>
  );
}
