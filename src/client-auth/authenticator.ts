// The client-authentication gate wired into the HTTP/file-RPC boundary.
//
// Responsibilities:
//   - Resolve a presented bearer/capability token to a user identity, from two
//     sources: persisted api_token credentials (CLI/agent tokens) and in-memory
//     ephemeral tokens (dashboard handshake, operator bootstrap-token file,
//     per-agent file-RPC capability tokens). Ephemeral tokens live only for the
//     daemon's lifetime.
//   - Report the current mode (compat | strict).
//   - Count unattributed writes (the strict-mode readiness ratchet).
//   - Own the operator's bootstrap token: a daemon-lifetime ephemeral token
//     written to a 0600 file (never embedded in any HTTP response) so a same-user
//     CLI can authenticate, and re-issued to the dashboard via the handshake
//     route.
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
  defaultClientAuthDir,
  loadOrCreatePepper,
  writeBootstrapTokenFile,
} from "./secret-store.js";
import {
  ClientAuthTelemetry,
  type ClientAuthTelemetrySnapshot,
  type UnattributedWriteContext,
} from "./telemetry.js";
import {
  fingerprintForToken,
  generateRawToken,
  mintApiToken,
  normalizeBearer,
  verifyApiToken,
  type MintedToken,
} from "./tokens.js";

interface EphemeralEntry {
  identity: { user_id: string; slug: string };
  purpose: string;
}

export interface ClientAuthenticatorOptions {
  /** Override the filesystem secrets directory (tests). Defaults to config dir. */
  secretsDir?: string;
}

export class ClientAuthenticator implements ClientAuthGate {
  private readonly ephemeral = new Map<string, EphemeralEntry>();
  private readonly telemetry = new ClientAuthTelemetry();
  private readonly secretsDir: string;
  /** Pepper is loaded from the filesystem ONCE at construction (startup). */
  private readonly pepper: string;
  private bootstrapRaw: string | null = null;

  constructor(
    private readonly db: Db,
    options: ClientAuthenticatorOptions = {},
  ) {
    this.secretsDir = options.secretsDir ?? defaultClientAuthDir();
    this.pepper = loadOrCreatePepper(db, this.secretsDir);
  }

  mode(): ClientAuthMode {
    return getClientAuthMode(this.db);
  }

  authenticate(
    credential: string | null | undefined,
    source: ResolvedClientIdentity["source"] = "http_bearer",
  ): ResolvedClientIdentity | null {
    const token = normalizeBearer(credential);
    if (!token) return null;

    // Ephemeral tokens (bootstrap / handshake / file-RPC capability) take
    // precedence: they are daemon-lifetime secrets minted by the daemon itself.
    const key = fingerprintForToken(this.pepper, token);
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

    const verified = verifyApiToken(this.db, this.pepper, token);
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

  /** Mint a durable api_token for a user (only its hash is persisted). */
  mintApiToken(userRef: string, opts: { label?: string | null } = {}): MintedToken {
    return mintApiToken(this.db, this.pepper, userRef, opts);
  }

  /**
   * Register a daemon-lifetime ephemeral token bound to a user identity. Used
   * for the dashboard handshake, the operator bootstrap-token file, and
   * per-agent file-RPC capability tokens. Returns the raw token (shown once).
   */
  issueEphemeralToken(identity: { user_id: string; slug: string }, purpose: string): string {
    let raw = "";
    let key = "";
    // Avoid the astronomically unlikely collision with an existing ephemeral key.
    do {
      raw = generateRawToken();
      key = fingerprintForToken(this.pepper, raw);
    } while (this.ephemeral.has(key));
    this.ephemeral.set(key, { identity, purpose });
    return raw;
  }

  /**
   * The operator's bootstrap token: a daemon-lifetime ephemeral token. Lazily
   * minted and reused. Returns null when no operator is configured yet.
   */
  bootstrapToken(): string | null {
    const operator = getOperator(this.db);
    if (!operator) return null;
    if (this.bootstrapRaw) {
      const key = fingerprintForToken(this.pepper, this.bootstrapRaw);
      const entry = this.ephemeral.get(key);
      if (entry && entry.identity.user_id === operator.id) return this.bootstrapRaw;
    }
    this.bootstrapRaw = this.issueEphemeralToken(
      { user_id: operator.id, slug: operator.slug },
      "operator_bootstrap",
    );
    return this.bootstrapRaw;
  }

  /**
   * Write (or clear) the operator bootstrap-token file. Called at startup so a
   * same-user CLI can read it when MANDIBLE_TOKEN is unset. No token is written
   * when no operator exists.
   */
  refreshBootstrapTokenFile(): void {
    writeBootstrapTokenFile(this.bootstrapToken(), this.secretsDir);
  }
}
