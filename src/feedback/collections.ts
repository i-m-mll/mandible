import { randomUUID } from "node:crypto";

import type {
  FeedbackCollectionListState,
  FeedbackCollectionProjection,
} from "../contracts.js";
import type { Db } from "../db.js";

export type { FeedbackCollectionListState, FeedbackCollectionProjection } from "../contracts.js";

export class FeedbackCollectionStoreError extends Error {
  constructor(
    message: string,
    public readonly status = 400,
    public readonly code = "invalid_feedback_collection",
  ) {
    super(message);
    this.name = "FeedbackCollectionStoreError";
  }
}

// updated_at is one kind-independent activity clock: collection creation,
// lifecycle activity (with a passed deadline represented at its semantic
// transition time), publication receipt, response events, and comments all
// compete in the same MAX expression below.
const COLLECTION_FACTS_SQL = `
  WITH lifecycle_heads AS (
    SELECT events.collection_id, events.id, events.operation, events.created_at
      FROM feedback_collection_events events
     WHERE NOT EXISTS (
       SELECT 1
         FROM feedback_collection_events successor
        WHERE successor.collection_id = events.collection_id
          AND successor.previous_event_id = events.id
     )
  ),
  collection_sources AS (
    SELECT collections.id,
           collections.kind,
           collections.interaction_mode,
           collections.source,
           collections.created_at,
           collections.tombstoned_at,
           asks.request_key,
           asks.requester_user_id,
           asks.responder_user_ids_json,
           CASE collections.kind
             WHEN 'recurring_feed' THEN collections.expires_at
             WHEN 'bounded_ask' THEN asks.expires_at
             ELSE NULL
           END AS expires_at
      FROM feedback_collections collections
      LEFT JOIN feedback_ask_sessions asks ON asks.collection_id = collections.id
  ),
  collection_facts AS (
    SELECT collections.id,
           collections.kind,
           collections.interaction_mode,
           collections.source,
           COALESCE(collections.source, collections.request_key,
                    'Collection ' || substr(collections.id, 1, 8)) AS label,
           CASE
             WHEN collections.tombstoned_at IS NOT NULL THEN 'expired'
             WHEN heads.operation IS NOT NULL AND heads.operation != 'opened' THEN 'expired'
             WHEN collections.expires_at IS NOT NULL AND collections.expires_at <= @now THEN 'expired'
             ELSE 'open'
           END AS state,
           collections.expires_at,
           collections.created_at,
           MAX(
             collections.created_at,
             COALESCE(
               CASE
                 WHEN collections.expires_at IS NOT NULL
                  AND collections.expires_at <= @now
                  AND heads.operation IN ('opened', 'expired')
                   THEN collections.expires_at
                 ELSE heads.created_at
               END,
               0
             ),
             COALESCE((SELECT MAX(publications.received_at)
                         FROM feedback_publications publications
                        WHERE publications.collection_id = collections.id), 0),
             COALESCE((SELECT MAX(responses.created_at)
                         FROM feedback_response_events responses
                        WHERE responses.collection_id = collections.id), 0),
             COALESCE((SELECT MAX(comments.created_at)
                         FROM feedback_comments comments
                        WHERE comments.collection_id = collections.id), 0)
           ) AS updated_at,
           (SELECT COUNT(*)
              FROM feedback_items items
             WHERE items.collection_id = collections.id
               AND items.tombstoned_at IS NULL) AS item_count,
           CASE
             WHEN collections.tombstoned_at IS NULL
              AND heads.operation IN ('opened', 'expired')
              AND (
                collections.expires_at IS NOT NULL
                OR EXISTS (
                  SELECT 1
                    FROM feedback_collection_events expiry_events
                   WHERE expiry_events.collection_id = collections.id
                     AND expiry_events.operation = 'expired'
                )
              ) THEN 1
             ELSE 0
           END AS expiry_reversible
      FROM collection_sources collections
      LEFT JOIN lifecycle_heads heads ON heads.collection_id = collections.id
     WHERE collections.kind = 'recurring_feed'
        OR @operator = 1
        OR collections.requester_user_id = @requester_user_id
        OR EXISTS (
          SELECT 1 FROM json_each(collections.responder_user_ids_json) audience
           WHERE audience.value = @responder_user_id
        )
  )
`;

