/** Origin is claimed provenance, independent of the row's author and authority. */
export const LEDGER_ORIGIN_SCHEMA_SQL = [
  "briefing_annotation_events",
  "briefing_bundles",
  "briefing_collection_sharing_receipts",
  "briefing_composition_contributions",
  "briefing_composition_report_publications",
  "briefing_composition_runs",
  "briefing_composition_targets",
  "briefing_creation_overrides",
  "briefing_destination_mutations",
  "briefing_group_dispositions",
  "briefing_group_review_dispositions",
  "briefing_group_updates",
  "briefing_groups",
  "briefing_response_events",
  "briefing_rounds",
  "briefing_runs",
  "briefing_submissions",
  "briefings",
  "work_unit_custody_events",
  "auth_request_lifecycle_events",
  "artifact_source_move",
  "auth_request_actions"
].map(table =>
  `ALTER TABLE ${table} ADD COLUMN request_origin_json TEXT
    CHECK(request_origin_json IS NULL OR (json_valid(request_origin_json) AND json_type(request_origin_json) = 'object'))`);

export const MANAGED_SESSION_ORIGIN_INDEX_SQL = "CREATE INDEX idx_console_sessions_mandible_session ON console_sessions(mandible_session_id)";
