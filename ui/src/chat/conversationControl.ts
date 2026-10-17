import type { ConversationControlSnapshot } from '../api';

/** A state that keeps Send blocked until something outside the composer changes. */
export type ConversationControlBlocker = {
  key: string;
  severity: 'info' | 'warning';
  title: string;
  detail: string;
};

export type ConversationControlPresentation = {
  sendable: boolean;
  /** Reported once in the Chat header; transient transitions have none. */
  blocker: ConversationControlBlocker | null;
  submitLabel: 'Send' | 'Steer now' | 'Queue after this turn' | 'Resume';
};

export function conversationControlPresentation(
  snapshot: ConversationControlSnapshot,
): ConversationControlPresentation {
  const capability = snapshot.capability;
  const submitLabel = capability.kind === 'live-steer'
    ? 'Steer now' as const
    : capability.kind === 'owned-queue'
      ? 'Queue after this turn' as const
      : capability.kind === 'provider-session-resume' || capability.kind === 'message-anchor-resume'
        ? 'Resume' as const
        : 'Send' as const;
  const key = `${snapshot.conversation_id}:${capability.kind}:${'reason' in capability ? capability.reason : ''}`;
  switch (capability.kind) {
    case 'blocked-external':
      return {
        sendable: false,
        submitLabel,
        blocker: {
          key: `${key}:${capability.evidence_kind}`,
          severity: 'warning',
          title: 'Another process is using this chat.',
          detail: 'Sending becomes available when it exits.',
        },
      };
    case 'unavailable':
      if (capability.reason === 'unsupported-provider') {
        return { sendable: false, submitLabel, blocker: { key, severity: 'info', title: 'This provider cannot be continued from Mandible.', detail: '' } };
      }
      if (capability.reason === 'no-provider-session') {
        return { sendable: false, submitLabel, blocker: { key, severity: 'info', title: 'This chat has no provider session to continue.', detail: '' } };
      }
      return { sendable: false, submitLabel, blocker: null };
    default:
      return { sendable: true, submitLabel, blocker: null };
  }
}
