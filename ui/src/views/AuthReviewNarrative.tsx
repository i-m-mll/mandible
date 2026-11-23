import { createPortal } from 'preact/compat';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { AuthChangeReport, DiffFilePair } from '../../../src/contracts';
import {
  narrativeHunks, requestNarrativeChanges, resolveNarrativeChange,
  type NarrativeHunk, type NarrativeReference,
} from '../../../src/feedback/request-narrative';
import { getAuthDiffFile, type AuthReviewProjection } from '../api';
import { ChangeList } from '../components/ChangeList';
import { DocumentCommentSurface, type DocumentCommentSelection } from '../components/shared/DocumentComments';
import type { MarkdownDirective, MarkdownDirectiveRenderer, MarkdownDocumentHandle, MarkdownSelection } from '../components/MarkdownDocument';
import { AuthReviewMarkdown, AuthReviewTextFile, authReviewDocumentThreads, authReviewMarkdownMarks, type AuthReviewBinding, type AuthRequestReviewState } from './AuthRequestReview';
import { BRIEFING_MARKDOWN_PREVIEW, BriefingDirectiveControls } from './feedback/BriefingDirectiveControls';
import { authReviewHref } from './auth-review-navigation';

type TextPair = Extract<DiffFilePair, { kind: 'text' }>;
type Question = AuthReviewProjection['narrative_questions'][number];
type Embed = { kind: 'change'; reference: NarrativeReference } | { kind: 'question'; question: Question };
type FileReview = { pair: TextPair; hunks: NarrativeHunk[] };
const sectionView = { wholeFile: true, mode: 'unified', wrap: true } as const;
const noFiles: AuthChangeReport['files'] = [];

export function AuthReviewNarrative({ id, review, onFile }: {
  id: string;
  review: AuthRequestReviewState;
  onFile: (index: number) => void;
}) {
  const data = review.data!;
  const source = data.narrative!;
  const binding = data.round.bindings.find(item => item.source.kind === 'request_narrative')!;
  const report = useMemo(() => data.narrative_report, [data.round.id]);
  const files = report?.files ?? noFiles;
  const references = useMemo(() => requestNarrativeChanges(source, files), [source, files]);
  const byOffset = useMemo(() => new Map<number, Embed>([
    ...references.map(reference => [reference.start, { kind: 'change', reference }] as const),
    ...data.narrative_questions.map(question => [question.directive.start_offset, { kind: 'question', question }] as const),
  ]), [references, data.narrative_questions]);
  const active = useRef(byOffset);
  active.current = byOffset;
  const hosts = useRef(new Map<HTMLElement, number>());
  const [, redrawHosts] = useState(0);
  const lookUp = (node: MarkdownDirective): Embed | undefined => {
    const embed = active.current.get(node.start);
    if (node.kind !== 'container') return;
    if (embed?.kind === 'change' && node.name === 'change' && node.end === embed.reference.end) return embed;
    if (embed?.kind === 'question' && node.name === 'spec-item' && node.end === embed.question.directive.end_offset) return embed;
  };
  const allowlist = useMemo(() => {
    const redraw = () => queueMicrotask(() => redrawHosts(value => value + 1));
    const render: MarkdownDirectiveRenderer = Object.assign((node: MarkdownDirective, owner: Document) => {
      const element = owner.createElement('div');
      hosts.current.set(element, node.start);
      redraw();
      return { element, destroy: () => { hosts.current.delete(element); redraw(); } };
    }, { accepts: (node: MarkdownDirective) => !!lookUp(node) });
    return new Map([['change', render], ['spec-item', render]]);
  }, [binding.id, references, data.narrative_questions.length]);
  const indices = useMemo(() => [...new Set(references.map(({ index }) => index))], [references]);
  const [loaded, setLoaded] = useState<ReadonlyMap<number, FileReview | null>>(() => new Map());
  useEffect(() => {
    const controller = new AbortController();
    setLoaded(new Map());
    for (const index of indices) {
      const receive = (entry: FileReview | null) => {
        if (!controller.signal.aborted) setLoaded(previous => new Map(previous).set(index, entry));
      };
      void getAuthDiffFile(id, index, controller.signal, undefined, data.round.id).then(pair => {
        const hunks = pair.kind === 'text' ? narrativeHunks(pair.before.contents, pair.after.contents) : null;
        receive(pair.kind === 'text' && hunks?.length ? { pair, hunks } : null);
      }, () => receive(null));
    }
    return () => controller.abort();
  }, [id, binding.id, indices]);

  const matched = new Map<NarrativeReference, NarrativeHunk>();
  const covered = new Set<NarrativeHunk>();
  for (const reference of references) {
    const entry = loaded.get(reference.index);
    const hunk = entry && resolveNarrativeChange(entry.pair.after.contents, reference.quote, entry.hunks);
    if (hunk) {
      matched.set(reference, hunk);
      covered.add(hunk);
    }
  }
  const remainingFiles = files.flatMap((file, index) => loaded.get(index) || indices.includes(index) && !loaded.has(index)
    ? [] : [{ file, index }]);
  const fileReference = (index: number, label: string) => {
    const file = files[index];
    return <a href={authReviewHref(id, 'diff', { oldPath: file.old_path, newPath: file.new_path })} onClick={event => {
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      event.preventDefault();
      onFile(index);
    }}>{label}</a>;
  };
  const change = (entry: FileReview, index: number, hunk: NarrativeHunk) =>
    <AuthReviewTextFile review={review} pair={entry.pair} index={index} view={sectionView} section={hunk} />;

  return <div className="auth-review__narrative">
    <AuthReviewMarkdown review={review} binding={binding} value={source} label="Review narrative"
      directives={allowlist} previewPolicy={BRIEFING_MARKDOWN_PREVIEW}
      embedded={data.narrative_questions.map(({ directive }) => ({ start: directive.body_start_offset, end: directive.body_end_offset }))} />
    {[...hosts.current].map(([element, offset]) => {
      const embed = byOffset.get(offset);
      if (embed?.kind === 'change') {
        const { reference } = embed;
        const entry = loaded.get(reference.index);
        const hunk = matched.get(reference);
        return createPortal(<section className="auth-review__narrative-change" aria-label={reference.path}>
          {fileReference(reference.index, reference.path)}
          {entry && hunk && change(entry, reference.index, hunk)}
        </section>, element);
      }
      if (embed?.kind === 'question') {
        return createPortal(<NarrativeQuestion question={embed.question} review={review} source={source} binding={binding} />, element);
      }
      return null;
    })}
    {[...loaded].sort(([a], [b]) => a - b).map(([index, entry]) => entry && entry.hunks.some(hunk => !covered.has(hunk)) && (
      <section key={index} className="auth-review__narrative-change" aria-label={entry.pair.after.name}>
        {fileReference(index, files[index].new_path ?? files[index].old_path ?? entry.pair.after.name)}
        {entry.hunks.filter(hunk => !covered.has(hunk)).map(hunk => <div key={hunk.before.start + ':' + hunk.after.start}>
          {change(entry, index, hunk)}
        </div>)}
      </section>
    ))}
    {remainingFiles.length > 0 && <ChangeList hideToolbar
      files={remainingFiles.map(({ file }) => file)} scope={`auth:${id}:narrative`} revision={report?.comparison.head_sha}
      loadFile={(_file, index, signal) => getAuthDiffFile(id, remainingFiles[index].index, signal, undefined, data.round.id)}
      renderTextFile={(_file, pair, index, view) => <AuthReviewTextFile review={review} pair={pair} index={remainingFiles[index].index} view={view} />}
      ariaLabel="Other request changes" />}
  </div>;
}

