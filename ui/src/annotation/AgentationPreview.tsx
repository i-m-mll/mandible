import { Agentation, type Annotation } from 'agentation';
import { useState } from 'preact/hooks';
import { importAttachment } from '../chat/attachmentApi';
import { agentationAttachment, matchingSelectionBounds, stageAgentationAnnotations } from './agentationAdapter';
import { captureSelection } from './capture';
import './AgentationPreview.css';

export function AgentationPreview(): JSX.Element {
  const [status, setStatus] = useState('Send to Agent stages notes in the open Chat draft.');

  const handleSubmit = async (_output: string, annotations: Annotation[]): Promise<void> => {
    if (!annotations.length) {
      const message = 'Only saved feedback annotations can be staged in Chat.';
      setStatus(message);
      throw new Error(message);
    }
    let screenshotsOmitted = 0;
    try {
      const count = await stageAgentationAnnotations(annotations, async (annotation, ordinal) => {
        const attachment = agentationAttachment(annotation, ordinal, window.location.href, {
          width: window.innerWidth, height: window.innerHeight,
        });
        const bounds = matchingSelectionBounds(annotation);
        if (bounds) {
          try {
            const screenshot = await importAttachment(await captureSelection(bounds, ordinal));
            return { ...attachment, screenshot };
          } catch { screenshotsOmitted += 1; }
        } else {
          screenshotsOmitted += 1;
        }
        return attachment;
      });
      setStatus(count === 0
        ? 'These notes are already in the current Chat draft.'
        : `${count} ${count === 1 ? 'note' : 'notes'} staged in Chat.${screenshotsOmitted ? ` ${screenshotsOmitted} ${screenshotsOmitted === 1 ? 'screenshot was' : 'screenshots were'} omitted because capture or target matching failed.` : ''}`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Could not stage annotations in Chat.');
      throw error;
    }
  };

  return <>
    <Agentation appName="Mandible" useHashLocation onSubmit={handleSubmit} />
    <div className="agentation-preview-status" role="status" aria-live="polite">{status}</div>
  </>;
}
