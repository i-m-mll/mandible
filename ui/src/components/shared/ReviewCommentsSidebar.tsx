import type { ComponentChildren } from 'preact';
import type { MarkdownSourceRange } from '../MarkdownDocument';
import { ContextualAction } from './ContextualAction';
import { CollapsiblePanel } from './CollapsiblePanel';
import { Icon } from '../icons/Icon';
import '../../styles/review-comments.css';

export type ReviewSidebarComment = {
  id: string;
  quote: string;
  range: MarkdownSourceRange | null;
  status?: 'preserved' | 'moved' | 'detached';
  author: string;
  content: ComponentChildren;
  edit?: () => void;
  thread?: {
    resolved: boolean;
    events: readonly { id: string; author?: string; content: ComponentChildren }[];
    actions?: ComponentChildren;
  };
};

export function ReviewCommentsSidebar({ comments, open, setOpen, onNavigate, selectedId }: {
  comments: readonly ReviewSidebarComment[];
  open: boolean;
  setOpen(open: boolean): void;
  onNavigate(range: MarkdownSourceRange, id: string): void;
  selectedId: string | null;
}) {
  const entries = [...comments].sort((a, b) =>
    (a.range?.start ?? Number.MAX_SAFE_INTEGER) - (b.range?.start ?? Number.MAX_SAFE_INTEGER));
  return (
    <aside className="review-comments" aria-label="Review comments">
      <CollapsiblePanel title={comments.length ? `Comments (${comments.length})` : 'Comments'}
        expanded={open} onExpandedChange={setOpen}>
        <ol className="review-comments__list">
          {entries.map((entry) => (
            <li key={entry.id} className="review-comments__entry contextual-action-owner">
              <div className="review-comments__meta">
                <strong>{entry.author}</strong>
                {entry.status && <span>{entry.status[0].toUpperCase() + entry.status.slice(1)}</span>}
                {entry.thread && <span>{entry.thread.resolved ? 'Resolved' : 'Open'}</span>}
                {entry.edit && <ContextualAction aria-label={`Edit comment by ${entry.author}`}
                  title="Edit comment" onClick={entry.edit}><Icon name="editAnnotation" /></ContextualAction>}
              </div>
              {entry.range
                ? <button className="review-comments__quote btn btn--ghost" type="button"
                    aria-current={selectedId === entry.id} onClick={() => onNavigate(entry.range!, entry.id)}>{entry.quote}</button>
                : <blockquote className="review-comments__quote">{entry.quote}</blockquote>}
              <div className="review-comments__body">{entry.content}</div>
              {entry.thread && <>
                {entry.thread.events.length > 0 && <ol className="review-comments__thread">
                  {entry.thread.events.map(event => <li key={event.id}>
                    {event.author && <strong>{event.author}</strong>}
                    <div className="review-comments__body">{event.content}</div>
                  </li>)}
                </ol>}
                {entry.thread.actions && <div className="review-comments__actions">{entry.thread.actions}</div>}
              </>}
            </li>
          ))}
        </ol>
      </CollapsiblePanel>
    </aside>
  );
}
