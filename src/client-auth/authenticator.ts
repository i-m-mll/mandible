// The client-authentication gate wired into the HTTP/file-RPC boundary.
//
// Responsibilities:
//   - Resolve a presented bearer/capability token to a user identity, from two
//     sources: persisted api_token credentials (CLI/agent tokens) and in-memory
//     ephemeral tokens (dashboard bootstrap handshake, per-agent file-RPC
//     capability tokens). Ephemeral tokens live only for the daemon's lifetime.
//   - Report the current mode (compat | strict).
//   - Count unattributed writes (the strict-mode readiness ratchet).
//   - Provide the operator's dashboard bootstrap token so operator UI actions
//     authenticate as the operator even in strict mode.
//
// This module performs AUTHENTICATION and identity attach only. Authorization
// (groups/permissions) and evidence persistence are separate umbrella children.

import type { Db } from "../db.js";
import { getOperator } from "../users/store.js";
import type {
  ClientAuthGate,
  ClientAuthMode,
  ResolvedClientIdentity,
} from "../server.js";
import { getClientAuthMode } from "./mode.js";
import {
  ClientAuthTelemetry,
  type ClientAuthTelemetrySnapshot,
  type UnattributedWriteContext,
} from "./telemetry.js";
import {
  fingerprintForToken,
  generateRawToken,
  normalizeBearer,
  verifyApiToken,
} from "./tokens.js";

interface EphemeralEntry {
  identity: { user_id: string; slug: string };
  purpose: string;
}

export class ClientAuthenticator implements ClientAuthGate {
  private readonly ephemeral = new Map<string, EphemeralEntry>();
  private readonly telemetry = new ClientAuthTelemetry();
  private bootstrapRaw: string | null = null;

  constructor(private readonly db: Db) {}

  mode(): ClientAuthMode {
    return getClientAuthMode(this.db);
  }

  authenticate(
    credential: string | null | undefined,
    source: ResolvedClientIdentity["source"] = "http_bearer",
  ): ResolvedClientIdentity | null {
    const token = normalizeBearer(credential);
    if (!token) return null;

    // Ephemeral tokens (bootstrap / file-RPC capability) take precedence: they
    // are daemon-lifetime secrets minted by the daemon itself.
    const key = fingerprintForToken(this.db, token);
    const eph = this.ephemeral.get(key);
    if (eph) {
      return {
        user_id: eph.identity.user_id,
        slug: eph.identity.slug,
        method: "ephemeral",
        credential_id: null,
        source,
      };
    }

    const verified = verifyApiToken(this.db, token);
    if (verified) {
      return {
        user_id: verified.user.id,
        slug: verified.user.slug,
        method: "api_token",
        credential_id: verified.credentialId,
        source,
      };
    }
    return null;
  }

  recordUnattributedWrite(ctx: UnattributedWriteContext): void {
    this.telemetry.recordUnattributedWrite(ctx);
  }

  telemetrySnapshot(): ClientAuthTelemetrySnapshot {
    return this.telemetry.snapshot();
  }

  /**
   * Register a daemon-lifetime ephemeral token bound to a user identity. Used
   * for the dashboard bootstrap handshake and for per-agent file-RPC capability
   * tokens injected at spawn time. Returns the raw token (shown once).
   */
  issueEphemeralToken(identity: { user_id: string; slug: string }, purpose: string): string {
    let raw = "";
    let key = "";
    // Avoid the astronomically unlikely collision with an existing ephemeral key.
    do {
      raw = generateRawToken();
      key = fingerprintForToken(this.db, raw);
    } while (this.ephemeral.has(key));
    this.ephemeral.set(key, { identity, purpose });
    return raw;
  }

  /**
   * The operator's dashboard bootstrap token, injected into the served index
   * HTML so operator UI actions authenticate. Lazily minted and reused for the
   * daemon lifetime. Returns null when no operator is configured yet, in which
   * case the dashboard falls back to compat-mode anonymous behavior.
   */
  bootstrapToken(): string | null {
    const operator = getOperator(this.db);
    if (!operator) return null;
    if (this.bootstrapRaw) {
      const key = fingerprintForToken(this.db, this.bootstrapRaw);
      const entry = this.ephemeral.get(key);
      if (entry && entry.identity.user_id === operator.id) return this.bootstrapRaw;
    }
    this.bootstrapRaw = this.issueEphemeralToken(
      { user_id: operator.id, slug: operator.slug },
      "dashboard_bootstrap",
    );
    return this.bootstrapRaw;
  }
}
