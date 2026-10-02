import type { Annotation as AgentationAnnotation } from 'agentation';
import { MAX_MESSAGE_ATTACHMENTS, type ChatAttachment } from '../../../src/conversation-control/attachments';
import { addDraftAttachments, getConversationDraft, getSelectedWritableChatTarget } from '../chat/attachmentDrafts';

type ChatAnnotation = Extract<ChatAttachment, { kind: 'annotation' }>;

export function agentationAttachment(annotation: AgentationAnnotation, ordinal: number, pageUrl: string, viewport: { width: number; height: number }): ChatAnnotation {
  const box = annotation.boundingBox;
  const field = (value: string | undefined): string | undefined => value?.trim().slice(0, 2_000) || undefined;
  return {
    kind: 'annotation',
    id: annotation.id,
    ordinal,
    text: annotation.comment || annotation.selectedText || annotation.placement?.text || annotation.rearrange?.label || '',
    target: {
      url: annotation.url || pageUrl,
      ...(field(annotation.elementPath) ? { selector: field(annotation.elementPath) } : {}),
      ...(annotation.selectedText || annotation.nearbyText ? { element_text: (annotation.selectedText || annotation.nearbyText || '').slice(0, 240) } : {}),
      ...(field(annotation.element) ? { element: field(annotation.element) } : {}),
      ...(field(annotation.sourceFile) ? { source_file: field(annotation.sourceFile) } : {}),
      ...(field(annotation.reactComponents) ? { react_components: field(annotation.reactComponents) } : {}),
      ...(field(annotation.cssClasses) ? { css_classes: field(annotation.cssClasses) } : {}),
      ...(field(annotation.computedStyles) ? { computed_styles: field(annotation.computedStyles) } : {}),
      ...(field(annotation.selectedText) ? { selected_text: field(annotation.selectedText) } : {}),
      ...(field(annotation.nearbyText) ? { nearby_text: field(annotation.nearbyText) } : {}),
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

// Throwing lets Agentation keep its feedback and display its built-in failure state.
// The selected destination and draft append are resolved in one synchronous turn.
export function stageAgentationAnnotations(
  annotations: AgentationAnnotation[],
  pageUrl: string,
  viewport: { width: number; height: number },
): { target: string; addedIds: string[] } {
  if (!annotations.length) throw new Error('Save a feedback annotation before sending.');
  const target = getSelectedWritableChatTarget();
  if (!target) throw new Error('Select a writable Chat before sending annotations.');
  const existing = new Set(getConversationDraft(target).attachments
    .filter((attachment): attachment is ChatAnnotation => attachment.kind === 'annotation')
    .map((attachment) => attachment.id));
  const pending = annotations.flatMap((annotation, index) => {
    if (existing.has(annotation.id)) return [];
    existing.add(annotation.id);
    return [agentationAttachment(annotation, index + 1, pageUrl, viewport)];
  });
  if (getConversationDraft(target).attachments.length + pending.length > MAX_MESSAGE_ATTACHMENTS) {
    throw new Error(`A message can have at most ${MAX_MESSAGE_ATTACHMENTS} attachments.`);
  }
  const result = addDraftAttachments(target, pending);
  if (!result.ok) throw new Error(result.error);
  return { target, addedIds: pending.map((annotation) => annotation.id) };
}
