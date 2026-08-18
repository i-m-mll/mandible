import { getSetting } from "./client-auth/settings-kv.js";
import type { Db } from "./db.js";

export const BRIEFING_PUBLISHERS_KEY = "briefing.ingest.publishers";

export interface BriefingPublisherBinding {
  task_identity: string;
  sources: readonly string[];
}

export const DEFAULT_BRIEFING_PUBLISHERS: Readonly<Record<string, readonly Readonly<BriefingPublisherBinding>[]>> = Object.freeze({
  "agent-schedule": Object.freeze([
    Object.freeze({ task_identity: "agent-schedule/daily-digest", sources: Object.freeze(["arxiv-scan"]) }),
    Object.freeze({ task_identity: "agent-schedule/task-health", sources: Object.freeze(["task-health"]) }),
  ]),
});

/** Independent code-owned gate; publisher configuration cannot widen task identity. */
export const BRIEFING_PUBLISHER_TASK_GATE: readonly string[] = Object.freeze([
  "agent-schedule/daily-digest",
  "agent-schedule/task-health",
]);

export function readBriefingPublisherBindings(db: Db): Record<string, BriefingPublisherBinding[]> {
  const raw = getSetting(db, BRIEFING_PUBLISHERS_KEY);
  if (raw === null) {
    return Object.fromEntries(Object.entries(DEFAULT_BRIEFING_PUBLISHERS)
      .map(([slug, bindings]) => [slug, bindings.map((binding) => ({
        task_identity: binding.task_identity,
        sources: [...binding.sources],
      }))]));
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const result: Record<string, BriefingPublisherBinding[]> = {};
    for (const [slug, rawBindings] of Object.entries(parsed as Record<string, unknown>)) {
      if (!slug.trim() || !Array.isArray(rawBindings)) return {};
      const bindings: BriefingPublisherBinding[] = [];
      for (const rawBinding of rawBindings) {
        if (!rawBinding || typeof rawBinding !== "object" || Array.isArray(rawBinding)) return {};
        const binding = rawBinding as Record<string, unknown>;
        if (Object.keys(binding).sort().join(",") !== "sources,task_identity"
            || typeof binding.task_identity !== "string" || !binding.task_identity.trim()
            || !Array.isArray(binding.sources) || binding.sources.length === 0
            || binding.sources.some((source) => typeof source !== "string" || !source.trim())) return {};
        bindings.push({ task_identity: binding.task_identity.trim(),
          sources: [...new Set(binding.sources as string[])].map((source) => source.trim()) });
      }
      result[slug] = bindings;
    }
    return result;
  } catch {
    return {};
  }
}

export function publisherMayIngest(db: Db, slug: string, taskIdentity: string, sources: readonly string[]): boolean {
  if (!BRIEFING_PUBLISHER_TASK_GATE.includes(taskIdentity)) return false;
  const binding = readBriefingPublisherBindings(db)[slug]
    ?.find((candidate) => candidate.task_identity === taskIdentity);
  return Boolean(binding && sources.every((source) => binding.sources.includes(source)));
}
