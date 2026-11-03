import { afterEach, expect, it, vi } from 'vitest';
import { activityTargetKey, type ActivityTarget } from '../src/presentation/activity-targets';
import { activityTargetOptions } from '../ui/src/query/activityTargets';
import { queryClient } from '../ui/src/query/client';

const transport = vi.hoisted(() => ({ batches: [] as ActivityTarget[][] }));
vi.mock('../ui/src/api', () => ({ resolveActivityTargets: async (targets: ActivityTarget[]) => {
  transport.batches.push(targets);
  return targets.map(target => ({key:activityTargetKey(target),status:'resolved',conversationId:`canonical:${activityTargetKey(target)}`,title:'Indexed title'}));
} }));
afterEach(() => { queryClient.clear(); transport.batches = []; });

it('shares native target cache identities across authored labels and bounds metadata batches', async () => {
  const targets = Array.from({length:65}, (_,index):ActivityTarget => ({kind:'subagent',provider:'claude_code',parentSessionId:'parent',agentId:`agent-${index}`,labelHint:'Authored task'}));
  const results = await Promise.all(targets.map(target => queryClient.fetchQuery(activityTargetOptions(target))));
  expect(transport.batches.map(batch => batch.length)).toEqual([64,1]);
  expect(transport.batches.flat().every(target => !('labelHint' in target))).toBe(true);
  expect(results.map(result => result.key)).toEqual(targets.map(activityTargetKey));
  const same = await queryClient.fetchQuery(activityTargetOptions({...targets[0],labelHint:'Reworded task'}));
  expect(same).toBe(results[0]);
  expect(transport.batches).toHaveLength(2);
  const otherParent = await queryClient.fetchQuery(activityTargetOptions({...targets[0],parentSessionId:'different-parent'} as ActivityTarget));
  expect(otherParent.key).not.toBe(results[0].key);
  expect(transport.batches).toHaveLength(3);
});
