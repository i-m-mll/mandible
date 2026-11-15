import type { OwnedRunOutcome } from './owned-run.mjs';
import type { InstalledRelease } from './installed-release.mjs';
import type { AcceptanceCertification, ACCEPTANCE_CONTRACT } from './acceptance-certificate.mjs';
export interface AcceptedReleaseCandidate { pin_sha: string; tree_sha: string; base_sha: string; head_sha: string }
interface AcceptedReleaseIdentity {
  candidate: AcceptedReleaseCandidate;
  target: string;
  package: { custody: 'owned-run'; handle: { root: string; runId: string }; path: 'Mandible.app'; sha256: string };
}
export interface LegacyAcceptedReleaseReceipt extends AcceptedReleaseIdentity {
  schema: 'mandible-accepted-release@1';
  acceptance: { run_id: string; record_id: string | null; request_id: string | null };
  retention: { project: string; work_unit: string; policy: string };
  shipped: InstalledRelease;
  evidence: { receipt: string; sha256: string };
}
export interface AcceptedReleaseCertificate extends AcceptedReleaseIdentity, AcceptanceCertification {
  schema: 'mandible-accepted-release@2';
  contract: typeof ACCEPTANCE_CONTRACT;
  acceptance: { run_id: string; record_id: string; request_id: string };
  retention: { project: string; work_unit: string };
  manifest_sha256: string;
}
export type AcceptedReleaseReceipt = LegacyAcceptedReleaseReceipt | AcceptedReleaseCertificate;
export const ACCEPTED_RELEASE_SCHEMA: LegacyAcceptedReleaseReceipt['schema'];
export class LegacyAcceptanceEvidenceMissing extends Error {}
export function applicationIdentity(app: string): string;
export function assertAcceptedReleaseAvailable(reference: string): void;
export function handoffRetainedReleases(journal: { phase?: string; helperFencedAt?: number; cleanup?: { state?: string }; attempt?: { fence?: unknown }; mutationFence?: unknown; binding?: { acceptedRelease?: { reference?: string }; bundleOwner?: { acceptedRelease?: string } } }): string[];
export function acceptedReleaseFilesystemReferences(home: string, reference: string): string[];
export function acceptedReleaseDisposition(receipt: AcceptedReleaseReceipt): OwnedRunOutcome | null;
export function readImmutableAcceptedRelease(reference: string, expectedCandidate?: AcceptedReleaseCandidate): AcceptedReleaseReceipt;
export function readAcceptedReleaseReceipt(reference: string, expectedCandidate?: AcceptedReleaseCandidate): AcceptedReleaseReceipt;
export function readAcceptedInstalledRelease(receipt: AcceptedReleaseReceipt, resources: string): InstalledRelease;
export function resolveAcceptedRelease(reference: string, expectedCandidate?: AcceptedReleaseCandidate): { receipt: AcceptedReleaseReceipt; app: string; resources: string; release: InstalledRelease };
export function disposeAcceptedRelease(reference: string, expectedCandidate: AcceptedReleaseCandidate, reason: string, options?: { home?: string; database?: string; assertHeld?: () => void; claim?: (mark: () => void) => void; deferCleanup?: boolean; inspect?: (root: string) => { idle: boolean; reason?: string } | Promise<{ idle: boolean; reason?: string }> }): Promise<{ action: string; reason: string; remaining?: string[] }>;
export interface PendingRelease {
  root: string; runId: string; app: string; resources: string;
  ownership: { root: string; runId: string; instanceId: string; project: string; workUnit: string; [key: string]: unknown };
}
export function createPendingRelease(input: { storage: string; ownership: { runId: string; instanceId: string; project: string; workUnit: string } }): Promise<PendingRelease>;
type SealAcceptedRelease = { pending: PendingRelease; candidate: AcceptedReleaseCandidate; expectedDigest: string; shipped: InstalledRelease };
type SealedAcceptedRelease<T> = Promise<{ reference: string; receipt: T; root: string; app: string; resources: string; digest: string }>;
export function retainAcceptedRelease(input: SealAcceptedRelease & { acceptance: Omit<LegacyAcceptedReleaseReceipt['acceptance'], 'run_id'>; evidence: Uint8Array }): SealedAcceptedRelease<LegacyAcceptedReleaseReceipt>;
export function retainAcceptedRelease(input: SealAcceptedRelease & { acceptance: Omit<AcceptedReleaseCertificate['acceptance'], 'run_id'>; certification: AcceptanceCertification }): SealedAcceptedRelease<AcceptedReleaseCertificate>;
export function disposePendingRelease(pending: PendingRelease, expectedDigest: string | undefined, reason: string): Promise<{ action: string; reason: string; remaining?: string[] }>;