export function listFeedbackCollections(
  db: Db,
  options: {
    requesterUserId?: string | null;
    responderUserId?: string | null;
    operator: boolean;
    state?: FeedbackCollectionListState;
    now?: number;
  },
): FeedbackCollectionProjection[] {
  const state = options.state ?? "all";
  if (state !== "all" && state !== "open" && state !== "expired") {
    throw new FeedbackCollectionStoreError("state must be one of all, open, or expired");
  }
  return db.prepare(
    `${COLLECTION_FACTS_SQL}
     SELECT id, kind, interaction_mode, source, label, state,
            expires_at, created_at, updated_at, item_count, expiry_reversible
       FROM collection_facts
      WHERE @state = 'all' OR state = @state
      ORDER BY updated_at DESC, id ASC`,
  ).all({
    requester_user_id: options.requesterUserId ?? null,
    responder_user_id: options.responderUserId ?? null,
    operator: options.operator ? 1 : 0,
    state,
    now: options.now ?? Date.now(),
  }) as FeedbackCollectionProjection[];
}

export function feedbackCollectionAudienceAllows(
  db: Db,
  collectionId: string,
  actorUserId: string,
): boolean {
  return Boolean(db.prepare(
    `SELECT 1
       FROM feedback_ask_sessions asks,
            json_each(asks.responder_user_ids_json) audience
      WHERE asks.collection_id = ? AND audience.value = ?
      LIMIT 1`,
  ).get(collectionId, actorUserId));
}

type LifecycleHead = {
  id: string;
  operation: "opened" | "submitted" | "expired" | "cancelled" | "closed";
};

function collectionLifecycleHead(db: Db, collectionId: string): LifecycleHead | null {
  return (db.prepare(
    `SELECT events.id, events.operation
       FROM feedback_collection_events events
      WHERE events.collection_id = ?
        AND NOT EXISTS (
          SELECT 1
            FROM feedback_collection_events successor
           WHERE successor.collection_id = events.collection_id
             AND successor.previous_event_id = events.id
        )
      LIMIT 1`,
  ).get(collectionId) as LifecycleHead | undefined) ?? null;
}

export function setFeedbackCollectionExpiry(
  db: Db,
  collectionId: string,
  expiresAt: number | null,
  options: { actorUserId: string; now?: number },
): FeedbackCollectionProjection {
  if (expiresAt !== null && !Number.isSafeInteger(expiresAt)) {
    throw new FeedbackCollectionStoreError("expires_at must be an integer or null");
  }
  const now = options.now ?? Date.now();
  const transaction = db.transaction(() => {
    const collection = db.prepare(
      "SELECT id, kind FROM feedback_collections WHERE id = ?",
    ).get(collectionId) as { id: string; kind: "recurring_feed" | "bounded_ask" } | undefined;
    if (!collection) {
      throw new FeedbackCollectionStoreError("feedback collection not found", 404, "not_found");
    }
    const head = collectionLifecycleHead(db, collectionId);
    if (!head) {
      throw new FeedbackCollectionStoreError(
        "feedback collection lifecycle is invalid",
        409,
        "collection_lifecycle_invalid",
      );
    }
    if (collection.kind === "recurring_feed") {
      db.prepare("UPDATE feedback_collections SET expires_at = ? WHERE id = ?")
        .run(expiresAt, collectionId);
    } else {
      const result = db.prepare("UPDATE feedback_ask_sessions SET expires_at = ? WHERE collection_id = ?")
        .run(expiresAt, collectionId);
      if (result.changes !== 1) {
        throw new FeedbackCollectionStoreError(
          "bounded ask session is missing",
          409,
          "collection_kind_record_missing",
        );
      }
    }

    const expiresNow = expiresAt !== null && expiresAt <= now;
    const nextOperation = expiresNow && head.operation === "opened"
      ? "expired"
      : !expiresNow && head.operation === "expired"
        ? "opened"
        : null;
    if (nextOperation) {
      db.prepare(
        `INSERT INTO feedback_collection_events
           (id, collection_id, operation, previous_event_id, actor_user_id, metadata_json, created_at)
         VALUES (?, ?, ?, ?, ?, '{"reason":"collection_expiry"}', ?)`,
      ).run(randomUUID(), collectionId, nextOperation, head.id, options.actorUserId, now);
    }

    const projection = listFeedbackCollections(db, {
      operator: true,
      now,
    }).find((entry) => entry.id === collectionId);
    if (!projection) throw new Error("updated feedback collection projection is missing");
    return projection;
  });
  return transaction.immediate();
}
