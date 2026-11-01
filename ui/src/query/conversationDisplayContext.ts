import { DISPLAY_CONTEXT_VERSION, type ConversationDisplayContext } from '../../../src/conversations/display-context';
import type { ConversationBlock, ConversationPositionWindow } from '../api';
import { toolValueText } from '../../../src/presentation/model';

export const emptyDisplayContext = (): ConversationDisplayContext => ({ version: DISPLAY_CONTEXT_VERSION, fragments: [], activity_runs: [], aliases: [], owners: [] });

/** Presentation and disclosed owner details share Query custody and the retained source membership lifetime. */
export function mergeDisplayContext(current: ConversationDisplayContext, incoming: ConversationPositionWindow,
  retained: readonly ConversationBlock[], sameSourceVersion: boolean): ConversationDisplayContext {
  const next = incoming.display_context ?? emptyDisplayContext();
  const positions = new Set(retained.map(block => block.position));
  const aliases = [...new Map([...current.aliases, ...next.aliases].map(alias => [alias.position, alias])).values()]
    .filter(alias => positions.has(alias.position));
  const ownerIds = new Set(aliases.map(alias => alias.fragment_id));
  const fragments = [...new Map([...current.fragments, ...next.fragments].map(fragment => [fragment.id, fragment])).values()]
    .filter(fragment => positions.has(fragment.coordinate.position) || ownerIds.has(fragment.id));
  const fragmentIds = new Set(fragments.map(fragment => fragment.id));
  const runIds = new Set(fragments.map(fragment => fragment.activity_run_id));
  const activity_runs = [...new Map([...current.activity_runs, ...next.activity_runs].map(run => [run.id, run])).values()]
    .filter(run => runIds.has(run.id));
  const owners = new Map(current.owners.map(owner => [owner.fragment_id,
    sameSourceVersion ? owner : { ...owner, details: undefined }]));
  for (const owner of next.owners) owners.set(owner.fragment_id, { ...owner,
    details: sameSourceVersion ? owners.get(owner.fragment_id)?.details : undefined });
  let detailBytes = 0;
  const retainedOwners = [...owners.values()].filter(owner => fragmentIds.has(owner.fragment_id)).map(owner => {
    const full = incoming.blocks.find(block => block.position === owner.coordinate.position && block.details_loaded !== false);
    if (full) {
      const item = JSON.parse(full.metadata_json).chat_item;
      if (item?.type === 'tool-call' && item.phase === 'call') {
        owner = { ...owner, details: { ...owner.item, header: owner.header,
          input: toolValueText(item.input, ''), result: null } };
      }
    }
    if (owner.details) detailBytes += JSON.stringify(owner.details).length * 2;
    return owner;
  });
  if (detailBytes > 64 * 1024 * 1024) throw new Error('Disclosed source owner details exceed the reading cache limit.');
  return { version: DISPLAY_CONTEXT_VERSION, fragments, aliases, activity_runs, owners: retainedOwners };
}
