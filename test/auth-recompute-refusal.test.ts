import { describe, expect, it } from "vitest";

import {
  describeRecomputeRefusal,
  STRICT_RECOMPUTE_MESSAGE,
} from "../src/auth-recompute-refusal.js";

// Issue 2205073 — the approval error must carry the guard that refused and the
// fix that applies to it. The original strict sentence stays first so existing
// callers, tests, and operator muscle memory keep working.

describe("describeRecomputeRefusal", () => {
  it("falls back to the strict message when no reason was recorded", () => {
    expect(describeRecomputeRefusal(null)).toBe(STRICT_RECOMPUTE_MESSAGE);
  });

  it("always leads with the strict message and names the reason", () => {
    const message = describeRecomputeRefusal({ reason: "execution_chain_busy" });
    expect(message.startsWith(STRICT_RECOMPUTE_MESSAGE)).toBe(true);
    expect(message).toContain("Refusal: execution_chain_busy");
    expect(message).toContain("Wait for it to finish and approve again");
  });

  it("names the drifted head branch and both commits", () => {
    const message = describeRecomputeRefusal({
      reason: "head_branch_moved",
      detail: {
        head_branch: "feature/x",
        reviewed_head: "1111111111111111111111111111111111111111",
        current_head: "2222222222222222222222222222222222222222",
      },
    });
    expect(message).toContain("Refusal: head_branch_moved");
    expect(message).toContain("feature/x");
    expect(message).toContain("222222222222");
    expect(message).toContain("111111111111");
  });

  it("names the untrusted signing key and the credential-registration fix", () => {
    const message = describeRecomputeRefusal(
      {
        reason: "base_transition_unaccounted",
        detail: {
          old_base: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          new_base: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
          transition_reason: "signature_not_authorized",
          commit: "cccccccccccccccccccccccccccccccccccccccc",
          signature_reason: "signature_not_trusted",
          signature_fingerprint: "SHA256:ZklQ9eEXAMPLEEXAMPLEEXAMPLEEXAMPLEEXAMPLE",
        },
      },
      { operatorRef: "mll" },
    );
    expect(message).toContain("Refusal: base_transition_unaccounted");
    expect(message).toContain("signature_not_trusted");
    expect(message).toContain("SHA256:ZklQ9eEXAMPLEEXAMPLEEXAMPLEEXAMPLEEXAMPLE");
    expect(message).toContain("cccccccccccc");
    expect(message).toContain("mandible user credential add mll --from-git-signingkey");
  });

  it("falls back to a generic operator ref when the registry has no slug", () => {
    const message = describeRecomputeRefusal({
      reason: "base_transition_unaccounted",
      detail: {
        transition_reason: "signature_not_authorized",
        signature_reason: "no_active_registered_signing_credentials",
        signature_fingerprint: "SHA256:abc",
      },
    });
    expect(message).toContain("mandible user credential add operator --from-git-signingkey");
  });

  it("does not suggest registering a key when the signer is a different user", () => {
    const message = describeRecomputeRefusal({
      reason: "base_transition_unaccounted",
      detail: {
        transition_reason: "signature_not_authorized",
        signature_reason: "signer_is_not_approving_user",
        signature_fingerprint: "SHA256:abc",
      },
    });
    expect(message).toContain("belongs to a different user");
    expect(message).not.toContain("--from-git-signingkey");
  });

  it("explains unaccounted transitions that are not signature failures", () => {
    const message = describeRecomputeRefusal({
      reason: "base_transition_unaccounted",
      detail: {
        transition_reason: "commit_not_a_recorded_queue_merge",
        commit: "dddddddddddddddddddddddddddddddddddddddd",
      },
    });
    expect(message).toContain("not a completed queue merge recorded by Mandible");
    expect(message).toContain("dddddddddddd");
  });

  it("lists the missing inputs when the request is not recomputable", () => {
    const message = describeRecomputeRefusal({
      reason: "not_recomputable_request",
      detail: { missing: ["execution_mode=remote"] },
    });
    expect(message).toContain("Refusal: not_recomputable_request");
    expect(message).toContain("execution_mode=remote");
  });

  it("names the pin failure when the refreshed candidate cannot be pinned", () => {
    const message = describeRecomputeRefusal({
      reason: "repin_failed",
      detail: { repin_reason: "injected pin cache failure" },
    });
    expect(message).toContain("Refusal: repin_failed");
    expect(message).toContain("injected pin cache failure");
    expect(message).toContain("previous pin state is intact");
  });

  it("degrades gracefully for an unknown reason", () => {
    const message = describeRecomputeRefusal({ reason: "some_future_guard" });
    expect(message).toContain("Refusal: some_future_guard");
    expect(message).toContain("Requeue and reapprove");
  });
});
