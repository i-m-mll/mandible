import type { Annotation as AgentationAnnotation } from 'agentation';
import type { ChatAttachment } from '../../../src/conversation-control/attachments';

type ChatAnnotation = Extract<ChatAttachment, { kind: 'annotation' }>;

export function agentationText(annotation: AgentationAnnotation): string {
  return annotation.comment || annotation.selectedText || annotation.placement?.text || annotation.rearrange?.label || '';
}

export function agentationAttachment(annotation: AgentationAnnotation, ordinal: number, pageUrl: string, viewport: { width: number; height: number }): ChatAnnotation {
  const box = annotation.boundingBox;
  const field = (value: string | undefined): string | undefined => value?.trim().slice(0, 2_000) || undefined;
  return {
    kind: 'annotation',
    id: annotation.id,
    ordinal,
    text: agentationText(annotation),
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
