import { Agentation, type Annotation } from 'agentation';
import { navigateTo } from '../routing';
import { highlightDraftAttachments } from '../chat/attachmentDrafts';
import { stageAgentationAnnotations } from './agentationAdapter';

export function AgentationPreview(): JSX.Element {
  const handleSubmit = (_output: string, annotations: Annotation[]): void => {
    const { target, addedIds } = stageAgentationAnnotations(annotations, window.location.href, {
      width: window.innerWidth, height: window.innerHeight,
    });
    highlightDraftAttachments(target, addedIds);
    navigateTo(`/console?conversation=${encodeURIComponent(target)}`);
  };

  return <Agentation appName="Mandible" onSubmit={handleSubmit} />;
}
