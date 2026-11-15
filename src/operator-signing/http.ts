import type { ResponseLike } from "../server.js";
import type { Signed, SigningRefusal } from "./authority.js";

/** A signed action the approval key did not authorize. */
export class SignedActionRefused extends Error {
  constructor(public readonly refusal: SigningRefusal) {
    super(refusal.detail);
    this.name = "SignedActionRefused";
  }
}

export function signedOrThrow<T>(signed: Signed<T>): T {
  if (!signed.ok) throw new SignedActionRefused(signed.error);
  return signed.value;
}

export function sendSigningRefusal(res: ResponseLike, refusal: SigningRefusal): void {
  res.status(refusal.code === "untrusted_signature" ? 403 : refusal.code === "signing_failed" ? 502 : 409)
    .json({ error: refusal.detail, code: `operator_signature_${refusal.code}` });
}
