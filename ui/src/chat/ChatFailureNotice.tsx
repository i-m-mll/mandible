import { ApiError, type ConversationControlError, type ConversationSpawnFailure } from '../api.js';
import { DetailPaneNotice } from '../components/shared/DetailPaneNotice';

const MAX_DETAIL_LENGTH = 280;
const MAX_DIAGNOSTICS_LENGTH = 2_000;

export type ChatFailureNoticeModel = {
  title: string;
  detail: string;
  retryable: boolean;
  diagnostics: string | null;
};

function bounded(value: string, limit: number): string {
  return value.length <= limit ? value : `${value.slice(0, limit - 1)}…`;
}

function diagnostics(value: unknown): string {
  return bounded(JSON.stringify(value, null, 2), MAX_DIAGNOSTICS_LENGTH);
}

export function chatSpawnFailureNotice(failure: ConversationSpawnFailure): ChatFailureNoticeModel {
  const title = failure.code === 'provider_startup_timeout'
    ? 'The provider took too long to start.'
    : failure.code === 'provider_startup_interrupted' || failure.code === 'client_aborted'
      ? 'Provider startup was interrupted.'
      : 'The provider could not start.';
  return {
    title,
    detail: bounded(failure.message, MAX_DETAIL_LENGTH),
    retryable: failure.retryable,
    diagnostics: diagnostics({
      code: failure.code,
      ...(failure.phase ? { phase: failure.phase } : {}),
      ...(failure.provenance ? { provenance: failure.provenance } : {}),
    }),
  };
}

export function chatControlFailureNotice(error: ConversationControlError): ChatFailureNoticeModel {
  switch (error.kind) {
    case 'settings-drift':
      return { title: 'Conversation settings changed.', detail: error.message, retryable: false, diagnostics: diagnostics({ desired_revision: error.desired_revision }) };
    case 'adapter-failure':
      return {
        title: 'The provider could not complete this action.',
        detail: bounded(error.message, MAX_DETAIL_LENGTH),
        retryable: error.retryable,
        diagnostics: diagnostics({ adapter_id: error.adapter_id, code: error.code }),
      };
    case 'adapter-unavailable':
      return {
        title: 'The provider connection is unavailable.',
        detail: 'Mandible cannot reach the provider controller for this conversation.',
        retryable: false,
        diagnostics: diagnostics(error),
      };
    case 'adapter-contract-violation':
      return {
        title: 'The provider returned an invalid response.',
        detail: bounded(error.message, MAX_DETAIL_LENGTH),
        retryable: false,
        diagnostics: diagnostics(error),
      };
    case 'delivery-uncertain':
      return {
        title: 'Message delivery could not be confirmed.',
        detail: 'Check the conversation before sending again to avoid a duplicate message.',
        retryable: false,
        diagnostics: diagnostics(error),
      };
    case 'ownership-conflict':
      return {
        title: 'Another controller owns this conversation.',
        detail: 'This action is blocked until Mandible can safely control the provider session.',
        retryable: false,
        diagnostics: diagnostics(error),
      };
    case 'capability-drift':
    case 'stale-generation':
      return {
        title: 'The conversation changed before the action completed.',
        detail: 'Review its current state before trying the action again.',
        retryable: false,
        diagnostics: diagnostics(error),
      };
    case 'conversation-not-found':
      return {
        title: 'The conversation is no longer available.',
        detail: 'Mandible could not find the selected conversation.',
        retryable: false,
        diagnostics: diagnostics(error),
      };
    case 'invalid-request':
      return {
        title: 'The action could not be sent.',
        detail: bounded(error.message, MAX_DETAIL_LENGTH),
        retryable: false,
        diagnostics: diagnostics({ kind: error.kind, field: error.field }),
      };
    case 'unsupported-operation':
      return {
        title: 'This action is not available now.',
        detail: 'The provider no longer supports the selected conversation action.',
        retryable: false,
        diagnostics: diagnostics(error),
      };
  }
}

export function chatSubmissionFailureNotice(error: unknown): ChatFailureNoticeModel {
  if (error instanceof ApiError && error.code === 'effect_forbidden') {
    return {
      title: 'This preview cannot send messages to agents.',
      detail: '',
      retryable: false,
      diagnostics: null,
    };
  }
  return {
    title: 'Message was not sent.',
    detail: bounded(error instanceof Error ? error.message : String(error), MAX_DETAIL_LENGTH),
    retryable: false,
    diagnostics: null,
  };
}

export function ChatFailureNotice({
  failure,
  busy = false,
  onRetry,
  onDismiss,
}: {
  failure: ChatFailureNoticeModel;
  busy?: boolean;
  onRetry?: () => void;
  onDismiss?: () => void;
}): JSX.Element {
  return (
    <DetailPaneNotice
      severity="error"
      density="compact"
      title={failure.title}
      actions={(failure.retryable && onRetry) || onDismiss ? <>
        {failure.retryable && onRetry ? <button type="button" className="btn btn--ghost btn--sm" disabled={busy} onClick={onRetry}>Retry</button> : null}
        {onDismiss ? <button type="button" className="chat-failure-notice__dismiss" aria-label="Dismiss error" title="Dismiss error" onClick={onDismiss}>×</button> : null}
      </> : undefined}
    >
      {failure.detail ? <span>{failure.detail}</span> : null}
      {failure.diagnostics ? (
        <details className="chat-failure-notice__diagnostics">
          <summary>Provider diagnostics</summary>
          <pre>{failure.diagnostics}</pre>
        </details>
      ) : null}
    </DetailPaneNotice>
  );
}
