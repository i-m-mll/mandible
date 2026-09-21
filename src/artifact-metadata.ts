/** Retained JSON describes an artifact; typed version fields alone own custody. */
const RETIRED_AUTHORITY_KEYS = new Set([
  'custody', 'custody_mode', 'availability', 'recoverability', 'retention', 'reference',
  'home_repo_id', 'repo_id', 'repo_locator', 'repo_locator_json', 'source_locator',
  'source_locator_json', 'legacy_source_locator', 'storage_backend', 'storage_uri',
  'content_identity', 'artifact_id', 'compatibility_artifact_id', 'registered_source_migration',
  'artifact_recovery', 'git',
]);

export function artifactDescriptiveMetadata(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const clean = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(clean);
    if (!input || typeof input !== 'object') return input;
    const entries = Object.entries(input).flatMap(([key, child]) => {
      if (RETIRED_AUTHORITY_KEYS.has(key)) return [];
      const next = clean(child);
      // Do not leave a newly empty wrapper where an obsolete envelope lived.
      if (child && typeof child === 'object' && !Array.isArray(child)
        && Object.keys(child).length > 0 && Object.keys(next as object).length === 0) return [];
      return [[key, next]];
    });
    return Object.fromEntries(entries);
  };
  return clean(value) as Record<string, unknown>;
}

export function artifactDescriptiveMetadataJson(value: unknown): string {
  let parsed: unknown;
  try { parsed = JSON.parse(String(value)); } catch { parsed = {}; }
  return JSON.stringify(artifactDescriptiveMetadata(parsed));
}
