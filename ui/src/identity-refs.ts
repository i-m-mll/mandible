import { displayResourceRef } from './resource-refs';

const FULL_UUID_SEGMENT_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const LONG_HEX_SEGMENT_RE = /[0-9a-f]{12,64}/gi;

/**
 * Default user-facing form for an exact identity authority.
 *
 * Typed resource refs retain their semantic prefix. Other UUID and digest
 * segments are compacted without changing surrounding project/type context.
 * Callers still keep the exact input for API mutations and persisted state.
 */
export function shortIdentityRef(ref: string): string {
  const trimmed = ref.trim();
  if (!trimmed) return trimmed;

  const resourceDisplay = displayResourceRef(trimmed);
  if (resourceDisplay !== trimmed) return resourceDisplay;

  return trimmed
    .replace(FULL_UUID_SEGMENT_RE, (segment) => segment.slice(0, 8).toLowerCase())
    .replace(LONG_HEX_SEGMENT_RE, (segment) => segment.slice(0, 7).toLowerCase());
}
