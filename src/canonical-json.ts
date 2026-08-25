/**
 * Deterministic JSON serialization for digest and signature inputs.
 *
 * Object keys are emitted in sorted order at every depth, so two structurally
 * equal values always produce the same bytes regardless of insertion order.
 * Everything else follows `JSON.stringify`.
 *
 * This is a digest-input format. Four independent copies of it existed before
 * this module (auth clearance, Briefing publication, legacy Briefing
 * migration, and ledger id derivation); any divergence between them would have
 * silently produced different digests for the same value.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}
