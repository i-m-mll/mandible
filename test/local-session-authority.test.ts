// @vitest-environment node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { LocalSessionAuthority } from "../src/client-auth/session-authority.js";
import {
  authorizeEffects,
  operationForRequest,
  STANDARD_PREVIEW_EFFECTS,
} from "../src/security/effect-policy.js";
import type { InstanceInfo } from "../src/types.js";

const roots = new Set<string>();
afterEach(() => {
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
  roots.clear();
});

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-local-session-"));
  roots.add(root);
  const now = { value: 1_000_000 };
  const authority = new LocalSessionAuthority(path.join(root, "authority"), "install_test", {
    initialize: true,
    now: () => now.value,
  });
  authority.registerInstance({
    instance_id: "production",
    installation_id: "install_test",
    role: "main",
    public_origin: "https://mandible.localhost",
    backend_origin: "http://127.0.0.1:29420",
    backend_generation: "main-1",
    effect_ceiling: ["ledger:read", "ledger:write", "auth:protected"],
    writable_roots: [],
  });
  authority.registerInstance({
    instance_id: "preview-test",
    installation_id: "install_test",
    role: "preview",
    public_origin: "https://preview-test.mandible.localhost:19421",
    backend_origin: "http://127.0.0.1:29421",
    backend_generation: "preview-1",
    effect_ceiling: STANDARD_PREVIEW_EFFECTS,
    writable_roots: [root],
  });
  return { authority, now, root };
}

