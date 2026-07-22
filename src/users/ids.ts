import { randomInt } from "node:crypto";

// Crockford Base32 alphabet (no I, L, O, U) — the standard ULID encoding.
const ENCODING = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const TIME_LEN = 10;
const RANDOM_LEN = 16;

/**
 * Generate a ULID: a 26-character, lexicographically sortable identifier with a
 * 48-bit millisecond timestamp prefix and 80 bits of randomness. The user
 * registry uses ULIDs so ids sort by creation time without leaking a sequence.
 *
 * The `system` user is the one exception: it carries a fixed all-zero sentinel
 * id (see SYSTEM_USER_ID) rather than a minted ULID.
 */
export function ulid(now: number = Date.now()): string {
  return encodeTime(now) + encodeRandom();
}

function encodeTime(now: number): string {
  if (!Number.isFinite(now) || now < 0) {
    throw new Error(`Invalid ULID timestamp: ${now}`);
  }
  let time = Math.floor(now);
  let out = "";
  for (let i = TIME_LEN - 1; i >= 0; i -= 1) {
    const mod = time % 32;
    out = ENCODING[mod] + out;
    time = (time - mod) / 32;
  }
  return out;
}

function encodeRandom(): string {
  let out = "";
  for (let i = 0; i < RANDOM_LEN; i += 1) {
    out += ENCODING[randomInt(0, 32)];
  }
  return out;
}
