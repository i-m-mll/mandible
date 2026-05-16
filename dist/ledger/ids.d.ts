export declare const LEDGER_ID_PREFIXES: readonly ["prj", "chk", "iss", "com", "evt", "out", "rel", "cnf", "xref"];
export type LedgerIdPrefix = (typeof LEDGER_ID_PREFIXES)[number];
export interface LedgerIdOptions {
    now?: number;
    random?: Buffer;
}
/**
 * Generate a Mandible ledger ID. This is UUIDv7-like rather than a full RFC
 * UUIDv7 implementation: lexicographic order follows millisecond time, then a
 * cryptographic-random suffix prevents path/title/git-bug-derived IDs.
 */
export declare function createLedgerId(prefix: LedgerIdPrefix, options?: LedgerIdOptions): string;
export declare function isLedgerIdWithPrefix(value: string, prefix: LedgerIdPrefix): boolean;
