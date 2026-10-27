import { navigateAppHash } from '../app-history';
import { Agentation, type Annotation } from 'agentation';
import { getAgentPageBinding, hashWithAgentSession } from '../agent-page-binding';
import { highlightDraftAttachments } from '../chat/attachmentDrafts';
import { stageAgentationAnnotations } from './agentationAdapter';

export function AgentationPreview(): JSX.Element {
  const handleSubmit = (_output: string, annotations: Annotation[]): void => {
    const { target, addedIds } = stageAgentationAnnotations(annotations, window.location.href, {
      width: window.innerWidth, height: window.innerHeight,
    });
    highlightDraftAttachments(target, addedIds);
    const hash = hashWithAgentSession(
      `#/console?conversation=${encodeURIComponent(target)}`,
      getAgentPageBinding(),
    );
    if (window.location.hash !== hash) navigateAppHash(hash);
  };

  return <Agentation appName="Mandible" onSubmit={handleSubmit} />;
}
