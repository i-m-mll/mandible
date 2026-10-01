import type { Annotation as AgentationAnnotation } from 'agentation';
import { MAX_MESSAGE_ATTACHMENTS, type ChatAttachment } from '../../../src/conversation-control/attachments';
import { addDraftAttachments, getConversationDraft, getWritableChatTarget } from '../chat/attachmentDrafts';

type ChatAnnotation = Extract<ChatAttachment, { kind: 'annotation' }>;

export function matchingSelectionBounds(annotation: AgentationAnnotation): { x: number; y: number; width: number; height: number } | null {
  if (!annotation.boundingBox || !annotation.elementPath || annotation.isMultiSelect) return null;
  if (annotation.url && annotation.url !== window.location.href) return null;
  let element: Element | null;
  try { element = document.querySelector(annotation.elementPath); }
  catch { return null; }
  if (!element) return null;
  const live = element.getBoundingClientRect();
  const saved = annotation.boundingBox;
  const near = (a: number, b: number) => Math.abs(a - b) <= 4;
  if (!near(live.left, saved.x) || !near(live.top, saved.y - window.scrollY)
    || !near(live.width, saved.width) || !near(live.height, saved.height)) return null;
  return { x: live.x, y: live.y, width: live.width, height: live.height };
}

export function agentationAttachment(annotation: AgentationAnnotation, ordinal: number, pageUrl: string, viewport: { width: number; height: number }): ChatAnnotation {
  const box = annotation.boundingBox;
  return {
    kind: 'annotation',
    id: annotation.id,
    ordinal,
    text: annotation.comment || annotation.selectedText || annotation.placement?.text || annotation.rearrange?.label || '',
    target: {
      url: annotation.url || pageUrl,
      ...(annotation.elementPath ? { selector: annotation.elementPath } : {}),
      ...(annotation.selectedText || annotation.nearbyText ? { element_text: (annotation.selectedText || annotation.nearbyText || '').slice(0, 240) } : {}),
      rect: box ? { x: box.x, y: box.y - window.scrollY, width: box.width, height: box.height } : {
        x: annotation.x * viewport.width / 100,
        y: annotation.y - window.scrollY,
        width: 0,
        height: 0,
      },
      viewport,
    },
  };
}

// Agentation awaits onSubmit. Throwing keeps its feedback intact and displays its
// built-in failure state. The chat target is captured before any asynchronous
// work and rechecked immediately before the one durable draft update.
export async function stageAgentationAnnotations(
  annotations: AgentationAnnotation[],
  prepare: (annotation: AgentationAnnotation, ordinal: number) => Promise<ChatAnnotation>,
): Promise<number> {
  const target = getWritableChatTarget();
  if (!target) throw new Error('Open a writable Chat composer before sending annotations.');
  const existing = new Set(getConversationDraft(target).attachments
    .filter((attachment): attachment is ChatAnnotation => attachment.kind === 'annotation')
    .map((attachment) => attachment.id));
  const pending = annotations.filter((annotation) => !existing.has(annotation.id));
  if (!pending.length) return 0;
  if (getConversationDraft(target).attachments.length + pending.length > MAX_MESSAGE_ATTACHMENTS) {
    throw new Error(`A message can have at most ${MAX_MESSAGE_ATTACHMENTS} attachments.`);
  }
  const attachments: ChatAnnotation[] = [];
  for (const annotation of pending) {
    attachments.push(await prepare(annotation, annotations.indexOf(annotation) + 1));
  }
  if (getWritableChatTarget() !== target) throw new Error('The writable Chat changed while annotations were being prepared.');
  const result = addDraftAttachments(target, attachments);
  if (!result.ok) throw new Error(result.error);
  return attachments.length;
}