function NarrativeQuestion({ question, review, source, binding }: {
  question: Question; review: AuthRequestReviewState; source: string; binding: AuthReviewBinding;
}) {
  const { directive } = question;
  const document = useRef<MarkdownDocumentHandle>(null);
  const [selected, setSelected] = useState<MarkdownSelection | null>(null);
  const span = { start: directive.body_start_offset, end: directive.body_end_offset };
  const selection: DocumentCommentSelection | null = selected?.quote ? {
    range: { start: selected.start - span.start, end: selected.end - span.start },
    onComment: review.available ? async body => {
      await review.commentOn({ bindingId: binding.id, start_offset: selected.start, end_offset: selected.end, quote: selected.quote }, body);
      setSelected(null);
    } : undefined,
  } : null;
  const threads = authReviewDocumentThreads(review, binding, span);
  const target = review.navigation;
  useEffect(() => {
    const thread = threads.find(entry => entry.id === target?.comment.annotation_event_id);
    if (thread?.range) document.current?.reveal(thread.range);
  }, [target?.token]);
  return <DocumentCommentSurface controller={review.comments} threads={threads} selection={selection} drawer={false}
    documentRef={document} navigationKey={`auth.${binding.id}.${span.start}`}>
    <BriefingDirectiveControls item={{ id: question.id, directive, revision: {
      response_type: directive.type, required: directive.required, options: directive.options, variants: directive.variants,
    } }} source={source} current={question.effective_response?.value ?? null} canInteract={Boolean(review.available)}
      decorations={authReviewMarkdownMarks(review, binding)} onDirectiveValue={(_id, value) => review.answerQuestion(directive.key, value)}
      onSelect={setSelected} onDecorationClick={review.comments.select} documentRef={document} />
  </DocumentCommentSurface>;
}
