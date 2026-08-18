import { createHash } from "node:crypto";

import { readArtifactBytesFull } from "../artifact-content.js";
import type { Db } from "../db.js";
import { tableExists } from "../db-introspection.js";
import { getCanonicalArtifactVersion, recordArtifactVersion } from "../provider-artifacts.js";
import { BRIEFING_PROFILE, parseBriefingDirectives } from "./briefing-directives.js";
import { CANONICAL_AGENT_DISPATCH_SQL, CANONICAL_SPACE_ITEMS_SQL, LEGACY_FEEDBACK_DROP_SQL } from "./schema.js";

type LegacyCollection = {
  id: string;
  kind: string;
  source: string | null;
  created_at: number;
};

function stableId(prefix: string, ...parts: Array<string | number>): string {
  return `${prefix}:${createHash("sha256").update(parts.join("\0")).digest("hex")}`;
}

function safeDirectiveKey(value: string, itemId: string): string {
  return /^[A-Za-z0-9._-]{1,128}$/.test(value)
    ? value
    : `legacy-${createHash("sha256").update(itemId).digest("hex").slice(0, 24)}`;
}

function quotedJsonRows(db: Db, table: string, collectionId: string): unknown[] {
  const columns = (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((row) => row.name);
  if (columns.includes("collection_id")) {
    return db.prepare(`SELECT * FROM ${table} WHERE collection_id = ? ORDER BY rowid`).all(collectionId) as unknown[];
  }
  return [];
}

function legacyProvenance(db: Db, collection: LegacyCollection): Record<string, unknown> {
  const items = db.prepare("SELECT * FROM feedback_items WHERE collection_id = ? ORDER BY rowid")
    .all(collection.id) as Array<{ id: string }>;
  const itemIds = items.map((item) => item.id);
  const byItems = (table: string, column: string): unknown[] => itemIds.length === 0 ? [] : db.prepare(
    `SELECT * FROM ${table} WHERE ${column} IN (${itemIds.map(() => "?").join(",")}) ORDER BY rowid`,
  ).all(...itemIds) as unknown[];
  const revisions = byItems("feedback_item_revisions", "item_id") as Array<{ id: string }>;
  const revisionIds = revisions.map((revision) => revision.id);
  const byRevisions = (table: string, column: string): unknown[] => revisionIds.length === 0 ? [] : db.prepare(
    `SELECT * FROM ${table} WHERE ${column} IN (${revisionIds.map(() => "?").join(",")}) ORDER BY rowid`,
  ).all(...revisionIds) as unknown[];
  const submissions = quotedJsonRows(db, "feedback_submissions", collection.id) as Array<{ id: string }>;
  const submissionIds = submissions.map((submission) => submission.id);
  const bySubmissions = (table: string): unknown[] => submissionIds.length === 0 ? [] : db.prepare(
    `SELECT * FROM ${table} WHERE submission_id IN (${submissionIds.map(() => "?").join(",")}) ORDER BY rowid`,
  ).all(...submissionIds) as unknown[];
  return {
    schema: "mandible.legacy-feedback-audit.v1",
    collection,
    recurring_profiles: quotedJsonRows(db, "feedback_recurring_profiles", collection.id),
    ask_sessions: quotedJsonRows(db, "feedback_ask_sessions", collection.id),
    documents: quotedJsonRows(db, "feedback_collection_documents", collection.id),
    publications: quotedJsonRows(db, "feedback_publications", collection.id),
    items,
    item_revisions: revisions,
    item_options: byRevisions("feedback_item_options", "revision_id"),
    item_directives: quotedJsonRows(db, "feedback_item_directives", collection.id),
    collection_events: quotedJsonRows(db, "feedback_collection_events", collection.id),
    item_events: byItems("feedback_item_events", "item_id"),
    response_events: quotedJsonRows(db, "feedback_response_events", collection.id),
    comments: quotedJsonRows(db, "feedback_comments", collection.id),
    annotation_events: quotedJsonRows(db, "feedback_annotation_events", collection.id),
    submissions,
    submission_answers: bySubmissions("feedback_submission_answers"),
    submission_annotations: bySubmissions("feedback_submission_annotations"),
  };
}

function synthesizeDocument(db: Db, collection: LegacyCollection): {
  source: string;
  itemByKey: Map<string, { item_id: string; revision_id: string }>;
} {
  const rows = db.prepare(
    `SELECT i.id AS item_id, i.external_key, i.client_item_key, r.id AS revision_id,
            r.title, r.prompt, r.required
       FROM feedback_items i
       JOIN feedback_item_revisions r ON r.id = i.current_revision_id
      WHERE i.collection_id = ? AND i.item_kind = 'item'
      ORDER BY r.position, i.created_at, i.id`,
  ).all(collection.id) as Array<{
    item_id: string;
    external_key: string | null;
    client_item_key: string | null;
    revision_id: string;
    title: string;
    prompt: string;
    required: number;
  }>;
  const itemByKey = new Map<string, { item_id: string; revision_id: string }>();
  const lines = [`# ${collection.source ?? "Legacy Briefing"}`, ""];
  for (const row of rows) {
    const key = safeDirectiveKey(row.client_item_key ?? row.external_key ?? row.item_id, row.item_id);
    itemByKey.set(key, { item_id: row.item_id, revision_id: row.revision_id });
    lines.push(`## ${row.title}`, "", `:::spec-item{key=\"${key}\" required=\"${row.required ? "true" : "false"}\"}`,
      row.prompt.trim() || row.title, ":::", "");
  }
  if (itemByKey.size === 0) {
    const key = `legacy-${createHash("sha256").update(collection.id).digest("hex").slice(0, 24)}`;
    lines.push(`:::spec-item{key=\"${key}\" required=\"false\"}`, "No response requested.", ":::", "");
  }
  return { source: `${lines.join("\n")}\n`, itemByKey };
}

function pinnedLegacyDocument(db: Db, collectionId: string): { versionId: string; source: string } | null {
  const row = db.prepare(
    "SELECT artifact_version_id, profile FROM feedback_collection_documents WHERE collection_id = ?",
  ).get(collectionId) as { artifact_version_id: string; profile: string | null } | undefined;
  if (!row || row.profile !== BRIEFING_PROFILE) return null;
  const version = getCanonicalArtifactVersion(db, row.artifact_version_id);
  if (!version) return null;
  const bytes = readArtifactBytesFull(db, version.id);
  if (!bytes.ok || createHash("sha256").update(bytes.bytes).digest("hex") !== version.content_hash) return null;
  try {
    const source = new TextDecoder("utf-8", { fatal: true }).decode(bytes.bytes);
    parseBriefingDirectives(source);
    return { versionId: version.id, source };
  } catch {
    return null;
  }
}

/**
 * Lean v142 conversion. Exact frozen legacy submissions are copied; all other
 * bytes remain in the immutable audit packet instead of being interpreted.
 */
export function migrateLegacyFeedbackToBriefings(db: Db, now = Date.now()): void {
  const legacyPresent = Boolean(db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'feedback_collections'",
  ).get());
  const collections = legacyPresent
    ? db.prepare("SELECT id, kind, source, created_at FROM feedback_collections ORDER BY created_at, id").all() as LegacyCollection[]
    : [];
  for (const collection of collections) {
    const provenance = legacyProvenance(db, collection);
    const ask = db.prepare(
      "SELECT request_key, responder_user_ids_json FROM feedback_ask_sessions WHERE collection_id = ?",
    ).get(collection.id) as { request_key: string; responder_user_ids_json: string } | undefined;
    const briefingId = stableId("briefing", "legacy", collection.id);
    const title = collection.source ?? ask?.request_key ?? `Legacy Briefing ${collection.id.slice(0, 8)}`;
    db.prepare(
      `INSERT INTO briefings (id, briefing_key, title, latest_round_id, round_count, created_at, updated_at)
       VALUES (?, ?, ?, NULL, 0, ?, ?)`,
    ).run(briefingId, `legacy:${collection.id}`, title, collection.created_at, collection.created_at);

    const actors = new Set<string>();
    if (ask) {
      try { for (const id of JSON.parse(ask.responder_user_ids_json) as string[]) actors.add(id); } catch { /* sealed below */ }
    }
    for (const row of db.prepare("SELECT DISTINCT actor_user_id FROM feedback_response_events WHERE collection_id = ?")
      .all(collection.id) as Array<{ actor_user_id: string }>) actors.add(row.actor_user_id);
    for (const actor of actors) {
      if (db.prepare("SELECT 1 FROM users WHERE id = ? AND status = 'active'").get(actor)) {
        db.prepare("INSERT OR IGNORE INTO briefing_members (briefing_id, user_id, created_at) VALUES (?, ?, ?)")
          .run(briefingId, actor, now);
      }
    }

    const pinned = pinnedLegacyDocument(db, collection.id);
    const synthesized = synthesizeDocument(db, collection);
    const source = pinned?.source ?? synthesized.source;
    const artifactVersionId = pinned?.versionId ?? recordArtifactVersion(db, {
      source_kind: "managed",
      content: source,
      series_key: `mandible:briefing:${briefingId}`,
      logical_name: `${collection.id}.md`,
      title,
      role: "briefing-document",
      media_type: "text/markdown",
      metadata: { migrated_from_feedback_collection: collection.id, profile: BRIEFING_PROFILE },
    }, now).version.id;
    const directives = parseBriefingDirectives(source);
    const bindingDigest = createHash("sha256")
      .update(JSON.stringify(directives.map((directive) => [directive.key, directive.definition_digest])))
      .digest("hex");
    const roundId = stableId("briefing-round", collection.id);
    db.prepare(
      `INSERT INTO briefing_rounds
        (id, briefing_id, ordinal, artifact_version_id, previous_round_id, profile, binding_digest, created_at)
       VALUES (?, ?, 1, ?, NULL, ?, ?, ?)`,
    ).run(roundId, briefingId, artifactVersionId, BRIEFING_PROFILE, bindingDigest, collection.created_at);
    db.prepare("UPDATE briefings SET latest_round_id = ?, round_count = 1 WHERE id = ?")
      .run(roundId, briefingId);

    const legacyBindings = db.prepare(
      `SELECT d.directive_key, i.id AS item_id, d.item_revision_id
         FROM feedback_item_directives d JOIN feedback_item_revisions r ON r.id = d.item_revision_id
         JOIN feedback_items i ON i.id = r.item_id WHERE d.collection_id = ?`,
    ).all(collection.id) as Array<{ directive_key: string; item_id: string; item_revision_id: string }>;
    const legacyByKey = new Map(legacyBindings.map((row) => [row.directive_key, {
      item_id: row.item_id, revision_id: row.item_revision_id,
    }]));
    const instanceByLegacyItem = new Map<string, string>();
    directives.forEach((directive, position) => {
      const definitionId = stableId("briefing-directive", artifactVersionId, directive.key);
      const instanceId = stableId("briefing-instance", roundId, directive.key);
      db.prepare(
        `INSERT OR IGNORE INTO briefing_directive_definitions
          (id, artifact_version_id, directive_key, definition_digest, response_type, required, prompt,
           options_json, start_offset, end_offset, body_start_offset, body_end_offset, created_at)
         VALUES (?, ?, ?, ?, 'verdict', ?, ?, '[]', ?, ?, ?, ?, ?)`,
      ).run(definitionId, artifactVersionId, directive.key, directive.definition_digest,
        directive.required ? 1 : 0, directive.body, directive.start_offset, directive.end_offset,
        directive.body_start_offset, directive.body_end_offset, now);
      db.prepare(
        `INSERT INTO briefing_directive_instances
          (id, round_id, definition_id, directive_key, position, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(instanceId, roundId, definitionId, directive.key, position, now);
      const legacy = legacyByKey.get(directive.key) ?? synthesized.itemByKey.get(directive.key);
      if (legacy) instanceByLegacyItem.set(legacy.item_id, instanceId);
    });

    let exact = 0;
    const representedResponseIds = new Set<string>();
    const submissions = db.prepare(
      "SELECT id, ordinal, supersedes_submission_id, actor_user_id, created_at FROM feedback_submissions WHERE collection_id = ? ORDER BY ordinal",
    ).all(collection.id) as Array<{ id: string; ordinal: number; supersedes_submission_id: string | null; actor_user_id: string; created_at: number }>;
    const migratedSubmissionIds = new Map<string, string>();
    for (const submission of submissions) {
      const answers = db.prepare(
        `SELECT a.item_id, a.response_event_id, a.position, e.value_json
           FROM feedback_submission_answers a JOIN feedback_response_events e ON e.id = a.response_event_id
          WHERE a.submission_id = ? ORDER BY a.position`,
      ).all(submission.id) as Array<{ item_id: string; response_event_id: string; position: number; value_json: string }>;
      if (answers.some((answer) => !instanceByLegacyItem.has(answer.item_id))) continue;
      const newSubmissionId = stableId("briefing-submission", submission.id);
      db.prepare(
        `INSERT INTO briefing_submissions
          (id, round_id, ordinal, supersedes_submission_id, actor_user_id, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(newSubmissionId, roundId, submission.ordinal,
        submission.supersedes_submission_id ? migratedSubmissionIds.get(submission.supersedes_submission_id) ?? null : null,
        submission.actor_user_id, submission.created_at);
      for (const answer of answers) {
        representedResponseIds.add(answer.response_event_id);
        const eventId = stableId("briefing-response", answer.response_event_id);
        const instanceId = instanceByLegacyItem.get(answer.item_id) as string;
        db.prepare(
          `INSERT INTO briefing_response_events
            (id, round_id, directive_instance_id, operation, value_json, retracts_event_id, actor_user_id, created_at)
           VALUES (?, ?, ?, 'set', ?, NULL, ?, ?)`,
        ).run(eventId, roundId, instanceId, answer.value_json, submission.actor_user_id, submission.created_at);
        db.prepare(
          `INSERT INTO briefing_submission_answers
            (submission_id, directive_instance_id, response_event_id, position) VALUES (?, ?, ?, ?)`,
        ).run(newSubmissionId, instanceId, eventId, answer.position);
      }
      migratedSubmissionIds.set(submission.id, newSubmissionId);
      exact += 1;
    }
    const legacyResponseIds = (provenance.response_events as Array<{ id: string }>).map((event) => event.id);
    const hasSealedOnlyHistory = legacyResponseIds.some((id) => !representedResponseIds.has(id))
      || (provenance.comments as unknown[]).length > 0
      || (provenance.annotation_events as unknown[]).length > 0;
    const disposition = exact === submissions.length && !hasSealedOnlyHistory
      ? "reconstructed" : "sealed_ambiguous";
    const reason = disposition === "reconstructed"
      ? `reconstructed ${exact} exact frozen submission(s)`
      : `reconstructed ${exact} exact frozen submission(s); sealed non-round or unmappable legacy history`;
    db.prepare(
      `INSERT INTO briefing_legacy_audit
        (id, legacy_collection_id, disposition, reason, provenance_json, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(stableId("briefing-audit", collection.id), collection.id, disposition, reason, JSON.stringify(provenance), now);
  }
  // Finding dispatch was a product-kind alias. Preserve its exact legacy rows
  // in audit provenance, then rebuild the live dispatch surface for the two
  // canonical subject kinds before dropping its referenced tables.
  if (tableExists(db, "agent_dispatch_events")) {
    const findingDispatches = db.prepare(
      "SELECT * FROM agent_dispatch_events WHERE subject_kind = 'finding' ORDER BY created_at, id",
    ).all();
    if (findingDispatches.length > 0) {
      db.prepare(
        `INSERT INTO briefing_legacy_audit
          (id, legacy_collection_id, disposition, reason, provenance_json, created_at)
         VALUES (?, ?, 'sealed_ambiguous', ?, ?, ?)`,
      ).run(stableId("briefing-audit", "finding-dispatches"), "finding-dispatches",
        "sealed retired finding dispatch events as immutable audit provenance",
        JSON.stringify({ agent_dispatch_events: findingDispatches }), now);
    }
    db.exec("CREATE TEMP TABLE agent_dispatch_events_v142 AS SELECT * FROM agent_dispatch_events WHERE subject_kind IN ('issue','incident')");
    db.exec("DROP TABLE agent_dispatch_events");
    db.exec(CANONICAL_AGENT_DISPATCH_SQL);
    db.exec(`INSERT INTO agent_dispatch_events
      SELECT id, subject_kind, issue_id, incident_id, incident_telemetry_sha256,
             actor_user_id, provider, instruction, cwd, prompt_path, prompt_sha256,
             status, session_handle, session_id, attach_command, error, created_at, settled_at
        FROM agent_dispatch_events_v142`);
    db.exec("DROP TABLE agent_dispatch_events_v142");
    db.exec("CREATE INDEX idx_agent_dispatch_events_issue ON agent_dispatch_events(issue_id, created_at DESC)");
    db.exec("CREATE INDEX idx_agent_dispatch_events_incident ON agent_dispatch_events(incident_id, created_at DESC)");
  }
  if (tableExists(db, "space_items")) {
    const findingItems = db.prepare(
      "SELECT * FROM space_items WHERE ref_type = 'finding' ORDER BY created_at, id",
    ).all() as Array<{ id: string }>;
    if (findingItems.length > 0) {
      const findingIds = findingItems.map((row) => row.id);
      const placeholders = findingIds.map(() => "?").join(",");
      const provenance = {
        space_items: findingItems,
        occurrences: db.prepare(`SELECT * FROM space_occurrences WHERE item_id IN (${placeholders})`).all(...findingIds),
        blocks: db.prepare(`SELECT * FROM space_blocks WHERE item_id IN (${placeholders})`).all(...findingIds),
      };
      db.prepare(
        `INSERT INTO briefing_legacy_audit
          (id, legacy_collection_id, disposition, reason, provenance_json, created_at)
         VALUES (?, ?, 'sealed_ambiguous', ?, ?, ?)`,
      ).run(stableId("briefing-audit", "space-findings"), "space-findings",
        "sealed retired Space finding references as immutable audit provenance",
        JSON.stringify(provenance), now);
      db.exec("CREATE TEMP TABLE retired_space_occurrences(id TEXT PRIMARY KEY)");
      db.prepare(`INSERT INTO retired_space_occurrences
        WITH RECURSIVE retired(id) AS (
          SELECT id FROM space_occurrences WHERE item_id IN (${placeholders})
          UNION SELECT o.id FROM space_occurrences o JOIN retired r ON o.parent_id = r.id
        ) SELECT id FROM retired`).run(...findingIds);
      db.exec("DELETE FROM space_edges WHERE source IN (SELECT id FROM retired_space_occurrences) OR target IN (SELECT id FROM retired_space_occurrences)");
      db.exec("DELETE FROM space_occurrences WHERE id IN (SELECT id FROM retired_space_occurrences)");
      db.exec("DROP TABLE retired_space_occurrences");
      db.prepare(`UPDATE space_blocks SET item_id = NULL WHERE item_id IN (${placeholders})`).run(...findingIds);
    }
    db.exec("CREATE TEMP TABLE space_items_v142 AS SELECT * FROM space_items WHERE ref_type != 'finding'");
    db.exec("DROP TABLE space_items");
    db.exec(CANONICAL_SPACE_ITEMS_SQL);
    db.exec("INSERT INTO space_items SELECT * FROM space_items_v142");
    db.exec("DROP TABLE space_items_v142");
    db.exec("CREATE INDEX idx_space_items_lookup ON space_items(space_id, ref_type, ref_id)");
    db.exec("CREATE INDEX idx_space_items_by_ref ON space_items(ref_type, ref_id, space_id)");
  }
  for (const statement of LEGACY_FEEDBACK_DROP_SQL) {
    try { db.exec(statement); } catch (error) {
      throw new Error(`migration 142 could not retire legacy feedback schema at '${statement}': ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
