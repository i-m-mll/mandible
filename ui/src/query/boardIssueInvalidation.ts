import type { ResolverResult } from '../../../src/contracts';
import { parseIssueRefTarget } from '../../../src/ledger/authored-references';

export function boardIssueAffectedByEvent(key: readonly unknown[], resolution: ResolverResult | undefined, type: string, data?: unknown): boolean {
  const payload = data && typeof data === 'object' ? data as Record<string, unknown> : {};
  if (type === 'ledger:work_unit:linked' || (type === 'ledger:event:created' && payload.entity_type === 'work_unit')) return true;
  const genericIssue = type === 'ledger:event:created' && payload.entity_type === 'issue'
    && typeof payload.event_type === 'string' && /^(issue\.(created|updated|closed|reopened|worker_status\.updated)|label\.updated)$/.test(payload.event_type);
  if (!genericIssue && !/^ledger:issue:(created|updated|closed|reopened)$/.test(type) && type !== 'ledger:label:updated') return false;
  const id = genericIssue ? payload.entity_id : payload.issue_id;
  const canonical = resolution?.resolved ? resolution.entity?.id : undefined;
  const ref = typeof key[1] === 'string' ? key[1] : '';
  const requested = parseIssueRefTarget(ref.replace(/^issue:/i, ''))?.issue;
  if (typeof id !== 'string') return true;
  if (typeof canonical === 'string' && canonical === id) return true;
  if (requested && (id === requested || id.startsWith(requested) || requested.startsWith(id))) return true;
  // New or changed issues can make a formerly unique short ref ambiguous.
  const identityChanged = /^ledger:issue:(created|updated|closed|reopened)$/.test(type)
    || (genericIssue && /^issue\.(created|updated|closed|reopened)$/.test(String(payload.event_type)));
  return identityChanged && !/^issue:[a-f0-9]{64}$/i.test(ref);
}
