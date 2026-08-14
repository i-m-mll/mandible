import type { ManagedReminderPayload } from "./contracts.js";

export interface ReminderEvaluationEvidence {
  occurrence_key: string;
  evidence: Record<string, unknown>;
}

/** The evaluator can observe predicates and append only the bounded first-party effect. */
export interface ReminderDatabaseCapability {
  evaluatePredicate(payload: ManagedReminderPayload, now: number): ReminderEvaluationEvidence | null;
  appendInboxOccurrence(evaluation: ReminderEvaluationEvidence, now: number): boolean;
}

export function evaluateManagedReminder(
  capability: ReminderDatabaseCapability,
  payload: ManagedReminderPayload,
  now: number,
): boolean {
  const evaluation = capability.evaluatePredicate(payload, now);
  return evaluation ? capability.appendInboxOccurrence(evaluation, now) : false;
}
