import type { InstalledRelease } from './installed-release.mjs';
export interface AcceptedReleaseCandidate { pin_sha: string; tree_sha: string; base_sha: string; head_sha: string }
export interface AcceptedReleaseReceipt {
  schema: 'mandible-accepted-release@1';
  acceptance: { run_id: string; record_id: string | null; request_id: string | null };
  candidate: AcceptedReleaseCandidate;
  target: string;
  shipped: InstalledRelease;
  package: { custody: 'owned-run'; handle: { root: string; runId: string }; path: 'Mandible.app'; sha256: string };
  retention: { project: string; work_unit: string; policy: string };
  evidence: { receipt: string; sha256: string };
}
export const ACCEPTED_RELEASE_SCHEMA: string;
export function applicationIdentity(app: string): string;
export function resolveAcceptedRelease(reference: string, expectedCandidate?: AcceptedReleaseCandidate): { receipt: AcceptedReleaseReceipt; app: string; resources: string };
export function disposeAcceptedRelease(reference: string, expectedCandidate: AcceptedReleaseCandidate, reason: string): Promise<{ action: string; reason: string; remaining?: string[] }>;
export function retainAcceptedRelease(input: { app: string; storage: string; ownership: { runId: string; instanceId: string; project: string; workUnit: string }; candidate: AcceptedReleaseCandidate; acceptance: { record_id: string | null; request_id: string | null }; evidence: AcceptedReleaseReceipt['evidence']; expectedDigest: string }): Promise<string>;
