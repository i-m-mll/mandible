import { closestCrossingShadow, type Annotation as AgentationAnnotation } from 'agentation';
import type { ChatAttachment } from '../../../src/conversation-control/attachments';

type ChatAnnotation = Extract<ChatAttachment, { kind: 'annotation' }>;

export function agentationText(annotation: AgentationAnnotation): string {
  return annotation.comment || annotation.selectedText || annotation.placement?.text || annotation.rearrange?.label || '';
}

/** Agentation's own layers, which a hit test at a note's point looks beneath. */
const TOOLBAR = 'agentation-toolbar, [data-agentation-root], [data-feedback-toolbar], [data-annotation-popup], [data-annotation-marker]';

/** The page element at the point a note was just made, beneath the toolbar's layers. */
export function annotationElement(annotation: AgentationAnnotation): Element | null {
  const x = annotation.x * window.innerWidth / 100;
  const y = annotation.isFixed ? annotation.y : annotation.y - window.scrollY;
  return document.elementsFromPoint(x, y).find((element) => !closestCrossingShadow(element, TOOLBAR)) ?? null;
}

/** What the host page declares about `element` on it or its nearest ancestors: a `path:line` source and a reference into the host's own diagnostics. */
function hostDeclared(element: Element | null, attribute: 'data-source' | 'data-note-ref'): string | undefined {
  return element ? closestCrossingShadow(element, `[${attribute}]`)?.getAttribute(attribute) ?? undefined : undefined;
}

/**
 * The note for `annotation`. `element` is the element it was made on, when the page is live; React's development
 * source wins over a host-declared `data-source`, which is all a production build has.
 */
export function agentationAttachment(annotation: AgentationAnnotation, ordinal: number, pageUrl: string, viewport: { width: number; height: number }, element: Element | null = null): ChatAnnotation {
  const box = annotation.boundingBox;
  const field = (value: string | undefined): string | undefined => value?.trim().slice(0, 2_000) || undefined;
  const sourceFile = field(annotation.sourceFile) ?? field(hostDeclared(element, 'data-source'));
  const reference = field(hostDeclared(element, 'data-note-ref'));
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
      ...(sourceFile ? { source_file: sourceFile } : {}),
      ...(reference ? { reference } : {}),
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
