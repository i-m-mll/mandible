import { DetailPaneNotice } from './shared/DetailPaneNotice';
import { useImperativeHandle, useLayoutEffect, useRef, useState } from "preact/hooks";
import type { Ref } from "preact";
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

export type PierreLineReview = {
  lines: readonly (DiffLineRange & { id: string; active: boolean })[];
  onComment?: (range: DiffLineRange) => void;
  onHover(id: string | null): void;
  onOpen(id: string): void;
};

export type PierreLineHandle = {
  bounds(range: DiffLineRange): DOMRect | null;
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
  lineReview?: PierreLineReview;
  lineRef?: Ref<PierreLineHandle>;
};

type SurfaceOptions = Pick<FileDiffOptions<undefined, undefined>,
  "overflow" | "lineDiffType" | "diffStyle" | "themeType" | "expandUnchanged" |
  "disableFileHeader" | "enableLineSelection" | "onLineSelected">;
type ReviewOptions = Pick<FileDiffOptions<undefined, undefined>,
  "enableGutterUtility" | "onGutterUtilityClick" | "onPostRender" | "onLineClick" | "onLineEnter" | "onLineLeave" | "unsafeCSS">;

const markedReviewLine = "[data-review-comment]";
const reviewLineStyles = `
  ${markedReviewLine} {
    --diffs-line-bg: color-mix(in srgb, var(--accent) 18%, var(--diffs-computed-hovered-line-bg));
    cursor: pointer;
  }
  ${markedReviewLine}[data-comment-active] {
    --diffs-line-bg: color-mix(in srgb, var(--accent) 32%, var(--diffs-computed-hovered-line-bg));
  }
`;

const findReviewLine = (lines: PierreLineReview["lines"], side: DiffLineRange["side"], line: number) =>
  lines.find(mark => mark.side === side && mark.startLine <= line && mark.endLine >= line);

function lineSide(element: Element) {
  return element.getAttribute("data-line-type") === "change-deletion" || element.closest("[data-deletions]") ? "before" : "after";
}

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

export function PierreFileDiff({ input, mode, wrap = true, wholeFile, ariaLabel, onLineSelection, lineTarget, onEditChange, lineReview, lineRef }: PierreFileDiffProps) {
  const scroll = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const [workerError, setWorkerError] = useState(false);
  const [rendered, setRendered] = useState<PierreFileDiffProps["input"]>();
  const instance = useRef<VirtualizedFile | VirtualizedFileDiff>();
  const options = useRef<SurfaceOptions>({});
  const reviewOptions = useRef<ReviewOptions>({});
  const selection = useRef(onLineSelection);
  selection.current = onLineSelection;
  const review = useRef(lineReview);
  review.current = lineReview;
  const shadow = useRef<ShadowRoot>();
  const markLines = () => {
    if (!shadow.current || !review.current) return;
    for (const element of shadow.current.querySelectorAll<HTMLElement>('[data-line], [data-column-number]')) {
      const line = Number(element.dataset.line ?? element.dataset.columnNumber);
      const item = findReviewLine(review.current.lines, lineSide(element), line);
      element.toggleAttribute('data-comment-active', Boolean(item?.active));
      if (item) element.dataset.reviewComment = item.id;
      else delete element.dataset.reviewComment;
    }
  };
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
  reviewOptions.current = lineReview ? {
      unsafeCSS: reviewLineStyles,
      enableGutterUtility: Boolean(lineReview.onComment),
      onGutterUtilityClick: lineReview.onComment ? (range: SelectedLineRange) => {
        const fileRange = toFileRange(range);
        if (fileRange) review.current?.onComment?.(fileRange);
      } : undefined,
      onPostRender: (node: HTMLElement) => {
        shadow.current = node.shadowRoot ?? node.querySelector('diffs-container')?.shadowRoot ?? undefined;
        markLines();
      },
      onLineClick: ({ lineElement }) => {
        const id = lineElement.dataset.reviewComment;
        if (id) review.current?.onOpen(id);
      },
      onLineEnter: ({ lineElement }) => review.current?.onHover(lineElement.dataset.reviewComment ?? null),
      onLineLeave: () => review.current?.onHover(null),
  } : {};

  useImperativeHandle(lineRef ?? null, () => ({
    bounds(range) {
      const root = scroll.current;
      const renderer = instance.current;
      if (!root || !(renderer instanceof VirtualizedFileDiff)) return null;
      const viewport = root.getBoundingClientRect();
      const marked = [...shadow.current?.querySelectorAll<HTMLElement>(`[data-line="${range.startLine}"]`) ?? []]
        .find(element => lineSide(element) === range.side);
      const relative = renderer.getLinePosition(range.startLine, range.side === 'before' ? 'deletions' : 'additions');
      const bounds = marked?.getBoundingClientRect() ?? (relative &&
        DOMRect.fromRect({ x: viewport.left, y: viewport.top + relative.top - root.scrollTop, height: relative.height, width: viewport.width }));
      return bounds && bounds.bottom > viewport.top && bounds.top < viewport.bottom ? bounds : null;
    },
  }), []);

  useLayoutEffect(markLines, [lineReview?.lines]);

  useLayoutEffect(() => {
    const root = scroll.current;
    const target = content.current;
    if (!root || !target) return;

    const worker = acquireWorker();
    const virtualizer = new Virtualizer();
    virtualizer.setup(root, target);
    const surface = input.kind === "file"
      ? { kind: "file" as const, renderer: new VirtualizedFile(options.current, virtualizer, undefined, worker.pool), props: { file: input.file } }
      : { kind: "diff" as const, renderer: new VirtualizedFileDiff({ ...options.current, ...reviewOptions.current }, virtualizer, undefined, worker.pool),
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
    const renderer = instance.current;
    if (renderer instanceof VirtualizedFileDiff) renderer.setOptions({ ...options.current, ...reviewOptions.current });
    else renderer?.setOptions(options.current);
  }, [mode, wrap, wholeFile, Boolean(lineTarget), Boolean(lineReview), Boolean(lineReview?.onComment)]);

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
      {workerError && <DetailPaneNotice severity="warning" density="compact">{input.kind === "file" ? "File editor unavailable" : "Diff highlighting unavailable"}</DetailPaneNotice>}
    </div>
  );
}
