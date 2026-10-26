import { createHash } from 'node:crypto';
import { canonicalJson } from '../../src/canonical-json.js';
import { RICH_BRIEFING_DEMO as demo } from '../../src/feedback/rich-briefing-demo.js';

const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const directiveKeys = ['scope.approval', 'rollback.plan', 'observability', 'operator.runbook'];
const directiveRanges = [
  [[734, 842, 785, 838], [844, 955, 894, 951], [957, 1075, 1008, 1071], [1077, 1167, 1114, 1163]],
  [[829, 951, 880, 947], [953, 1064, 1003, 1060], [1066, 1180, 1117, 1176], [1182, 1282, 1219, 1278]],
];

type ArtifactVersion = { id: string; artifact_id: string | null; blob_id: string | null; content_hash: string };

/** Sealed v1 data consumed by the current demo importer; it never installs a historical schema. */
export function sealedRetiredDemoPacket({ briefingId, publisherId, reviewerId, versions, sources }: {
  briefingId: string; publisherId: string; reviewerId: string; versions: ArtifactVersion[]; sources: string[];
}) {
  const timestamps = [demo.roundOneTimestamp, demo.roundTwoTimestamp];
  const rounds = versions.map((version, index) => ({
    id: `${briefingId}:round:${index + 1}`, briefing_id: briefingId, ordinal: index + 1,
    artifact_version_id: version.id, previous_round_id: index === 0 ? null : `${briefingId}:round:1`,
    profile: 'mandible-briefing.v1', created_at: timestamps[index],
  }));
  const definitions = rounds.flatMap((round, roundIndex) => directiveKeys.map((key, position) => {
    const [start, end, bodyStart, bodyEnd] = directiveRanges[roundIndex][position];
    return {
      id: `${round.id}:definition:${key}`, artifact_version_id: round.artifact_version_id,
      directive_key: key, definition_digest: digest(sources[roundIndex].slice(start, end)),
      response_type: 'verdict', required: position < 2 ? 1 : 0,
      prompt: sources[roundIndex].slice(bodyStart, bodyEnd), options_json: '[]',
      start_offset: start, end_offset: end, body_start_offset: bodyStart, body_end_offset: bodyEnd,
      created_at: round.created_at,
    };
  }));
  const instances = rounds.flatMap(round => directiveKeys.map((key, position) => ({
    id: `${round.id}:instance:${key}`, round_id: round.id, definition_id: `${round.id}:definition:${key}`,
    directive_key: key, position, created_at: round.created_at,
  })));
  const runs = rounds.map((round, index) => ({
    id: `${round.id}:run`, briefing_id: briefingId, round_id: round.id, artifact_version_id: round.artifact_version_id,
    publisher_user_id: publisherId, task_identity: demo.taskIdentity,
    run_id: `release-readiness-round-${index + 1}`, run_key: `release-readiness-round-${index + 1}`,
    request_digest: 'a'.repeat(64), evidence_series_ref: demo.evidenceSeriesRef,
    evidence_version: index + 1, evidence_digest: digest(`mandible-rich-briefing-demo:round-${index + 1}-evidence`),
    source_health_json: '{}', quiet: 0, quiet_reason: null, received_at: round.created_at,
  }));
  const responses = [
    { key: 'scope.approval', verdict: 'keep' },
    { key: 'rollback.plan', verdict: 'dismiss' },
    { key: 'operator.runbook', verdict: 'keep' },
  ].map(({ key, verdict }) => ({
    id: `${rounds[0].id}:response:${key}`, round_id: rounds[0].id,
    directive_instance_id: `${rounds[0].id}:instance:${key}`, operation: 'set', value_json: JSON.stringify({ verdict }),
    retracts_event_id: null, actor_user_id: reviewerId, created_at: demo.answersTimestamp,
  }));
  const annotations = [
    { annotation_kind: 'comment', quote: 'Staging rehearsal completed',
      body: 'Confirm the rehearsal log is attached to the final release record.', replacement_text: null },
    { annotation_kind: 'suggest_replacement', quote: '15 minute recovery objective',
      body: 'Use the tighter objective demonstrated by the final rehearsal.', replacement_text: '10 minute recovery objective' },
  ].map(event => {
    const start = sources[0].indexOf(event.quote);
    return { ...event, id: `${rounds[0].id}:${event.annotation_kind}`, round_id: rounds[0].id, operation: 'set',
      start_offset: start, end_offset: start + event.quote.length, retracts_event_id: null,
      actor_user_id: reviewerId, created_at: demo.annotationsTimestamp };
  });
  const submission = { id: `${rounds[0].id}:submission`, round_id: rounds[0].id, ordinal: 1,
    supersedes_submission_id: null, actor_user_id: reviewerId, created_at: demo.submissionTimestamp };
  const components = {
    briefing: { id: briefingId, briefing_key: demo.briefingKey, title: demo.title,
      latest_round_id: rounds[1].id, round_count: 2, created_at: demo.roundOneTimestamp, updated_at: demo.roundTwoTimestamp },
    membership: [{ briefing_id: briefingId, user_id: reviewerId, created_at: demo.roundOneTimestamp }],
    artifact_versions: versions.map((version, index) => ({
      id: version.id, artifact_id: version.artifact_id, blob_id: version.blob_id,
      content_hash: version.content_hash, byte_length: Buffer.byteLength(sources[index]), source_sha256: digest(sources[index]),
    })),
    rounds: rounds.map(round => ({ ...round, binding_digest: digest(JSON.stringify(definitions
      .filter(definition => definition.artifact_version_id === round.artifact_version_id)
      .map(definition => [definition.directive_key, definition.definition_digest]))) })),
    definitions, instances, runs,
    occurrences: runs.flatMap((run, index) => directiveKeys.map(key => ({
      id: `${run.id}:occurrence:${key}`, run_id: run.id, directive_instance_id: `${run.round_id}:instance:${key}`,
      directive_key: key, evidence_digest: 'e'.repeat(64), occurred_at: run.received_at - 30_000,
      metadata_json: JSON.stringify({ fixture: 'rich-briefing-demo', round: index + 1 }),
    }))),
    response_events: responses, annotation_events: annotations, submissions: [submission],
    submission_answers: responses.map((event, position) => ({ submission_id: submission.id,
      directive_instance_id: event.directive_instance_id, response_event_id: event.id, position })),
    submission_annotations: annotations.map((event, position) => ({ submission_id: submission.id, annotation_event_id: event.id, position })),
    prior_audit: [],
  };
  const packet = {
    schema: 'mandible-briefing-v1-custody.v1', source_profile: 'mandible-briefing.v1', components,
    row_counts: Object.fromEntries(Object.entries(components).map(([key, value]) => [key, Array.isArray(value) ? value.length : 1])),
    component_digests: Object.fromEntries(Object.entries(components).map(([key, value]) => [key, digest(canonicalJson(value))])),
    verification_errors: [],
  };
  const json = canonicalJson(packet);
  return { json, digest: digest(json) };
}
