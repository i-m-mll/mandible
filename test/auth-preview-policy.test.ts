import { describe, expect, it } from "vitest";

import { isPersistentIabPreviewBranch } from "../src/auth-preview-policy.js";

describe("persistent IAB preview delivery policy", () => {
  it("recognizes every launcher-owned integration branch", () => {
    expect(isPersistentIabPreviewBranch("integration/mandible-iab-preview-20260904-72cb587")).toBe(true);
    expect(isPersistentIabPreviewBranch("integration/mandible-iab-preview-20260904-72cb587-2")).toBe(true);
  });

  it("allows disposable delivery and ordinary integration branches", () => {
    expect(isPersistentIabPreviewBranch("integration/865a1f3-delivery")).toBe(false);
    expect(isPersistentIabPreviewBranch("feature/sidebar-fix")).toBe(false);
  });
});
