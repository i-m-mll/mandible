import type { Db } from '../src/db.js';
import type { AcceptedReleaseReceipt } from './accepted-release.mjs';
export function acceptedReleaseDatabaseReferences(db: Db, reference: string, receipt: AcceptedReleaseReceipt): string[];
export function acceptedReleaseProducerReferencesAsync(metadata: unknown): Promise<string[]>;
export function claimAcceptedReleaseDisposal(db: Db, reference: string, receipt: AcceptedReleaseReceipt, mark: () => void): void;
export function reconcileAcceptedReleases(db: Db, home: string, options?: { apply?: boolean; limit?: number; until?: number }): Promise<Array<{ action: string; reason?: string; reasons?: string[] }>>;
