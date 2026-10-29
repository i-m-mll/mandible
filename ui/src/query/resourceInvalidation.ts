import { boardIssueAffectedByEvent } from './boardIssueInvalidation';
import type { ResolverResult } from '../../../src/contracts';
import type { Query } from '@tanstack/preact-query';
import { detailKeysForEvent } from './detailKeys';

export function spacePacketMatches(query: Query, spaceId: string): boolean {
  const ref = query.queryKey[2];
  const resolved = (query.state.data as { space?: { id?: unknown } } | undefined)?.space?.id;
  if (typeof resolved === 'string') return resolved === spaceId;
  return typeof ref === 'string' && spaceId.startsWith(ref);
}

export function projectionAffectedByEvent(query: Query, type: string, data?: unknown): boolean {
  if (query.queryKey[0] === 'board-issue') return boardIssueAffectedByEvent(query.queryKey, query.state.data as ResolverResult | undefined, type, data);
  if (query.queryKey[0] === 'issue-detail') return detailKeysForEvent(type).some((key) => key[0] === 'issue-detail');
  if (query.queryKey[0] !== 'space' || query.queryKey[1] !== 'packet') return true;
  if (!/^(space:|ledger:|artifact:|briefing:)/.test(type)) return false;
  const id = type.startsWith('space:') && data && typeof data === 'object' ? (data as { space_id?: unknown }).space_id : null;
  return typeof id === 'string' ? spacePacketMatches(query, id) : true;
}

export const isSpaceDocumentQuery = (query: Query) => query.queryKey[0] === 'space'
  && query.queryKey[2] === 'document';