describe("local browser session authority", () => {
  it("stores only an opaque digest and classifies audience, expiry, and revocation", () => {
    const { authority, now, root } = fixture();
    const issued = authority.issueSession("user_1", "operator", "production", {
      method: "api_token",
      credential_id: "credential_1",
      authenticated_at: now.value,
    });
    const bytes = fs.readFileSync(path.join(root, "authority", "sessions.db"));
    expect(bytes.includes(Buffer.from(issued.token))).toBe(false);
    expect(authority.classify(issued.token, "production").state).toBe("active");
    expect(authority.classify(issued.token, "preview-test").state).toBe("wrong_audience");
    expect(authority.revokeFamily(issued.family_id)?.family_ids).toEqual([issued.family_id]);
    expect(authority.classify(issued.token, "production").state).toBe("revoked");
    authority.close();
  });

  it("survives authority restarts and renews idempotently up to the absolute limit", () => {
    const { authority, now, root } = fixture();
    const issued = authority.issueSession("user_1", "operator", "production", {
      method: "api_token",
      credential_id: "credential_1",
      authenticated_at: now.value,
    });
    authority.close();
    const reopened = new LocalSessionAuthority(path.join(root, "authority"), "install_test", {
      initialize: false,
      now: () => now.value,
    });
    now.value += 29 * 24 * 60 * 60 * 1_000;
    const first = reopened.classify(issued.token, "production");
    const retry = reopened.classify(issued.token, "production");
    expect(first.state).toBe("active");
    expect(retry.state).toBe("active");
    if (first.state === "active" && retry.state === "active") {
      expect(retry.session.expires_at).toBe(first.session.expires_at);
    }
    now.value = issued.absolute_expires_at + 1;
    expect(reopened.classify(issued.token, "production").state).toBe("expired");
    reopened.close();
  });

  it("requires explicit pairing approval and binds the issued family to its target", () => {
    const { authority } = fixture();
    const pairing = authority.beginPairing("preview-test", "/timeline?view=all");
    expect(authority.completePairing(pairing.reference, pairing.secret, () => "operator")).toBeNull();
    authority.approvePairing(pairing.reference, "user_1");
    const issued = authority.completePairing(pairing.reference, pairing.secret, () => "operator");
    expect(issued?.audience).toBe("preview-test");
    expect(authority.completePairing(pairing.reference, pairing.secret, () => "operator")).toBeNull();
    authority.close();
  });

  it("binds expired-browser recovery to one approved production family and one preview's saved state", () => {
    const { authority } = fixture();
    const state = { "mandible.briefing.draft:v2:test": "unsent answer", "sidebar-width:auth": "320" };
    const recovery = authority.beginBrowserRecovery("preview-test", "/#/console?conversation=test", state);
    expect(recovery.audience).toBe("production");
    expect(authority.pendingBrowserRecoveries()).toMatchObject([{ reference: recovery.reference, source_audience: "preview-test", browser_state_entries: 2 }]);
    expect(authority.completePairing(recovery.reference, recovery.secret, () => "operator")).toBeNull();
    authority.approvePairing(recovery.reference, "user_1");
    expect(authority.completePairing(recovery.reference, "stolen-reference-without-secret", () => "operator")).toBeNull();
    const issued = authority.completePairing(recovery.reference, recovery.secret, () => "operator");
    expect(issued?.audience).toBe("production");
    expect(authority.completePairing(recovery.reference, recovery.secret, () => "operator")).toBeNull();
    expect(authority.browserRecoveryState(issued!.root_family_id, "preview-test")).toBeNull();
    expect(authority.verifyBrowserRecovery(issued!.root_family_id)).toMatchObject({ source_audience: "preview-test" });
    expect(authority.browserRecoveryState(issued!.root_family_id, "production")).toBeNull();
    expect(authority.browserRecoveryState(issued!.root_family_id, "preview-test")).toEqual({
      browser_state: state, return_path: "/#/console?conversation=test",
    });
    expect(authority.finalizeBrowserRecovery(issued!.root_family_id, "production")).toBe(false);
    expect(authority.finalizeBrowserRecovery(issued!.root_family_id, "preview-test")).toBe(true);
    expect(authority.browserRecoveryState(issued!.root_family_id, "preview-test")).toBeNull();
    authority.close();
  });

  it("rejects foreign return origins, wrong browser secrets, and forged preview contexts", async () => {
    const { authority } = fixture();
    expect(() => authority.beginPairing("preview-test", "https://evil.invalid/return")).toThrow(
      "Pairing return path must be a local absolute path.",
    );
    const pairing = authority.beginPairing("preview-test", "/issues");
    authority.approvePairing(pairing.reference, "user_1");
    expect(authority.completePairing(pairing.reference, "wrong", () => "operator")).toBeNull();
    const issued = authority.completePairing(pairing.reference, pairing.secret, () => "operator");
    expect(issued).not.toBeNull();
    const context = await authority.signPreviewContext(issued!, "preview-test");
    const registration = authority.instance("preview-test")!;
    expect(await LocalSessionAuthority.verifyPreviewContext(
      context,
      authority.verificationKeyPem(),
      registration,
    )).toMatchObject({ audience: "preview-test", user_id: "user_1" });
    const contextParts = context.split(".");
    contextParts[1] = `${contextParts[1].slice(0, 3)}${contextParts[1][3] === "A" ? "B" : "A"}${contextParts[1].slice(4)}`;
    expect(await LocalSessionAuthority.verifyPreviewContext(
      contextParts.join("."),
      authority.verificationKeyPem(),
      registration,
    )).toBeNull();
    expect(await LocalSessionAuthority.verifyPreviewContext(
      context,
      authority.verificationKeyPem(),
      { ...registration, backend_generation: "preview-2" },
    )).toBeNull();
    authority.close();
  });
  it("derives one retry-safe preview family and revokes it with the production root", () => {
    const { authority, now } = fixture();
    const root = authority.issueSession("user_1", "operator", "production", {
      method: "api_token", credential_id: "credential_1", authenticated_at: now.value,
    });
    const transfer = authority.beginPreviewTransfer("preview-test", "/timeline");
    authority.authorizePreviewTransfer(transfer.reference, root);
    const first = authority.completePreviewTransfer(transfer.reference, transfer.secret);
    const retry = authority.completePreviewTransfer(transfer.reference, transfer.secret);
    expect(first).not.toBeNull();
    expect(retry).toMatchObject({ token: first?.token, family_id: first?.family_id });
    expect(first?.root_family_id).toBe(root.family_id);
    expect(authority.classify(first!.token, "production").state).toBe("wrong_audience");
    expect(authority.revokeFamily(first!.family_id)?.family_ids).toEqual(
      expect.arrayContaining([root.family_id, first!.family_id]),
    );
    expect(authority.classify(first!.token, "preview-test").state).toBe("revoked");
    authority.close();
  });

  it("converts legacy state transactionally, retries deterministically, and tombstones resurrection", () => {
    const { authority, now } = fixture();
    const input = {
      raw_legacy_token: "legacy-secret-token",
      legacy_fingerprint: "legacy-fingerprint",
      user_id: "user_1",
      slug: "operator",
      target_audience: "production",
      return_path: "/issues?selected=8b97e8d",
      browser_state: { "mandible.view": "timeline" },
      authenticated_at: now.value,
    };
    const prepared = authority.beginLegacyConversion(input);
    expect(authority.beginLegacyConversion(input)).toMatchObject({
      reference: prepared.reference, secret: prepared.secret,
    });
    const issued = authority.completeLegacyConversion(prepared.reference, prepared.secret)!;
    expect(issued.absolute_expires_at).toBe(input.authenticated_at + 180 * 24 * 60 * 60 * 1_000);
    expect(authority.completeLegacyConversion(prepared.reference, prepared.secret)).toMatchObject({
      token: issued.token, family_id: issued.family_id,
    });
    expect(authority.legacyConversionDetails(issued)).toEqual({
      browser_state: input.browser_state,
      return_path: input.return_path,
      finalized: false,
    });
    expect(authority.finalizeLegacyConversion(issued)).toBe(input.legacy_fingerprint);
    expect(authority.isLegacyFingerprintRetired(input.legacy_fingerprint)).toBe(true);
    expect(authority.finalizeLegacyConversion(issued)).toBeNull();
    expect(() => authority.beginLegacyConversion(input)).toThrow("cannot be resurrected");
    authority.close();
  });
});

describe("effect ceilings", () => {
  const preview: InstanceInfo = {
    role: "preview",
    instance_id: "preview-test",
    installation_id: "install_test",
    public_origin: "https://preview-test.mandible.localhost:19421",
    backend_generation: "preview-1",
    allowed_effects: STANDARD_PREVIEW_EFFECTS,
    writable_roots: ["/tmp/preview"],
    preview_root: "/tmp/preview",
    db_path: "/tmp/preview/copy.db",
    db_path_source: "iab-preview-copy",
    source_db_path: "/tmp/source.db",
    source_db_path_source: "env",
  };

  it("intersects operator sessions with the instance ceiling across privileged paths", () => {
    const operator = { effect_ceiling: [
      "ledger:read", "ledger:write", "files:preview", "auth:protected",
      "process:external", "provider:send", "network:publish", "delivery:background",
    ] as const };
    expect(authorizeEffects(preview, operator, operationForRequest("POST", "/api/issues"))).toEqual({ allowed: true });
    for (const target of [
      ["GET", "/api/auth/requests"],
      ["POST", "/api/agent-dispatch"],
      ["POST", "/api/conversations/conv_1/control/submit"],
      ["POST", "/api/webhooks"],
      ["POST", "/api/reminders"],
    ] as const) {
      expect(authorizeEffects(preview, operator, operationForRequest(...target)).allowed).toBe(false);
    }
  });
});
