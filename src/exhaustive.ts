/**
 * Compile-time exhaustiveness for discriminated unions.
 *
 * TypeScript only catches an unhandled union variant on its own when a switch
 * is *expression-shaped*: every case returns, the function declares a return
 * type that excludes `undefined`, and there is no `default`. Mandible's
 * authority-path switches are mostly *statement-shaped* — cases `break` and
 * control falls through to shared code — so adding a variant compiles clean and
 * fails silently at runtime. These two helpers make the check explicit and
 * independent of switch shape.
 *
 * Pick by what the caller should do when the impossible happens:
 *
 * - `assertNever` for a write, an attestation, or an authorization decision.
 *   Continuing would record something untrue, so it throws.
 * - `exhausted` for a projection or a render, where throwing would take out a
 *   surrounding view that is otherwise fine. It returns a caller-chosen
 *   fallback, so the fallback is deliberate and visible at the call site rather
 *   than hidden in a bare `default:`.
 *
 * Both bind their argument to `never`, so either one turns a new variant into a
 * compile error at every call site. That is the whole point; the runtime
 * behaviour only decides what happens to a database row written by an older or
 * newer peer that this build does not know about.
 */

/**
 * Fail closed and loudly on an unhandled variant. The message names the value,
 * because the variant that reached here is the one fact worth reporting.
 */
export function assertNever(value: never, context: string): never {
  throw new Error(`${context}: unhandled variant ${JSON.stringify(value)}`);
}

/**
 * Fail closed and quietly on an unhandled variant, returning `fallback`.
 *
 * Use only where the caller has a genuinely safe neutral answer and a thrown
 * error would be worse than a degraded one. The fallback is a parameter rather
 * than a default so that choosing it is a deliberate act at the call site.
 */
export function exhausted<T>(value: never, fallback: T): T {
  void value;
  return fallback;
}
