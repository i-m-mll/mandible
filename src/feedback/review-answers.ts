import { randomUUID } from "node:crypto";
import { canonicalJson } from "../canonical-json.js";
import type { FeedbackResponseType, FeedbackResponseValue } from "../contracts.js";
import type { Db } from "../db.js";
import { requestOriginJson } from "../request-origin.js";
import { BriefingStoreError } from "./briefing-errors.js";

export function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new BriefingStoreError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

export function only(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  const extra = Object.keys(value).filter((key) => !keys.includes(key));
  if (extra.length > 0) throw new BriefingStoreError(`${label} contains unsupported field '${extra[0]}'`);
}

export function text(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new BriefingStoreError(`${label} must be a nonblank string`);
  return value.trim();
}

export function validateValue(responseType: FeedbackResponseType, value: unknown, optionsJson: string, variantsJson = "[]"): FeedbackResponseValue {
  const payload = record(value, "answer.value");
  const options = JSON.parse(optionsJson) as Array<{ key: string }>;
  if (responseType === "verdict") {
    only(payload, ["verdict"], "answer.value");
    if (payload.verdict !== "keep" && payload.verdict !== "dismiss") {
      throw new BriefingStoreError("verdict must be keep or dismiss");
    }
    return { verdict: payload.verdict } as FeedbackResponseValue;
  } else if (responseType === "single_choice" || responseType === "text_variant") {
    const allowed = responseType === "text_variant" ? JSON.parse(variantsJson) as Array<{ key: string }> : options;
    only(payload, ["option_key"], "answer.value");
    if (typeof payload.option_key !== "string" || !allowed.some((option) => option.key === payload.option_key)) {
      throw new BriefingStoreError("option_key must name one defined option");
    }
    return { option_key: payload.option_key };
  } else if (responseType === "multi_choice") {
    only(payload, ["option_keys"], "answer.value");
    if (!Array.isArray(payload.option_keys) || payload.option_keys.length === 0
        || payload.option_keys.some((key) => typeof key !== "string")) {
      throw new BriefingStoreError("option_keys must be a nonempty string array");
    }
    const supplied = new Set(payload.option_keys as string[]);
    if (supplied.size !== payload.option_keys.length
        || [...supplied].some((key) => !options.some((option) => option.key === key))) {
      throw new BriefingStoreError("option_keys must be unique defined options");
    }
    return { option_keys: options.map((option) => option.key).filter((key) => supplied.has(key)) };
  } else if (responseType === "short_text" || responseType === "long_text") {
    only(payload, ["text"], "answer.value");
    const maximum = responseType === "short_text" ? 240 : 4000;
    if (typeof payload.text !== "string" || !payload.text.trim() || payload.text.length > maximum) {
      throw new BriefingStoreError(`text must be nonblank and at most ${maximum} UTF-16 code units`);
    }
    return { text: payload.text };
  } else if (responseType === "rating") {
    only(payload, ["rating"], "answer.value");
    if (!Number.isSafeInteger(payload.rating) || (payload.rating as number) < 1 || (payload.rating as number) > 5) {
      throw new BriefingStoreError("rating must be a safe integer from 1 through 5");
    }
    return { rating: payload.rating as number };
  } else {
    throw new BriefingStoreError(`response type '${responseType}' is not supported by this Briefing profile`);
  }
}


type ResponseOwner = { roundId: string; actorUserId: string } &
  ({ briefingId: string; bindingId?: never } | { briefingId?: never; bindingId: string });
type ResponseDirective = { id: string; response_type: FeedbackResponseType; options_json: string; variants_json: string };

function currentDirectiveResponse(db: Db, roundId: string, directiveId: string, actorUserId: string) {
  return db.prepare(
    `SELECT e.id, e.value_json FROM briefing_response_events e
      WHERE e.round_id = ? AND e.directive_instance_id = ? AND e.actor_user_id = ? AND e.operation = 'set'
        AND NOT EXISTS (SELECT 1 FROM briefing_response_events r WHERE r.retracts_event_id = e.id)
      ORDER BY e.created_at DESC, e.rowid DESC LIMIT 1`,
  ).get(roundId, directiveId, actorUserId) as { id: string; value_json: string } | null;
}

export function readDirectiveAnswer(db: Db, roundId: string, directiveId: string, actorUserId: string) {
  const answer = currentDirectiveResponse(db, roundId, directiveId, actorUserId);
  return answer ? { response_event_id: answer.id, value: JSON.parse(answer.value_json) as FeedbackResponseValue } : null;
}

export function appendDirectiveAnswer(db: Db, owner: ResponseOwner, directive: ResponseDirective, answer: Record<string, unknown>, now: number): string {
  const { roundId, actorUserId } = owner;
  const current = currentDirectiveResponse(db, roundId, directive.id, actorUserId);
  const validate = (value: unknown) => validateValue(directive.response_type, value, directive.options_json, directive.variants_json);
  if (current) {
    let parsed: unknown;
    try { parsed = JSON.parse(current.value_json); } catch {
      throw new BriefingStoreError("stored answer is not valid JSON", 409, "invalid_stored_answer");
    }
    if (canonicalJson(validate(parsed)) !== current.value_json) {
      throw new BriefingStoreError("stored answer is not canonical for its directive", 409, "invalid_stored_answer");
    }
  }
  const expected = answer.expected_response_event_id === null
    ? null : text(answer.expected_response_event_id, "answer.expected_response_event_id");
  if ((current?.id ?? null) !== expected) throw new BriefingStoreError("answer changed since it was read", 409, "stale_answer");
  const insert = (operation: "set" | "retract", value: string | null, retracts: string | null) => {
    const id = randomUUID();
    db.prepare(`INSERT INTO briefing_response_events
      (request_origin_json, id, round_id, briefing_id, document_binding_id, directive_instance_id,
       operation, value_json, retracts_event_id, actor_user_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(requestOriginJson(), id, roundId, owner.briefingId ?? null, owner.bindingId ?? null, directive.id,
        operation, value, retracts, actorUserId, now);
    return id;
  };
  if (answer.operation === "retract") {
    if (Object.hasOwn(answer, "value") || !current) throw new BriefingStoreError("retract requires one current answer and no value");
    return insert("retract", null, current.id);
  }
  if (!Object.hasOwn(answer, "value")) throw new BriefingStoreError("set requires value");
  const serialized = canonicalJson(validate(answer.value));
  if (current?.value_json === serialized) throw new BriefingStoreError("answer is unchanged", 409, "answer_noop");
  if (current) insert("retract", null, current.id);
  return insert("set", serialized, null);
}
