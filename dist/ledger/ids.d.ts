export declare const LEDGER_ID_PREFIXES: readonly ["prj", "chk", "iss", "com", "evt", "out", "rel", "cnf", "xref", "job", "rec", "mis", "opb", "opm"];
export type LedgerIdPrefix = (typeof LEDGER_ID_PREFIXES)[number];
export interface LedgerIdOptions {
    now?: number;
    random?: Buffer;
}
export interface StableIssueIdInput {
    project_id: string;
    title: string;
    body?: string;
    source?: string;
    created_at: number;
    author_actor_id?: string | null;
    author_actor_type?: string;
    author_display?: string;
    nonce: string;
}
export interface StableCommentIdInput {
    issue_id: string;
    ordinal: number;
    body: string;
    source?: string;
    created_at: number;
    author_actor_id?: string | null;
    author_actor_type?: string;
    author_display?: string;
    nonce: string;
}
/**
 * Generate a Mandible ledger ID. This is UUIDv7-like rather than a full RFC
 * UUIDv7 implementation: lexicographic order follows millisecond time, then a
 * cryptographic-random suffix prevents path/title/git-bug-derived IDs.
 */
export declare function createLedgerId(prefix: LedgerIdPrefix, options?: LedgerIdOptions): string;
export declare function isLedgerIdWithPrefix(value: string, prefix: LedgerIdPrefix): boolean;
export declare function createCreationNonce(): string;
export declare function createStableIssueId(input: StableIssueIdInput): string;
export declare function createStableCommentId(input: StableCommentIdInput): string;
export declare function isSha256Hex(value: string): boolean;
export declare function shortestUniquePrefix(id: string, ids: Iterable<string>, minimum?: number): string;
