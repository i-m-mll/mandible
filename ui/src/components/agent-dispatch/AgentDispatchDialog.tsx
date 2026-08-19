// Pre-launch confirmation for starting an agent (umbrella 99b74d6, ce83a84).
//
// Starting an agent is not an undoable UI action: a real interactive session
// appears on a real working directory. So this dialog is a hard gate, not a
// courtesy:
//
//  - It opens on the PREVIEW route, which writes nothing. Everything shown here
//    — the task text, the working directory, the full seed prompt — is what the
//    server would actually send, fetched from the same code path that builds
//    the real prompt. It is not reconstructed client-side.
//  - Cancelling closes the dialog and that is the end of it: no comment, no
//    handling event, no prompt file, no session. Nothing to undo.
//  - The capability surface is stated in plain words BEFORE the confirm button,
//    because "start an agent" understates what is about to happen.
//  - The prompt preview is rendered as text inside a <pre>. It quotes
//    LLM-authored, collector-authored, and third-party content; none of it is
//    ever interpreted as markup here.
//
// After confirmation the dialog stays open and reports the outcome, including
// an honest failure: a spawn that could not start is shown as a failure with
// the daemon's reason, never as a silent close.
import { useEffect, useState } from 'preact/hooks';

import {
  dispatchAgent,
  previewAgentDispatch,
  type AgentDispatchEvent,
  type AgentDispatchPlan,
  type AgentDispatchSubject,
} from '../../api';

export type AgentDispatchDialogProps = {
  subject: AgentDispatchSubject;
  /** The human instruction. Shown verbatim; the server stores it verbatim. */
  instruction: string;
  title: string;
  onClose(): void;
  /** Called after a dispatch attempt settles, successfully or not. */
  onDispatched?(event: AgentDispatchEvent): void;
};

type Phase = 'loading' | 'ready' | 'dispatching' | 'done' | 'error';

export function AgentDispatchDialog({
  subject,
  instruction,
  title,
  onClose,
  onDispatched,
}: AgentDispatchDialogProps): JSX.Element {
  const [phase, setPhase] = useState<Phase>('loading');
  const [plan, setPlan] = useState<AgentDispatchPlan | null>(null);
  const [event, setEvent] = useState<AgentDispatchEvent | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setPhase('loading');
    previewAgentDispatch(subject, instruction)
      .then((next) => {
        if (cancelled) return;
        setPlan(next);
        setPhase('ready');
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        setError(cause instanceof Error ? cause.message : String(cause));
        setPhase('error');
      });
    return () => {
      cancelled = true;
    };
  }, [subject.kind, (subject as { issue_ref?: string }).issue_ref,
    (subject as { incident_id?: string }).incident_id, instruction]);

  const confirm = async () => {
    if (phase !== 'ready') return;
    setPhase('dispatching');
    setError(null);
    try {
      const result = await dispatchAgent(subject, instruction);
      setEvent(result.event);
      setPhase('done');
      onDispatched?.(result.event);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setPhase('error');
    }
  };

  return (
    <div
      className="agent-dispatch-dialog"
      role="dialog"
      aria-modal="true"
      aria-label={title}
      data-testid="agent-dispatch-dialog"
    >
      <div className="agent-dispatch-dialog__panel">
        <h3 className="agent-dispatch-dialog__title">{title}</h3>

        {phase === 'loading' ? (
          <p className="agent-dispatch-dialog__status">Preparing the task…</p>
        ) : null}

        {plan && phase !== 'done' ? (
          <>
            <section className="agent-dispatch-dialog__section">
              <h4>Task the agent will be given</h4>
              <p className="agent-dispatch-dialog__instruction" data-testid="agent-dispatch-task">
                {plan.instruction}
              </p>
            </section>

            <section className="agent-dispatch-dialog__section">
              <h4>Where it runs</h4>
              <p className="agent-dispatch-dialog__cwd">{plan.cwd}</p>
            </section>

            <section className="agent-dispatch-dialog__section">
              <h4>What this session can do</h4>
              <ul className="agent-dispatch-dialog__capabilities" data-testid="agent-dispatch-capabilities">
                {plan.capability_surface.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            </section>

            <details className="agent-dispatch-dialog__prompt">
              <summary>Full seed prompt ({plan.prompt.length} characters)</summary>
              {/* Text node only: this quotes untrusted model and third-party
                  content and must never be rendered as markup. */}
              <pre data-testid="agent-dispatch-prompt">{plan.prompt}</pre>
            </details>
          </>
        ) : null}

        {phase === 'done' && event ? (
          <section className="agent-dispatch-dialog__section" data-testid="agent-dispatch-outcome">
            {event.status === 'dispatched' && event.session_handle ? (
              <>
                <h4>Agent started</h4>
                <p className="agent-dispatch-dialog__handle">{event.session_handle}</p>
                {event.attach_command ? (
                  <>
                    <p>Attach with:</p>
                    <pre className="agent-dispatch-dialog__attach">{event.attach_command}</pre>
                  </>
                ) : null}
                <p className="agent-dispatch-dialog__note">
                  This session is external to Mandible. It keeps running until you attach and end
                  it; Mandible has recorded the handle and your instruction.
                </p>
              </>
            ) : (
              <>
                <h4>The agent did not start</h4>
                <p className="agent-dispatch-dialog__error" role="alert">
                  {event.error ?? 'The dispatch did not settle into a running session.'}
                </p>
                <p className="agent-dispatch-dialog__note">
                  Your note was still recorded, and the failed attempt is on the record.
                </p>
              </>
            )}
          </section>
        ) : null}

        {error ? (
          <p className="agent-dispatch-dialog__error" role="alert" data-testid="agent-dispatch-error">
            {error}
          </p>
        ) : null}

        <div className="agent-dispatch-dialog__actions">
          {phase === 'done' ? (
            <button type="button" className="btn" onClick={onClose}>Close</button>
          ) : (
            <>
              <button type="button" className="btn btn--ghost" onClick={onClose}>
                Cancel
              </button>
              <button
                type="button"
                className="btn btn--primary"
                disabled={phase !== 'ready'}
                onClick={() => void confirm()}
              >
                {phase === 'dispatching' ? 'Starting…' : 'Start agent'}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

export default AgentDispatchDialog;
