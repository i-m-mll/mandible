// The client-authentication gate wired into the HTTP/file-RPC boundary.
//
// Responsibilities:
//   - Resolve a presented bearer/capability token to a user identity, from two
//     sources: persisted api_token credentials (CLI/agent tokens) and bounded
//     ephemeral tokens (dashboard session, operator bootstrap-token file,
//     per-agent file-RPC capability tokens). The dashboard session fingerprint
//     and bounded renewal deadline are held in a protected file so strict-mode
//     renewal survives daemon restart without persisting reusable bearer bytes.
//   - Report the current mode (compat | strict).
//   - Count unattributed writes (the strict-mode readiness ratchet).
//   - Own the operator's bootstrap token: a daemon-lifetime ephemeral token
//     written to a 0600 file (never embedded in any HTTP response) so a same-user
//     CLI can authenticate and explicitly enroll the dashboard.
//
// This module performs AUTHENTICATION and identity attach only. Authorization
// (groups/permissions) and evidence persistence are separate umbrella children.

import type { Db } from "../db.js";
import { getOperator, getUserById } from "../users/store.js";
import type {
  ClientAuthRequestContext,
  ClientAuthGate,
  ClientAuthMode,
  ResolvedClientIdentity,
} from "../server.js";
import { getClientAuthMode } from "./mode.js";
import {
  defaultClientAuthDir,
  loadOrCreatePepper,
  readDashboardSession,
  writeDashboardSession,
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
  createdAt: number;
  expiresAt: number | null;
  /** Hard deadline for handshake-only renewal of an expired dashboard token. */
  renewUntil: number | null;
}

export interface ClientAuthenticatorOptions {
  /** Override the filesystem secrets directory (tests). Defaults to config dir. */
  secretsDir?: string;
  /** Expiry for the single restart-stable dashboard session (tests may shorten). */
  dashboardSessionTtlMs?: number;
  /** Bounded handshake-only renewal grace after dashboard expiry (tests may shorten). */
  dashboardSessionRenewalGraceMs?: number;
  /** Hard cap for daemon-lifetime ephemeral credentials. */
  maxEphemeralTokens?: number;
  /** Injectable clock for expiry tests. */
  now?: () => number;
}

const DEFAULT_DASHBOARD_SESSION_TTL_MS = 24 * 60 * 60 * 1_000;
const DEFAULT_DASHBOARD_SESSION_RENEWAL_GRACE_MS = 7 * 24 * 60 * 60 * 1_000;
const DEFAULT_EPHEMERAL_TTL_MS = 15 * 60 * 1_000;
const OPERATOR_BOOTSTRAP_TTL_MS = 5 * 60 * 1_000;
const DEFAULT_MAX_EPHEMERAL_TOKENS = 256;

export class ClientAuthenticator implements ClientAuthGate {
  private readonly ephemeral = new Map<string, EphemeralEntry>();
  private readonly telemetry = new ClientAuthTelemetry();
  private readonly secretsDir: string;
  private readonly dashboardSessionTtlMs: number;
  private readonly dashboardSessionRenewalGraceMs: number;
  private readonly maxEphemeralTokens: number;
  private readonly now: () => number;
  /** Pepper is loaded from the filesystem ONCE at construction (startup). */
  private readonly pepper: string;
  private bootstrapRaw: string | null = null;

  constructor(
    private readonly db: Db,
    options: ClientAuthenticatorOptions = {},
  ) {
    this.secretsDir = options.secretsDir ?? defaultClientAuthDir();
    this.dashboardSessionTtlMs = options.dashboardSessionTtlMs
      ?? DEFAULT_DASHBOARD_SESSION_TTL_MS;
    this.dashboardSessionRenewalGraceMs = options.dashboardSessionRenewalGraceMs
      ?? DEFAULT_DASHBOARD_SESSION_RENEWAL_GRACE_MS;
    this.maxEphemeralTokens = Math.max(
      2,
      options.maxEphemeralTokens ?? DEFAULT_MAX_EPHEMERAL_TOKENS,
    );
    this.now = options.now ?? Date.now;
    this.pepper = loadOrCreatePepper(db, this.secretsDir);
    this.restoreDashboardSession();
  }

  mode(): ClientAuthMode {
    return getClientAuthMode(this.db);
  }

