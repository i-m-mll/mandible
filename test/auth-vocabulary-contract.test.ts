// @vitest-environment node
//
// Contracts on the auth vocabularies that TypeScript cannot enforce on its own.
//
// Everything the compiler *can* check is deliberately not restated here. Adding
// an `AuthRequestActionKind` is already a build error at five call sites, and
// adding an `AuthRequestStatus` is a build error in `computeAuthRequestOutcome`.
// What survives compilation is the part that crosses a language boundary — the
// SQL `CHECK` constraint — and the part that is a claim about meaning rather
// than shape: that a terminal status is never reported as still in flight, and
// that a failed signature verification is never reported as verified.
import { describe, expect, it } from "vitest";

import {
  AUTH_REQUEST_ACTION_KINDS,
  computeAuthRequestOutcome,
  type AuthRequestStatus,
} from "../src/contracts.js";
import { AttributionReadResolver } from "../src/identity/read-projection.js";
import { addAttributionEvidence } from "../src/users/store.js";
import { createMigratedDb } from "./helpers/ledger-fixtures.js";

describe("auth action kind vocabulary", () => {
  it("matches the SQL CHECK constraint on auth_request_actions.kind", () => {
    // The fourth representation of this vocabulary is a SQL string, which
    // cannot import the TypeScript array. Read it back from the schema the
    // migrations actually produce, not from the baseline constant, so a
    // migration that alters the column is covered too.
    const db = createMigratedDb({ now: 1 });
    const row = db
      .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'auth_request_actions'")
      .get() as { sql: string } | undefined;
    expect(row?.sql, "auth_request_actions table is missing").toBeTruthy();

    const check = /kind\s+TEXT\s+NOT NULL\s+CHECK\(kind IN \(([^)]*)\)\)/i.exec(row!.sql);
    expect(check, `could not find the kind CHECK constraint in: ${row!.sql}`).toBeTruthy();

    const sqlKinds = check![1]
      .split(",")
      .map((part) => part.trim().replace(/^'|'$/g, ""))
      .filter(Boolean);

    // Set equality both ways: a kind the code accepts but the DB rejects fails
    // at INSERT; a kind the DB accepts but the code does not handle is the
    // silent-no-op case that used to be recorded as `applied`.
    expect([...sqlKinds].sort()).toEqual([...AUTH_REQUEST_ACTION_KINDS].sort());
  });
});

describe("auth request outcome", () => {
  // Not a restatement of the switch: the compiler checks that every status is
  // handled, and cannot check that the terminal ones are handled as terminal.
  // `null` means "still in lifecycle", so a terminal status mapping to null
  // would leave a finished request reporting as in flight through both the
  // SSE payload and the session inbox.
  const TERMINAL: AuthRequestStatus[] = [
    "rejected",
    "expired",
    "dismissed",
    "needs_rebase",
    "completed",
  ];
  const IN_FLIGHT: AuthRequestStatus[] = ["pending", "executing", "approved"];

  it.each(TERMINAL)("reports %s as a terminal outcome", (status) => {
    expect(computeAuthRequestOutcome(status, 0)).not.toBeNull();
  });

  it.each(IN_FLIGHT)("reports %s as still in lifecycle", (status) => {
    expect(computeAuthRequestOutcome(status, null)).toBeNull();
  });

  it("separates a completed merge that failed from one that succeeded", () => {
    expect(computeAuthRequestOutcome("completed", 0)).toBe("succeeded");
    expect(computeAuthRequestOutcome("completed", 1)).toBe("failed");
  });
});

describe("merge signature claim", () => {
  // The badge the approver reads before authorizing a protected-branch merge.
  // Evidence is written with `evidence_method: "credential_signature"` whether
  // or not verification succeeded, so the method name alone claims nothing.
  function claimFor(details: Record<string, unknown>) {
    const db = createMigratedDb({ now: 1 });
    const evidence = addAttributionEvidence(db, {
      evidence_method: "credential_signature",
      details,
    });
    return new AttributionReadResolver(db).mergeSignatureClaim(evidence.id);
  }

  it("does not claim verified when verification failed", () => {
    expect(claimFor({ verified: false, reason: "verification_error" })).toEqual({
      state: "unverified",
      reason: "verification_error",
    });
  });

  it("does not claim verified when the result was never recorded", () => {
    expect(claimFor({})).toEqual({ state: "unverified", reason: null });
  });

  it("claims verified only for a recorded successful verification", () => {
    expect(claimFor({ verified: true, fingerprint: "SHA256:abc" })).toEqual({
      state: "verified",
      fingerprint: "SHA256:abc",
    });
  });

  it("claims nothing when there is no signature evidence", () => {
    const db = createMigratedDb({ now: 1 });
    const other = addAttributionEvidence(db, { evidence_method: "session_claim" });
    const resolver = new AttributionReadResolver(db);
    expect(resolver.mergeSignatureClaim(other.id)).toEqual({ state: "none" });
    expect(resolver.mergeSignatureClaim(null)).toEqual({ state: "none" });
  });
});
