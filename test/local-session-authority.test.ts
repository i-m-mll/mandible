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
    public_origin: "https://app.mandible.localhost:19420",
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
    expect(authority.revokeFamily(issued.family_id)).toBe(true);
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
