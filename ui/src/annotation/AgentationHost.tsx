import { Agentation, type Annotation } from 'agentation';
import { navigateTo, viewHref } from '../routing';
import { highlightDraftAttachments } from '../chat/attachmentDrafts';
import { stageAgentationAnnotations } from './agentationAdapter';
import { recordAdd, recordClear, recordDelete, recordUpdate, useInterfaceNotes } from './interfaceNotesStore';

// Agentation shows its failed state when the returned promise rejects.
async function handleSubmit(_output: string, annotations: Annotation[]): Promise<void> {
  const { target, addedIds } = stageAgentationAnnotations(annotations, window.location.href, {
    width: window.innerWidth, height: window.innerHeight,
  });
  highlightDraftAttachments(target, addedIds);
  navigateTo(viewHref('console', { conversation: target }));
}

export function AgentationHost(): JSX.Element | null {
  const { ready, epoch } = useInterfaceNotes();
  if (!ready) return null;
  return (
    <Agentation
      key={epoch}
      appName="Mandible"
      onAnnotationAdd={recordAdd}
      onAnnotationUpdate={recordUpdate}
      onAnnotationDelete={recordDelete}
      onAnnotationsClear={recordClear}
      onSubmit={handleSubmit}
    />
  );
}
