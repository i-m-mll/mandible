import type { ConversationControlSnapshot } from '../api';

export type ConversationExecutionState = {
  phase: 'idle' | 'starting' | 'queued' | 'running' | 'waiting' | 'stopping' | 'terminal' | 'unknown';
  isExecuting: boolean;
  canInterrupt: boolean;
  activeTurnId: string | null;
  generation: number | null;
};

export function conversationExecutionState(snapshot: ConversationControlSnapshot | null | undefined): ConversationExecutionState {
  if (!snapshot) return { phase: 'unknown', isExecuting: false, canInterrupt: false, activeTurnId: null, generation: null };
  const { turn, controller, ownership } = snapshot;
  const terminal = ['completed', 'failed', 'cancelled'].includes(turn.kind);
  const active = ['running', 'queued', 'waiting-user', 'waiting-permission'].includes(turn.kind);
  const owned = ownership.kind === 'mandible';
  const phase: ConversationExecutionState['phase'] = terminal ? 'terminal'
    : turn.kind === 'unknown' || (active && (controller.kind === 'failed' || controller.kind === 'stopped')) ? 'unknown'
    : controller.kind === 'stopping' ? 'stopping'
    : turn.kind === 'waiting-user' || turn.kind === 'waiting-permission' ? 'waiting'
    : turn.kind === 'running' ? 'running'
    : turn.kind === 'queued' ? 'queued'
    : controller.kind === 'starting' ? 'starting' : 'idle';
  return {
    phase,
    isExecuting: owned && phase === 'running' && controller.kind === 'running',
    canInterrupt: owned && active && Boolean(snapshot.provider_capabilities?.stop) && phase !== 'unknown',
    activeTurnId: active && 'turn_id' in turn ? turn.turn_id : null,
    generation: ownership.generation,
  };
}

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
