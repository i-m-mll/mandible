import { render } from 'preact';
import { EditorView } from '@codemirror/view';
import { bindOperationCatalog, type InstanceInfo } from '../../../ui/src/api';
import { markdownEditorRange, markdownValue } from '../../../ui/src/components/markdown/source';
import { SpaceDocumentEditor } from '../../../ui/src/views/spaces/SpaceDocumentEditor';
import { parseSpaceSource } from '../../../src/spaces/document-source';

declare global {
  interface Window {
    spaceFixture: { spaceId: string; instance: InstanceInfo; operations: unknown };
    selectSpaceFrame(id: string, bodyOffset?: number): void;
  }
}

const { spaceId, instance, operations } = window.spaceFixture;
if (!bindOperationCatalog(instance, operations)) throw new Error('Incompatible fixture operation catalog');
render(<SpaceDocumentEditor spaceId={spaceId} projectId="" renderer="document" instance={instance} />, document.getElementById('root')!);

window.selectSpaceFrame = (id, bodyOffset) => {
  const view = EditorView.findFromDOM(document.querySelector<HTMLElement>('.cm-editor')!)!;
  const frame = parseSpaceSource(spaceId, markdownValue(view.state), 0).find(span => span.block.id === id)!;
  const selected = bodyOffset === undefined
    ? { start: frame.from, end: frame.to }
    : { start: frame.body.start + bodyOffset, end: frame.body.start + bodyOffset };
  const { from, to } = markdownEditorRange(view.state, selected);
  view.focus();
  view.dispatch({ selection: { anchor: from, head: to } });
};
