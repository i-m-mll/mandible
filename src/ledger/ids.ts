import { randomBytes } from "node:crypto";

export const LEDGER_ID_PREFIXES = [
  "prj",
  "chk",
  "iss",
  "com",
  "evt",
  "out",
  "rel",
  "cnf",
  "xref",
  "job",
  "rec",
  "mis",
  "opb",
  "opm",
] as const;

export type LedgerIdPrefix = (typeof LEDGER_ID_PREFIXES)[number];

export interface LedgerIdOptions {
  now?: number;
  random?: Buffer;
}

const TIME_WIDTH = 10;
const RANDOM_BYTES = 10;

/**
 * Generate a Mandible ledger ID. This is UUIDv7-like rather than a full RFC
 * UUIDv7 implementation: lexicographic order follows millisecond time, then a
 * cryptographic-random suffix prevents path/title/git-bug-derived IDs.
 */
export function createLedgerId(prefix: LedgerIdPrefix, options: LedgerIdOptions = {}): string {
  const now = options.now ?? Date.now();
  if (!Number.isFinite(now) || now < 0) {
    throw new Error(`Invalid ledger ID timestamp: ${now}`);
  }
  const time = Math.floor(now).toString(36).padStart(TIME_WIDTH, "0");
  const entropy = options.random ?? randomBytes(RANDOM_BYTES);
  if (entropy.length < RANDOM_BYTES) {
    throw new Error(`Ledger ID entropy must be at least ${RANDOM_BYTES} bytes`);
  }
  return `${prefix}_${time}_${entropy.subarray(0, RANDOM_BYTES).toString("hex")}`;
}

export function isLedgerIdWithPrefix(value: string, prefix: LedgerIdPrefix): boolean {
  return value.startsWith(`${prefix}_`);
}
