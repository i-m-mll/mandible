import { createHash } from 'node:crypto';
import type SqliteDatabase from '../sqlite.js';
import { displayFragmentId, displaySummaryMembers, type IndexedDisplayFragment, type DisplayFragmentDescriptor, type DisplayPositionFacts } from './display-context.js';

export type DisplayIndexInput = {
  positions: DisplayPositionFacts[];
  fragments: IndexedDisplayFragment[];
  aliases: Array<{ position: number; owner_position: number; failed: boolean }>;
};
type FragmentRow = { position: number; part: string; kind: 'content' | 'activity'; speaker: IndexedDisplayFragment['speaker']; run_id: string | null; facts_json: string };
function decode(row: FragmentRow): IndexedDisplayFragment {
  return { ...JSON.parse(row.facts_json), id: displayFragmentId({ position: row.position, part: row.part }),
    coordinate: { position: row.position, part: row.part }, kind: row.kind, speaker: row.speaker, activity_run_id: row.run_id };
}

export function writeDisplayIndex(db: SqliteDatabase, cacheId: number, input: DisplayIndexInput, priorCacheId?: number): void {
  if (priorCacheId !== undefined) {
    db.prepare('INSERT INTO cache_display_positions SELECT ?, position, facts_json FROM cache_display_positions WHERE cache_conversation_id = ?').run(cacheId, priorCacheId);
    db.prepare('INSERT INTO cache_display_fragments SELECT ?, position, part, ordinal, kind, speaker, run_id, facts_json FROM cache_display_fragments WHERE cache_conversation_id = ?').run(cacheId, priorCacheId);
    db.prepare('INSERT INTO cache_display_aliases SELECT ?, position, owner_position, owner_part FROM cache_display_aliases WHERE cache_conversation_id = ?').run(cacheId, priorCacheId);
  }
  const positionInsert = db.prepare('INSERT OR REPLACE INTO cache_display_positions VALUES (?, ?, ?)');
  for (const position of input.positions) positionInsert.run(cacheId, position.position, JSON.stringify(position));
  let previous = db.prepare('SELECT * FROM cache_display_fragments WHERE cache_conversation_id = ? ORDER BY position DESC, ordinal DESC LIMIT 1').get(cacheId) as FragmentRow | undefined;
  const toolOwners = new Set(input.fragments.filter(fragment => fragment.activity?.type === 'tool-call-activity').map(fragment => fragment.coordinate.position));
  const verifiedAliases = input.aliases.filter(alias => toolOwners.has(alias.owner_position)
    || (db.prepare("SELECT facts_json FROM cache_display_fragments WHERE cache_conversation_id = ? AND position = ? AND kind = 'activity'")
      .all(cacheId, alias.owner_position) as Array<{facts_json:string}>).some(row => JSON.parse(row.facts_json).activity?.type === 'tool-call-activity'));
  const pairedPositions = new Set(verifiedAliases.map(alias => alias.position));
  const insert = db.prepare('INSERT INTO cache_display_fragments VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
  for (const [ordinal, fragment] of input.fragments.entries()) {
    if (pairedPositions.has(fragment.coordinate.position)) continue;
    const run = fragment.kind === 'activity' ? previous?.kind === 'activity' && previous.speaker === fragment.speaker
      ? previous.run_id : fragment.id : null;
    const { activity, summary_from_source, has_details, disclosures, summary_eligible } = fragment;
    insert.run(cacheId, fragment.coordinate.position, fragment.coordinate.part, ordinal, fragment.kind, fragment.speaker, run,
      JSON.stringify({ activity, summary_from_source, has_details, disclosures, summary_eligible, paired_source_positions: [] }));
    previous = { position: fragment.coordinate.position, part: fragment.coordinate.part, kind: fragment.kind,
      speaker: fragment.speaker, run_id: run, facts_json: '' };
  }
  for (const alias of verifiedAliases) {
    const owner = db.prepare("SELECT * FROM cache_display_fragments WHERE cache_conversation_id = ? AND position = ? AND kind = 'activity' ORDER BY ordinal LIMIT 1")
      .get(cacheId, alias.owner_position) as FragmentRow | undefined;
    if (!owner) continue;
    const fact = decode(owner);
    if (fact.activity?.type !== 'tool-call-activity') continue;
    db.prepare('INSERT OR REPLACE INTO cache_display_aliases VALUES (?, ?, ?, ?)').run(cacheId, alias.position, alias.owner_position, owner.part);
    if (alias.failed) {
      fact.activity.result = { type: 'tool_result', tool_use_id: fact.activity.id, content: '', is_error: true };
      db.prepare('UPDATE cache_display_fragments SET facts_json = ? WHERE cache_conversation_id = ? AND position = ? AND part = ?')
        .run(JSON.stringify({ activity: fact.activity, summary_from_source: fact.summary_from_source, has_details: fact.has_details, disclosures: fact.disclosures, summary_eligible: fact.summary_eligible, paired_source_positions: [] }), cacheId, alias.owner_position, owner.part);
    }
  }
}

export type DisplayContextPlan = {
  fragments: DisplayFragmentDescriptor[];
  aliases: Array<{ position: number; fragment_id: string }>;
  runs: Map<string, IndexedDisplayFragment[]>;
  ownerFragments: IndexedDisplayFragment[];
  sourcePositions: number[];
};

/** Only positions in the requested window and the runs/owners they reference cross the API boundary. */
export function readDisplayContextPlan(db: SqliteDatabase, cacheId: number, positions: readonly number[]): DisplayContextPlan {
  const params = JSON.stringify(positions);
  const rows = db.prepare(`SELECT * FROM cache_display_fragments WHERE cache_conversation_id = ?
    AND position IN (SELECT value FROM json_each(?)) ORDER BY position,ordinal`).all(cacheId, params) as FragmentRow[];
  const aliasRows = db.prepare(`SELECT position,owner_position,owner_part FROM cache_display_aliases WHERE cache_conversation_id = ?
    AND position IN (SELECT value FROM json_each(?))`).all(cacheId, params) as Array<{position:number;owner_position:number;owner_part:string}>;
  for (const alias of aliasRows) {
    if (rows.some(row => row.position === alias.owner_position && row.part === alias.owner_part)) continue;
    const owner = db.prepare('SELECT * FROM cache_display_fragments WHERE cache_conversation_id = ? AND position = ? AND part = ?')
      .get(cacheId, alias.owner_position, alias.owner_part) as FragmentRow | undefined;
    if (owner) rows.push(owner);
  }
  const decoded = rows.map(decode);
  const runs = new Map<string, IndexedDisplayFragment[]>();
  const sourcePositions = new Set<number>();
  for (const runId of new Set(decoded.flatMap(fragment => fragment.activity_run_id ? [fragment.activity_run_id] : []))) {
    const members = (db.prepare('SELECT * FROM cache_display_fragments WHERE cache_conversation_id = ? AND run_id = ? ORDER BY position,ordinal')
      .all(cacheId, runId) as FragmentRow[]).map(decode);
    runs.set(runId, members);
    const contributors = displaySummaryMembers(members);
    const unified = contributors.some(member => member.activity && (member.activity.type !== 'activity'
      || ['thinking', 'reasoning-summary'].includes(member.activity.activity_kind)));
    for (const [index, member] of contributors.entries()) {
      if (member.summary_from_source && (contributors.length === 1 || (!unified && index === 0)
          || (unified && member.activity?.type === 'activity' && !['thinking', 'reasoning-summary'].includes(member.activity.activity_kind)))) {
        sourcePositions.add(member.coordinate.position);
      }
    }
  }
  const ownerFragments = decoded.filter(fragment => fragment.activity?.type === 'tool-call-activity');
  for (const owner of ownerFragments) sourcePositions.add(owner.coordinate.position);
  const fragments = decoded.map(fragment => {
    const paired = db.prepare('SELECT position FROM cache_display_aliases WHERE cache_conversation_id = ? AND owner_position = ? AND owner_part = ? ORDER BY position')
      .all(cacheId, fragment.coordinate.position, fragment.coordinate.part) as Array<{position:number}>;
    return { id:fragment.id,coordinate:fragment.coordinate,kind:fragment.kind,activity_run_id:fragment.activity_run_id,paired_source_positions:paired.map(row=>row.position) };
  });
  return { fragments, aliases: aliasRows.map(alias => ({ position: alias.position, fragment_id: displayFragmentId({ position: alias.owner_position, part: alias.owner_part }) })),
    runs, ownerFragments, sourcePositions: [...sourcePositions].sort((a,b)=>a-b) };
}

export function readCompleteDisplayIndex(db: SqliteDatabase, cacheId: number): {
  fragments: IndexedDisplayFragment[]; positions: DisplayPositionFacts[]; aliases: DisplayContextPlan['aliases'];
  revisions: { members: Record<string, string>; runs: Record<string, string> };
} {
  const fragments = (db.prepare('SELECT * FROM cache_display_fragments WHERE cache_conversation_id = ? ORDER BY position,ordinal')
    .all(cacheId) as FragmentRow[]).map(decode);
  const aliases = (db.prepare('SELECT position,owner_position,owner_part FROM cache_display_aliases WHERE cache_conversation_id = ? ORDER BY position')
    .all(cacheId) as Array<{position: number; owner_position: number; owner_part: string}>).map(alias => ({
      position: alias.position, fragment_id: displayFragmentId({position: alias.owner_position, part: alias.owner_part}),
    }));
  const byId = new Map(fragments.map(fragment => [fragment.id, fragment]));
  for (const alias of aliases) byId.get(alias.fragment_id)?.paired_source_positions.push(alias.position);
  const positions = (db.prepare('SELECT facts_json FROM cache_display_positions WHERE cache_conversation_id = ? ORDER BY position')
    .all(cacheId) as Array<{facts_json: string}>).map(row => JSON.parse(row.facts_json) as DisplayPositionFacts);
  const byPosition = new Map(positions.map(position => [position.position, position]));
  const hash = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');
  const memberRevisions = Object.fromEntries(fragments.map(fragment => [fragment.id, hash([
    fragment.coordinate, fragment.kind, fragment.speaker, fragment.activity?.type === 'tool-call-activity' ? fragment.activity.execution : undefined,
    [fragment.coordinate.position, ...fragment.paired_source_positions].flatMap(position => [position,...(byPosition.get(position)?.presentationDependencies ?? [])]).map(position => [position, byPosition.get(position)?.revision]),
  ])]));
  const runs = new Map<string, string[]>();
  for (const fragment of fragments) if (fragment.activity_run_id) {
    let members = runs.get(fragment.activity_run_id);
    if (!members) runs.set(fragment.activity_run_id, members = []);
    members.push(memberRevisions[fragment.id]);
  }
  return { fragments, positions, aliases, revisions: { members: memberRevisions,
    runs: Object.fromEntries([...runs].map(([id, members]) => [id, hash(members)])) } };
}
