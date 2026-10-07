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
    : ownership.kind === 'unknown' || turn.kind === 'unknown' || controller.kind === 'unknown' || (active && (controller.kind === 'failed' || controller.kind === 'stopped')) ? 'unknown'
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

export type ConversationControlPresentation = {
  status: string;
  title: string;
  composer: 'enabled' | 'disabled' | 'hidden';
  submitLabel: 'Send' | 'Steer now' | 'Queue after this turn' | 'Resume';
};

export function conversationControlPresentation(
  snapshot: ConversationControlSnapshot,
): ConversationControlPresentation {
  const capability = snapshot.capability;
  const composer = capability.kind === 'unavailable'
    ? 'hidden' as const
    : capability.kind === 'blocked-external' || capability.kind === 'blocked-ownership-unknown'
      ? 'disabled' as const
      : 'enabled' as const;
  const submitLabel = capability.kind === 'live-steer'
    ? 'Steer now' as const
    : capability.kind === 'owned-queue'
      ? 'Queue after this turn' as const
      : capability.kind === 'provider-session-resume' || capability.kind === 'message-anchor-resume'
        ? 'Resume' as const
        : 'Send' as const;

  if (snapshot.ownership.kind === 'external') {
    return { status: 'External', title: 'Another controller owns this provider session.', composer, submitLabel };
  }
  if (snapshot.ownership.kind === 'unknown') {
    return { status: 'Unknown', title: 'Mandible cannot prove that this session is free.', composer, submitLabel };
  }
  if (snapshot.ownership.kind === 'none' && capability.kind === 'unavailable') {
    return { status: 'Unavailable', title: `Continuation unavailable: ${capability.reason}.`, composer, submitLabel };
  }
  if (snapshot.turn.kind === 'queued') {
    return { status: 'Queued', title: 'A Mandible-owned message is queued.', composer, submitLabel };
  }
  if (snapshot.turn.kind === 'running') {
    return { status: 'Running', title: 'The Mandible-owned turn is running.', composer, submitLabel };
  }
  if (snapshot.turn.kind === 'waiting-user' || snapshot.turn.kind === 'waiting-permission') {
    return { status: 'Waiting', title: 'The Mandible-owned turn is waiting.', composer, submitLabel };
  }
  if (snapshot.turn.kind === 'completed') {
    return { status: 'Completed', title: 'The latest Mandible-owned turn completed.', composer, submitLabel };
  }
  if (snapshot.turn.kind === 'failed') {
    return { status: 'Failed', title: 'The latest Mandible-owned turn failed.', composer, submitLabel };
  }
  if (snapshot.turn.kind === 'cancelled') {
    return { status: 'Stopped', title: 'The latest Mandible-owned turn was stopped.', composer, submitLabel };
  }
  if (snapshot.controller.kind === 'starting') {
    return { status: 'Starting', title: 'Mandible is starting the controller.', composer, submitLabel };
  }
  if (snapshot.controller.kind === 'running') {
    return { status: 'Running', title: 'The Mandible-owned controller is running.', composer, submitLabel };
  }
  if (snapshot.controller.kind === 'waiting') {
    return { status: 'Waiting', title: 'The Mandible-owned controller is waiting.', composer, submitLabel };
  }
  if (snapshot.controller.kind === 'failed') {
    return { status: 'Failed', title: 'The Mandible-owned controller failed.', composer, submitLabel };
  }
  if (snapshot.controller.kind === 'stopping') {
    return { status: 'Stopping', title: 'The Mandible-owned controller is stopping.', composer, submitLabel };
  }
  if (capability.kind === 'unavailable') {
    return { status: 'Unavailable', title: `Continuation unavailable: ${capability.reason}.`, composer, submitLabel };
  }
  if (snapshot.controller.kind === 'stopped') {
    return { status: 'Stopped', title: 'The controller is stopped.', composer, submitLabel };
  }
  return { status: 'Ready', title: 'Mandible owns this provider session.', composer, submitLabel };
}
