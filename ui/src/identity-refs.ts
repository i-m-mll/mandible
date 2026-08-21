import { displayResourceRef } from './resource-refs';

const FULL_UUID_SEGMENT_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const LONG_HEX_SEGMENT_RE = /[0-9a-f]{12,64}/gi;
const TYPED_ARTIFACT_HEX_REF_RE = /^(artifact(?:-series|-version|-blob)?):([0-9a-f]+)((?:[@#].*)?)$/i;

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

  const typedArtifact = TYPED_ARTIFACT_HEX_REF_RE.exec(trimmed);
  if (typedArtifact) {
    const [, scheme, id, suffix] = typedArtifact;
    // Canonical artifact authorities are 32+ hex characters. Shorter values
    // are already server-projected ambiguity-safe refs and must not be sliced
    // again, because their extra prefix characters may disambiguate a clash.
    return id.length >= 32
      ? `${scheme.toLowerCase()}:${id.slice(0, 7).toLowerCase()}${suffix}`
      : trimmed;
  }

  const resourceDisplay = displayResourceRef(trimmed);
  if (resourceDisplay !== trimmed) return resourceDisplay;

  return trimmed
    .replace(FULL_UUID_SEGMENT_RE, (segment) => segment.slice(0, 8).toLowerCase())
    .replace(LONG_HEX_SEGMENT_RE, (segment) => segment.slice(0, 7).toLowerCase());
}
