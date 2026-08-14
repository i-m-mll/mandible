import {
  MANAGED_REMINDER_SCHEMA,
  type ManagedReminderCreateRequest,
  type ManagedReminderPayload,
  type ManagedReminderPredicate,
} from "./contracts.js";

export class ManagedReminderValidationError extends Error {
  constructor(message: string, public readonly status = 400, public readonly code = "invalid_reminder") {
    super(message);
    this.name = "ManagedReminderValidationError";
  }
}

function record(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ManagedReminderValidationError(`${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

function rejectUnknown(value: Record<string, unknown>, allowed: readonly string[], field: string): void {
  const extras = Object.keys(value).filter((key) => !allowed.includes(key)).sort();
  if (extras.length) {
    throw new ManagedReminderValidationError(`${field} has unknown field(s): ${extras.join(", ")}`);
  }
}

function nonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new ManagedReminderValidationError(`${field} must be a non-empty string`);
  }
  return value.trim();
}

function optionalNonEmptyString(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  return nonEmptyString(value, field);
}

function validCalendarDate(year: number, month: number, day: number): boolean {
  if (month < 1 || month > 12 || day < 1) return false;
  const days = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return day <= days;
}

/** Strict RFC 3339 input, rendered as one canonical UTC ISO instant. */
export function canonicalizeReminderInstant(value: unknown): string {
  const input = nonEmptyString(value, "predicate.at");
  const match = input.match(
    /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(?:[Zz]|([+-])(\d{2}):(\d{2}))$/,
  );
  if (!match) {
    throw new ManagedReminderValidationError("predicate.at must be an absolute RFC 3339 instant");
  }
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, , , offsetHour, offsetMinute] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  if (
    !validCalendarDate(year, month, day) || Number(hourText) > 23 ||
    Number(minuteText) > 59 || Number(secondText) > 59 ||
    (offsetHour !== undefined && (Number(offsetHour) > 23 || Number(offsetMinute) > 59))
  ) {
    throw new ManagedReminderValidationError("predicate.at is not a valid RFC 3339 instant");
  }
  const epoch = Date.parse(input);
  if (!Number.isFinite(epoch)) {
    throw new ManagedReminderValidationError("predicate.at is not a valid RFC 3339 instant");
  }
  return new Date(epoch).toISOString();
}

export function parseManagedReminderCreateRequest(body: unknown): ManagedReminderCreateRequest {
  const input = record(body, "request body");
  rejectUnknown(input, ["schema", "idempotency_key", "project", "message", "predicate"], "request body");
  if (input.schema !== MANAGED_REMINDER_SCHEMA) {
    throw new ManagedReminderValidationError(`schema must be '${MANAGED_REMINDER_SCHEMA}'`);
  }
  const predicate = record(input.predicate, "predicate");
  const kind = nonEmptyString(predicate.kind, "predicate.kind");
  let parsedPredicate: ManagedReminderCreateRequest["predicate"];
  if (kind === "at") {
    rejectUnknown(predicate, ["kind", "at"], "predicate");
    parsedPredicate = { kind, at: canonicalizeReminderInstant(predicate.at) };
  } else if (kind === "issue_closed") {
    rejectUnknown(predicate, ["kind", "issue"], "predicate");
    parsedPredicate = { kind, issue: nonEmptyString(predicate.issue, "predicate.issue") };
  } else if (kind === "auth_merge_count_gte") {
    rejectUnknown(
      predicate,
      ["kind", "project", "base_branch", "canonical_message", "threshold"],
      "predicate",
    );
    if (!Number.isInteger(predicate.threshold) || (predicate.threshold as number) <= 0) {
      throw new ManagedReminderValidationError("predicate.threshold must be a positive integer");
    }
    if (predicate.canonical_message !== undefined && typeof predicate.canonical_message !== "boolean") {
      throw new ManagedReminderValidationError("predicate.canonical_message must be a boolean");
    }
    parsedPredicate = {
      kind,
      project: nonEmptyString(predicate.project, "predicate.project"),
      base_branch: optionalNonEmptyString(predicate.base_branch, "predicate.base_branch"),
      canonical_message: predicate.canonical_message as boolean | undefined,
      threshold: predicate.threshold as number,
    };
  } else {
    throw new ManagedReminderValidationError(
      "predicate.kind must be one of: at, issue_closed, auth_merge_count_gte",
    );
  }
  return {
    schema: MANAGED_REMINDER_SCHEMA,
    idempotency_key: nonEmptyString(input.idempotency_key, "idempotency_key"),
    project: nonEmptyString(input.project, "project"),
    message: nonEmptyString(input.message, "message"),
    predicate: parsedPredicate,
  };
}

/** Stable key order is part of the idempotency digest contract. */
export function canonicalReminderPayloadJson(payload: ManagedReminderPayload): string {
  const predicate: Record<string, unknown> = { kind: payload.predicate.kind };
  if (payload.predicate.kind === "at") predicate.at = payload.predicate.at;
  if (payload.predicate.kind === "issue_closed") predicate.issue_id = payload.predicate.issue_id;
  if (payload.predicate.kind === "auth_merge_count_gte") {
    predicate.project_id = payload.predicate.project_id;
    if (payload.predicate.base_branch !== undefined) predicate.base_branch = payload.predicate.base_branch;
    if (payload.predicate.canonical_message !== undefined) {
      predicate.canonical_message = payload.predicate.canonical_message;
    }
    predicate.threshold = payload.predicate.threshold;
  }
  return JSON.stringify({
    schema: MANAGED_REMINDER_SCHEMA,
    message: payload.message,
    predicate,
    effect: { kind: "inbox_occurrence" },
  });
}

export function parseStoredReminderPayload(value: string): ManagedReminderPayload {
  const parsed = JSON.parse(value) as ManagedReminderPayload;
  if (parsed.schema !== MANAGED_REMINDER_SCHEMA || parsed.effect?.kind !== "inbox_occurrence") {
    throw new ManagedReminderValidationError("stored reminder payload violates mandible-reminder@1");
  }
  return parsed;
}

export type CanonicalManagedReminderPredicate = ManagedReminderPredicate;
