import { annotationContextFields, type ChatAttachment } from '../../../src/conversation-control/attachments';

type Annotation = Extract<ChatAttachment, { kind: 'annotation' }>;

export function AnnotationPreviewContent({ annotation, screenshotUrl }: {
  annotation: Annotation;
  screenshotUrl: (file: NonNullable<Annotation['screenshot']>) => string;
}): JSX.Element {
  return <>
    <p>{annotation.text}</p>
    <dl className="conv-compose__annotation-context">
      {annotationContextFields(annotation.target).map(({ label, value }) => <div key={label}>
        <dt>{label}</dt><dd>{value}</dd>
      </div>)}
    </dl>
    {annotation.screenshot && <img src={screenshotUrl(annotation.screenshot)} alt={`Screenshot for annotation ${annotation.ordinal}`} />}
  </>;
}
