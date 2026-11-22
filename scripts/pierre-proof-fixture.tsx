import { lazy, Suspense } from "preact/compat";
import { render } from "preact";
import { useState } from "preact/hooks";
import type { DiffLineRange, PierreDiffInput } from "../ui/src/components/PierreFileDiff";
import { ChangeList, type ChangeListFile } from "../ui/src/components/ChangeList";
const FileDiff = lazy(() => import("../ui/src/components/PierreFileDiff").then(({ PierreFileDiff }) => ({ default: PierreFileDiff })));
const MarkdownDocument = lazy(() => import("../ui/src/components/MarkdownDocument").then(module => ({
  default: module.MarkdownDocument,
})));
const markdownSource = (changed: boolean) => Array.from({ length: 640 }, (_, line) => {
  const word = line % 32 === 10 ? (changed ? `newword${line}` : `oldword${line}`) : "context";
  return `Line ${line}: ${word} ${"the fast blue rabbit walks past the slow red rabbit ".repeat(2)}🐇\r\n`;
}).join("");
const source = (side: string) => Array.from({ length: 2000 }, (_, i) =>
  `const value${i} = "${i % 7 < 3 ? side : "context"} ${"the fast blue rabbit walks past the slow red rabbit ".repeat(3)}";\n`).join("");
const input: PierreDiffInput = {
  kind: "contents",
  before: { name: "sample.ts", contents: source("before") },
  after: { name: "sample.ts", contents: source("after") },
};
const files: ChangeListFile[] = Array.from({ length: 400 }, (_, index) => ({
  old_path: null, new_path: `src/file-${index}.ts`, change_kind: "added", additions: 125, deletions: 0,
}));
function Demo() {
  const [shown, show] = useState(false);
  const [listShown, showList] = useState(false);
  const [markdownShown, showMarkdown] = useState(false);
  const [result, setResult] = useState<DiffLineRange | null>(null);
  return <><button onClick={() => show(true)}>Open diff</button><output>{JSON.stringify(result)}</output>
    <button onClick={() => showList(true)}>Open request</button>
    <button onClick={() => showMarkdown(true)}>Open Markdown comparison</button>
    {markdownShown && <Suspense fallback={null}>
      <MarkdownDocument readOnly ariaLabel="Markdown comparison" value={markdownSource(true)}
        comparison={markdownSource(false)} comparisonLayout="full-document" />
    </Suspense>}
    {listShown && <ChangeList files={files} scope="proof" ariaLabel="Large request" loadFile={() => {
      throw new Error("Opening the inventory must defer all file reads.");
    }} />}
    {shown && <Suspense fallback={null}>
      <FileDiff input={input} mode="split" wholeFile={true} ariaLabel="Diff" onLineSelection={setResult} />
    </Suspense>}</>;
}
render(<Demo />, document.body);