  authenticate(
    credential: string | null | undefined,
    source: ResolvedClientIdentity["source"] = "http_bearer",
    context?: ClientAuthRequestContext,
  ): ResolvedClientIdentity | null {
    const token = normalizeBearer(credential);
    if (!token) return null;

    // Ephemeral tokens (bootstrap / handshake / file-RPC capability) take
    // precedence: they are daemon-lifetime secrets minted by the daemon itself.
    const key = fingerprintForToken(this.pepper, token);
    const eph = this.ephemeral.get(key);
    if (eph) {
      const now = this.now();
      if (eph.expiresAt !== null && eph.expiresAt <= now) {
        const renewableDashboard = eph.purpose === "dashboard_handshake"
          && eph.renewUntil !== null
          && eph.renewUntil > now;
        if (!renewableDashboard) {
          this.ephemeral.delete(key);
          if (eph.purpose === "dashboard_handshake") {
            writeDashboardSession(null, this.secretsDir);
          }
          return null;
        }
        // An expired dashboard token is never a general bearer credential. It
        // is accepted only by the protected handshake during a bounded grace
        // window, allowing an open/suspended dashboard to rotate without a
        // daemon restart.
        if (context?.method !== "POST" || context.pathname !== "/api/client-auth/handshake") {
          return null;
        }
      }
      const currentUser = getUserById(this.db, eph.identity.user_id);
      if (!currentUser || currentUser.status !== "active") {
        this.ephemeral.delete(key);
        return null;
      }
      if (!this.agentSessionIdentityStillValid(eph)) {
        this.ephemeral.delete(key);
        return null;
      }
      const identity: ResolvedClientIdentity = {
        user_id: eph.identity.user_id,
        slug: eph.identity.slug,
        method: "ephemeral",
        credential_id: null,
        source,
        ephemeral_purpose: eph.purpose,
      };
      if (eph.purpose === "operator_bootstrap") {
        // The filesystem proof exists only for first enrollment and is
        // consumed on its first authenticated request. Long-lived dashboard
        // continuity persists only a fingerprint, never reusable raw bytes.
        this.ephemeral.delete(key);
        this.bootstrapRaw = null;
        writeBootstrapTokenFile(null, this.secretsDir);
      }
      return identity;
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
  issueEphemeralToken(
    identity: { user_id: string; slug: string },
    purpose: string,
    options: { ttlMs?: number | null } = {},
  ): string {
    this.evictExpired();
    let raw = "";
    let key = "";
    // Avoid the astronomically unlikely collision with an existing ephemeral key.
    do {
      raw = generateRawToken();
      key = fingerprintForToken(this.pepper, raw);
    } while (this.ephemeral.has(key));
    const createdAt = this.now();
    const ttlMs = options.ttlMs === undefined ? DEFAULT_EPHEMERAL_TTL_MS : options.ttlMs;
    this.ephemeral.set(key, {
      identity,
      purpose,
      createdAt,
      expiresAt: ttlMs === null ? null : createdAt + ttlMs,
      renewUntil: null,
    });
    this.enforceEphemeralLimit();
    return raw;
  }

  /** Revoke one daemon-lifetime capability without retaining its raw value. */
  revokeEphemeralToken(raw: string): void {
    this.ephemeral.delete(fingerprintForToken(this.pepper, raw));
  }

  /**
   * Ensure no managed agent process can coexist with a readable operator proof.
   *
   * This is unconditional (issue a9ede3c round 2): the original anti-theft
   * guarantee is that constructing any non-operator backend destroys the
   * bootstrap file, so a same-uid managed agent can never read or race it. The
   * enrollment-first protection does NOT live here — a per-caller guard would
   * leave the 0600 proof alive for the whole bootstrap lifetime while agent
   * backends run alongside it (the round-1 High finding). Instead, startup
   * retention avoids constructing non-operator backends at all while the
   * enrollment window is open; see SessionManager.init() and
   * isOperatorEnrollmentWindowActive() below.
   */
  revokeOperatorBootstrap(): void {
    if (this.bootstrapRaw) {
      this.ephemeral.delete(fingerprintForToken(this.pepper, this.bootstrapRaw));
    }
    this.bootstrapRaw = null;
    writeBootstrapTokenFile(null, this.secretsDir);
  }

  /**
   * True during the operator's first-enrollment window: an operator is
   * configured but holds zero active **api_token** credentials, so no bearer
   * can yet authenticate as the operator and the bootstrap proof is still the
   * only way in. Returns false when no operator exists (nothing to protect) or
   * the operator already holds an api_token.
   *
   * The type filter is load-bearing (issue a9ede3c round-2 Medium finding):
   * only api_token rows can authenticate a presented bearer. An operator whose
   * only credential is an ssh_key or yubikey_recipient still cannot log in, so
   * the window must stay open for them — counting any credential type would
   * re-arm bootstrap destruction while enrollment is still impossible.
   *
   * SessionManager.init() consults this to defer construction of retained
   * non-running non-operator backends (as DormantBackend) while it is true, so
   * revokeOperatorBootstrap() never runs for them before the human enrolls.
   */
  isOperatorEnrollmentWindowActive(): boolean {
    const operator = getOperator(this.db);
    if (!operator) return false;
    const row = this.db
      .prepare(
        "SELECT COUNT(*) AS n FROM user_credentials"
          + " WHERE user_id = ? AND status = 'active' AND type = 'api_token'",
      )
      .get(operator.id) as { n: number } | undefined;
    return (row?.n ?? 0) === 0;
  }

  /**
   * Rotate the operator dashboard session. The caller must already have passed
   * requireOperator; this method never upgrades an anonymous or unrelated user.
   * Exactly one session fingerprint is kept in a protected file so a strict
   * dashboard can authenticate and renew after a normal daemon restart without
   * persisting reusable bearer bytes.
   */
  issueDashboardToken(identity: { user_id: string; slug: string }): {
    token: string;
    expires_at: number;
  } {
    const previous = [...this.ephemeral.entries()]
      .filter(([, entry]) => entry.purpose === "dashboard_handshake");
    for (const [key] of previous) this.ephemeral.delete(key);
    const token = this.issueEphemeralToken(identity, "dashboard_handshake", {
      ttlMs: this.dashboardSessionTtlMs,
    });
    const entry = this.ephemeral.get(fingerprintForToken(this.pepper, token));
    if (!entry || entry.expiresAt === null) {
      throw new Error("Failed to create expiring dashboard session.");
    }
    entry.renewUntil = entry.expiresAt + this.dashboardSessionRenewalGraceMs;
    try {
      writeDashboardSession({
        token_fingerprint: fingerprintForToken(this.pepper, token),
        user_id: identity.user_id,
        slug: identity.slug,
        created_at: entry.createdAt,
        expires_at: entry.expiresAt,
        renew_until: entry.renewUntil,
      }, this.secretsDir);
    } catch (error) {
      this.ephemeral.delete(fingerprintForToken(this.pepper, token));
      for (const [key, previousEntry] of previous) {
        this.ephemeral.set(key, previousEntry);
      }
      throw error;
    }
    return { token, expires_at: entry.expiresAt };
  }

  /**
   * The operator's bootstrap token: a daemon-lifetime ephemeral token. Lazily
   * minted and reused. Returns null when no operator is configured yet.
   */
  bootstrapToken(): string | null {
    const operator = getOperator(this.db);
    if (!operator) return null;
    if ([...this.ephemeral.values()].some((entry) => entry.purpose === "dashboard_handshake")) {
      return null;
    }
    if (this.bootstrapRaw) {
      const key = fingerprintForToken(this.pepper, this.bootstrapRaw);
      const entry = this.ephemeral.get(key);
      if (
        entry
        && entry.identity.user_id === operator.id
        && (entry.expiresAt === null || entry.expiresAt > this.now())
      ) return this.bootstrapRaw;
    }
    this.bootstrapRaw = this.issueEphemeralToken(
      { user_id: operator.id, slug: operator.slug },
      "operator_bootstrap",
      { ttlMs: OPERATOR_BOOTSTRAP_TTL_MS },
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

  private restoreDashboardSession(): void {
    const session = readDashboardSession(this.secretsDir);
    if (!session) return;
    const operator = getOperator(this.db);
    if (
      session.renew_until <= this.now()
      || !operator
      || session.user_id !== operator.id
    ) {
      writeDashboardSession(null, this.secretsDir);
      return;
    }
    this.ephemeral.set(session.token_fingerprint, {
      identity: { user_id: session.user_id, slug: operator.slug },
      purpose: "dashboard_handshake",
      createdAt: session.created_at,
      expiresAt: session.expires_at,
      renewUntil: session.renew_until,
    });
  }

  private evictExpired(): void {
    const now = this.now();
    for (const [key, entry] of this.ephemeral) {
      if (
        entry.expiresAt !== null
        && entry.expiresAt <= now
        && (entry.purpose !== "dashboard_handshake"
          || entry.renewUntil === null
          || entry.renewUntil <= now)
      ) {
        this.ephemeral.delete(key);
        if (entry.purpose === "dashboard_handshake") {
          writeDashboardSession(null, this.secretsDir);
        }
      }
    }
  }

  private agentSessionIdentityStillValid(entry: EphemeralEntry): boolean {
    const prefix = "agent_session:";
    if (!entry.purpose.startsWith(prefix)) return true;
    const sessionId = entry.purpose.slice(prefix.length);
    const session = this.db.prepare(
      "SELECT command, is_operator FROM console_sessions WHERE id = ?",
    ).get(sessionId) as { command: string; is_operator: number } | undefined;
    if (!session) return false;
    if (session.is_operator === 1) {
      const canonical = this.db.prepare(
        "SELECT value FROM settings WHERE key = 'console_operator_session_id'",
      ).get() as { value: string } | undefined;
      const operator = getOperator(this.db);
      return canonical?.value === sessionId && operator?.id === entry.identity.user_id;
    }
    const matches = this.db.prepare(
      `SELECT DISTINCT u.id
         FROM user_bindings b
         JOIN users u ON u.id = b.user_id
        WHERE b.binding_type = 'app_name'
          AND b.status = 'active'
          AND u.status = 'active'
          AND lower(b.value) = lower(?)
        ORDER BY u.id`,
    ).all(session.command) as Array<{ id: string }>;
    return matches.length === 1 && matches[0].id === entry.identity.user_id;
  }

  private enforceEphemeralLimit(): void {
    if (this.ephemeral.size <= this.maxEphemeralTokens) return;
    const evictable = [...this.ephemeral.entries()]
      .filter(([, entry]) => entry.purpose !== "operator_bootstrap")
      .sort((a, b) => a[1].createdAt - b[1].createdAt);
    while (this.ephemeral.size > this.maxEphemeralTokens && evictable.length > 0) {
      const [key, entry] = evictable.shift()!;
      this.ephemeral.delete(key);
      if (entry.purpose === "dashboard_handshake") {
        writeDashboardSession(null, this.secretsDir);
      }
    }
  }
}
