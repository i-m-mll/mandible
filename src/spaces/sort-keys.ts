const SORT_ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz";
const SORT_BASE = SORT_ALPHABET.length;
const MIN_DIGIT = SORT_ALPHABET[0];

function digitValue(ch: string): number {
  const idx = SORT_ALPHABET.indexOf(ch);
  return idx < 0 ? 0 : idx;
}

/**
 * A key strictly between `before` and `after` in lexicographic order. Pass null
 * for an open end (start or end of the list). Deterministic for a given pair.
 *
 * Digit-by-digit midpoint: walk shared positions; when the low/high digits
 * differ by more than one there is an integer digit strictly between them, so
 * emit it and stop. When they are equal or adjacent, copy the low digit (or the
 * minimum digit when the low side is exhausted) and continue deeper — the high
 * bound stops constraining positions past its own length. The loop always
 * terminates because each step either returns or extends the prefix toward the
 * (strictly larger) high bound.
 */
export function generateSortKey(before: string | null, after: string | null): string {
  const lo = before ?? "";
  const hi = after ?? "";
  if (lo && hi && lo >= hi) {
    throw new Error(`sort-key bounds out of order: ${JSON.stringify({ before, after })}`);
  }

  let prefix = "";
  let i = 0;
  for (;;) {
    const loDigit = i < lo.length ? digitValue(lo[i]) : 0;
    const hiBounded = i < hi.length;
    const hiDigit = hiBounded ? digitValue(hi[i]) : SORT_BASE;

    if (hiDigit - loDigit > 1) {
      // An integer digit sits strictly between the two at this position.
      const mid = Math.floor((loDigit + hiDigit) / 2);
      return prefix + SORT_ALPHABET[mid];
    }

    if (!hiBounded) {
      // The high bound is exhausted but the low side is still tracking it (no gap
      // found). Anything appended after copying lo's digit is < the open high
      // end, so emit lo's digit then a mid digit and stop.
      prefix += SORT_ALPHABET[loDigit];
      return prefix + SORT_ALPHABET[Math.floor(SORT_BASE / 2)];
    }

    if (loDigit === hiDigit) {
      // Shared digit: copy it and keep BOTH bounds active one level deeper.
      prefix += SORT_ALPHABET[loDigit];
      i += 1;
      continue;
    }

    // Adjacent digits (hiDigit === loDigit + 1): descend on the LOW side. Copy
    // lo's digit; from here the high bound no longer constrains (any tail keeps
    // us below hi's larger digit), so continue against an open top end.
    prefix += SORT_ALPHABET[loDigit];
    return prefix + generateSortKey(lo.slice(i + 1), null);
  }
}

/**
 * Re-space a sibling list onto evenly distributed, fixed-width keys. Input order
 * is preserved (callers sort first); output keys are strictly increasing and
 * deterministic for a given length. Use when {@link generateSortKey} headroom is
 * exhausted or to canonicalize externally-supplied keys.
 */
export function normalizeSortKeys(count: number): string[] {
  if (count <= 0) return [];
  // Width grows with count so keys stay evenly spaced and strictly increasing.
  const width = Math.max(2, Math.ceil(Math.log(count + 1) / Math.log(SORT_BASE)) + 1);
  const span = SORT_BASE ** width;
  const step = Math.max(1, Math.floor(span / (count + 1)));
  const keys: string[] = [];
  for (let n = 1; n <= count; n += 1) {
    keys.push(encodeBase36(step * n, width));
  }
  return keys;
}

function encodeBase36(value: number, width: number): string {
  let v = Math.max(0, Math.floor(value));
  let out = "";
  while (v > 0) {
    out = SORT_ALPHABET[v % SORT_BASE] + out;
    v = Math.floor(v / SORT_BASE);
  }
  return out.padStart(width, MIN_DIGIT).slice(-width);
}

/** Validate that a candidate sort key is a non-empty base-36 string. */
export function isValidSortKey(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    [...value].every((ch) => SORT_ALPHABET.includes(ch))
  );
}
