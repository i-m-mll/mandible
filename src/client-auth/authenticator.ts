// The client-authentication gate wired into the HTTP/file-RPC boundary.
//
// Responsibilities:
//   - Resolve explicit bearer/capability tokens for CLI, file-RPC, and native
//     enrollment. Browser authority is the separate opaque-cookie session store.
//   - Report the mandatory strict mode.
//   - Count unattributed writes (the strict-mode readiness ratchet).
//   - Own the operator's bootstrap token: a daemon-lifetime ephemeral token
//     written to a 0600 file (never embedded in any HTTP response) so a same-user
//     CLI can authenticate and explicitly enroll the dashboard.
//
// This module performs AUTHENTICATION and identity attach only. Authorization
// (groups/permissions) and evidence persistence are separate umbrella children.

import type { Db } from "../db.js";
import fs from "node:fs";
import path from "node:path";
import type { InstanceInfo } from "../types.js";
import { PRODUCTION_EFFECTS } from "../security/effect-policy.js";
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
  loadOrCreateClientAuthAuthorityId,
  readLegacyDashboardSessions,
  retireLegacyDashboardSessions,
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
import {
  LocalSessionAuthority,
  type BrowserSession,
  type BrowserSessionRevocation,
  type InstanceRegistration,
  type IssuedBrowserSession,
  type LegacyConversion,
  type PairingTransaction,
  type PreviewTransfer,
} from "./session-authority.js";

interface EphemeralEntry {
  identity: { user_id: string; slug: string };
  purpose: string;
  createdAt: number;
  expiresAt: number | null;
}

/**
 * Purpose prefix for a wrap-time exchanged token (issue 0b989d1): a launched
 * agent's long-lived keychain PAT is swapped for a token bound to the
 * `sessions` row it is about to register, so a transcript leak exposes only a
 * credential that dies with that one session instead of a shared PAT whose
 * rotation hits every live agent.
 */
export const WRAP_SESSION_PURPOSE_PREFIX = "wrap_session:";

export function wrapSessionPurpose(sessionId: string): string {
  return `${WRAP_SESSION_PURPOSE_PREFIX}${sessionId}`;
}

export interface ClientAuthenticatorOptions {
  /** Override the filesystem secrets directory (tests). Defaults to config dir. */
  secretsDir?: string;
  /** TTL backstop for wrap-time session-scoped agent tokens (tests may shorten). */
  wrapSessionTtlMs?: number;
  /** Grace before an exchanged token must have a registered session row. */
  wrapSessionPreRegistrationGraceMs?: number;
  /** Independent cap for wrap-time session-scoped tokens. */
  maxWrapSessionTokens?: number;
  /** Hard cap for general daemon-lifetime ephemeral credentials. */
  maxEphemeralTokens?: number;
  /** Injectable clock for expiry tests. */
  now?: () => number;
  /** Exact daemon instance policy and epoch used for preview-only enrollment. */
  instance?: InstanceInfo;
  startupEpoch?: string;
  /** Explicit initialization is used only by install/setup and isolated tests. */
  initializeSessionAuthority?: boolean;
  sessionAuthorityDir?: string;
  contextVerificationKeyPem?: string;
}

const DEFAULT_WRAP_SESSION_TTL_MS = 24 * 60 * 60 * 1_000;
const DEFAULT_WRAP_SESSION_PRE_REGISTRATION_GRACE_MS = 10 * 60 * 1_000;
const DEFAULT_MAX_WRAP_SESSION_TOKENS = 64;
const DEFAULT_EPHEMERAL_TTL_MS = 15 * 60 * 1_000;
const OPERATOR_BOOTSTRAP_TTL_MS = 5 * 60 * 1_000;
const DEFAULT_MAX_EPHEMERAL_TOKENS = 256;

export class ClientAuthenticator implements ClientAuthGate {
  private readonly ephemeral = new Map<string, EphemeralEntry>();
  private readonly telemetry = new ClientAuthTelemetry();
  private readonly secretsDir: string;
  private readonly wrapSessionTtlMs: number;
  private readonly wrapSessionPreRegistrationGraceMs: number;
  private readonly maxWrapSessionTokens: number;
  private readonly maxEphemeralTokens: number;
  private readonly now: () => number;
  /** Pepper is loaded from the filesystem ONCE at construction (startup). */
  private readonly pepper: string;
  private readonly clientAuthAuthorityId: string;
  private readonly instance: InstanceInfo | null;
  private readonly sessionAuthority: LocalSessionAuthority | null;
  private readonly contextVerificationKeyPem: string | null;
  private readonly revocationListeners = new Set<(scope: BrowserSessionRevocation) => void>();
  private bootstrapRaw: string | null = null;

  constructor(
    private readonly db: Db,
    options: ClientAuthenticatorOptions = {},
  ) {
    this.secretsDir = options.secretsDir ?? defaultClientAuthDir();
    this.wrapSessionTtlMs = options.wrapSessionTtlMs ?? DEFAULT_WRAP_SESSION_TTL_MS;
    this.wrapSessionPreRegistrationGraceMs = options.wrapSessionPreRegistrationGraceMs
      ?? DEFAULT_WRAP_SESSION_PRE_REGISTRATION_GRACE_MS;
    this.maxWrapSessionTokens = Math.max(
      1,
      options.maxWrapSessionTokens ?? DEFAULT_MAX_WRAP_SESSION_TOKENS,
    );
    this.maxEphemeralTokens = Math.max(
      2,
      options.maxEphemeralTokens ?? DEFAULT_MAX_EPHEMERAL_TOKENS,
    );
    this.now = options.now ?? Date.now;
    this.instance = options.instance ?? null;
    this.pepper = loadOrCreatePepper(db, this.secretsDir);
    this.clientAuthAuthorityId = options.instance?.installation_id
      ?? loadOrCreateClientAuthAuthorityId(this.secretsDir);
    this.sessionAuthority = options.instance?.role === "preview"
      ? null
      : new LocalSessionAuthority(
          options.sessionAuthorityDir ?? (options.secretsDir
            ? path.join(this.secretsDir, "local-sessions")
            : path.join(path.dirname(this.secretsDir), "local-sessions")),
          options.instance?.installation_id ?? this.clientAuthAuthorityId,
          { initialize: options.initializeSessionAuthority ?? true, now: this.now },
        );
    this.contextVerificationKeyPem = options.contextVerificationKeyPem
      ?? (process.env.MANDIBLE_CONTEXT_VERIFICATION_KEY
        ? fs.readFileSync(process.env.MANDIBLE_CONTEXT_VERIFICATION_KEY, "utf8")
        : this.sessionAuthority?.verificationKeyPem() ?? null);
    if (this.sessionAuthority) {
      retireLegacyDashboardSessions(this.sessionAuthority.retiredLegacyFingerprints(), this.secretsDir);
    }
  }

  authorityId(): string {
    return this.clientAuthAuthorityId;
  }

  instanceId(): string {
    return this.instance?.instance_id ?? "production";
  }

  instanceRegistration(instanceId: string): InstanceRegistration | null {
    return this.sessionAuthority?.instance(instanceId) ?? null;
  }

  productionRegistration(): InstanceRegistration | null {
    return this.sessionAuthority?.instances().find((entry) => entry.role === "main") ?? null;
  }

  classifyFailure(credential: string | null | undefined): "expired" | "revoked" | "unknown" {
    void credential;
    return "unknown";
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

    // Ephemeral tokens (native enrollment / file-RPC capability) take
    // precedence: they are daemon-lifetime secrets minted by the daemon itself.
    const key = fingerprintForToken(this.pepper, token);
    const eph = this.ephemeral.get(key);
    if (eph) {
      if (
        eph.purpose === "operator_bootstrap"
        && (context?.method !== "POST" || context.pathname !== "/api/client-auth/native-enrollment")
      ) {
        return null;
      }
      const now = this.now();
      if (eph.expiresAt !== null && eph.expiresAt <= now) {
        this.ephemeral.delete(key);
        return null;
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
      if (!this.wrapSessionStillLive(eph)) {
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
        effect_ceiling: this.instance?.allowed_effects ?? PRODUCTION_EFFECTS,
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
        effect_ceiling: this.instance?.allowed_effects ?? PRODUCTION_EFFECTS,
      };
    }
    return null;
  }

  registerInstance(registration: InstanceRegistration): void {
    if (!this.sessionAuthority) throw new Error("Preview backends cannot mutate installation registrations.");
    this.sessionAuthority.registerInstance(registration);
  }

  issueBrowserSession(identity: ResolvedClientIdentity, audience: string): IssuedBrowserSession {
    if (!this.sessionAuthority) throw new Error("Browser sessions are issued by the installation authority only.");
    return this.sessionAuthority.issueSession(identity.user_id, identity.slug, audience, {
      method: identity.method,
      credential_id: identity.credential_id,
      authenticated_at: this.now(),
    });
  }

  authenticateLegacyBrowserSession(raw: string | null | undefined): ResolvedClientIdentity | null {
    const token = normalizeBearer(raw);
    if (!token || !this.sessionAuthority) return null;
    const fingerprint = fingerprintForToken(this.pepper, token);
    if (this.sessionAuthority.isLegacyFingerprintRetired(fingerprint)) return null;
    const legacy = readLegacyDashboardSessions(this.secretsDir).find(
      (row) => row.token_fingerprint === fingerprint && row.renew_until > this.now(),
    );
    if (!legacy) return null;
    const user = getUserById(this.db, legacy.user_id);
    if (!user || user.status !== "active" || user.slug !== legacy.slug) return null;
    return {
      user_id: user.id,
      slug: user.slug,
      method: "legacy_browser_session",
      credential_id: null,
      source: "legacy_browser_conversion",
      ephemeral_purpose: "legacy_dashboard_conversion",
      effect_ceiling: this.instance?.allowed_effects ?? PRODUCTION_EFFECTS,
      legacy_fingerprint: fingerprint,
      legacy_authenticated_at: legacy.created_at,
    };
  }

  authenticateBrowserSession(raw: string | null | undefined): ResolvedClientIdentity | null {
    const result = this.classifyBrowserSession(raw);
    return result.state === "active" ? result.identity : null;
  }

  authenticateBrowserSessionForAudience(
    raw: string | null | undefined,
    audience: string,
  ): ResolvedClientIdentity | null {
    const result = this.classifyBrowserSession(raw, audience);
    return result.state === "active" ? result.identity : null;
  }

  classifyBrowserSession(
    raw: string | null | undefined,
    audience = this.instance?.instance_id,
  ): { state: "active" | "missing" | "wrong_audience" | "expired" | "revoked"; identity: ResolvedClientIdentity | null } {
    if (!raw || !audience || !this.sessionAuthority) return { state: "missing", identity: null };
    const result = this.sessionAuthority.classify(raw, audience);
    if (result.state !== "active") return { state: result.state, identity: null };
    const user = getUserById(this.db, result.session.user_id);
    if (!user || user.status !== "active" || user.slug !== result.session.slug) {
      const scope = this.sessionAuthority.revokeUser(result.session.user_id);
      if (scope) this.emitRevocation(scope);
      return { state: "revoked", identity: null };
    }
    return { state: "active", identity: this.identityFromBrowserSession(result.session, "browser_cookie") };
  }

  async signPreviewContext(identity: ResolvedClientIdentity, previewInstanceId: string): Promise<string> {
    if (!this.sessionAuthority || !identity.session_family || !identity.audience) {
      throw new Error("A live browser session is required for preview authorization.");
    }
    return this.sessionAuthority.signPreviewContext({
      family_id: identity.session_family,
      root_family_id: identity.root_session_family ?? identity.session_family,
      user_id: identity.user_id,
      slug: identity.slug,
      audience: identity.audience,
      effect_ceiling: identity.effect_ceiling,
      csrf_token: identity.csrf_token ?? "",
      expires_at: this.now(),
      absolute_expires_at: this.now(),
      evidence: {
        method: identity.method,
        credential_id: identity.credential_id,
        authenticated_at: this.now(),
      },
    }, previewInstanceId);
  }

  async authenticateInternalContext(compact: string | null | undefined): Promise<ResolvedClientIdentity | null> {
    if (!compact || !this.instance || !this.contextVerificationKeyPem) return null;
    const session = await LocalSessionAuthority.verifyPreviewContext(
      compact,
      this.contextVerificationKeyPem,
      {
        instance_id: this.instance.instance_id,
        installation_id: this.instance.installation_id,
        role: this.instance.role === "preview" ? "preview" : "main",
        public_origin: this.instance.public_origin,
        backend_origin: "http://127.0.0.1:0",
        backend_generation: this.instance.backend_generation,
        effect_ceiling: this.instance.allowed_effects,
        writable_roots: this.instance.writable_roots,
      },
    );
    if (!session) return null;
    const user = getUserById(this.db, session.user_id);
    if (!user || user.status !== "active") return null;
    return this.identityFromBrowserSession(session, "installation_context");
  }

  validateBrowserCsrf(identity: ResolvedClientIdentity, csrf: string | null | undefined): boolean {
    if (!identity.session_family || !identity.csrf_token) return false;
    if (identity.source === "installation_context") return csrf === identity.csrf_token;
    return Boolean(this.sessionAuthority && csrf === identity.csrf_token);
  }

  beginPairing(audience: string, returnPath: string): PairingTransaction {
    if (!this.sessionAuthority) throw new Error("Pairing is owned by the installation authority.");
    return this.sessionAuthority.beginPairing(audience, returnPath);
  }

  beginPreviewTransfer(audience: string, returnPath: string): PreviewTransfer {
    if (!this.sessionAuthority) throw new Error("Preview transfers are owned by the installation authority.");
    return this.sessionAuthority.beginPreviewTransfer(audience, returnPath);
  }

  authorizePreviewTransfer(reference: string, identity: ResolvedClientIdentity): InstanceRegistration {
    if (!this.sessionAuthority || identity.source !== "browser_cookie" || !identity.session_family
        || !identity.root_session_family || !identity.audience) {
      throw new Error("A production browser session is required to authorize preview access.");
    }
    return this.sessionAuthority.authorizePreviewTransfer(reference, {
      family_id: identity.session_family,
      root_family_id: identity.root_session_family,
      user_id: identity.user_id,
      slug: identity.slug,
      audience: identity.audience,
      effect_ceiling: identity.effect_ceiling,
      csrf_token: identity.csrf_token ?? "",
      expires_at: this.now(),
      absolute_expires_at: this.now(),
      evidence: { method: identity.method, credential_id: identity.credential_id, authenticated_at: this.now() },
    });
  }

  completePreviewTransfer(reference: string, secret: string): IssuedBrowserSession | null {
    if (!this.sessionAuthority) throw new Error("Preview transfers are owned by the installation authority.");
    return this.sessionAuthority.completePreviewTransfer(reference, secret);
  }

  previewTransferReturnPath(reference: string): string | null {
    return this.sessionAuthority?.previewTransferReturnPath(reference) ?? null;
  }

  beginLegacyConversion(
    identity: ResolvedClientIdentity,
    rawLegacyToken: string,
    returnPath: string,
    browserState: Record<string, string>,
    legacyOrigin: string,
  ): LegacyConversion {
    if (!this.sessionAuthority || identity.source !== "legacy_browser_conversion"
        || !identity.legacy_fingerprint || identity.legacy_authenticated_at === undefined) {
      throw new Error("A verified legacy browser session is required for conversion.");
    }
    const targetAudience = this.legacyConversionTarget(legacyOrigin);
    return this.sessionAuthority.beginLegacyConversion({
      raw_legacy_token: rawLegacyToken,
      legacy_fingerprint: identity.legacy_fingerprint,
      user_id: identity.user_id,
      slug: identity.slug,
      target_audience: targetAudience,
      return_path: returnPath,
      browser_state: browserState,
      authenticated_at: identity.legacy_authenticated_at,
    });
  }

  private legacyConversionTarget(origin: string): string {
    const parsed = new URL(origin);
    if (parsed.protocol !== "http:" || !["127.0.0.1", "localhost"].includes(parsed.hostname)) {
      throw new Error("Legacy browser origin is not in the migration inventory.");
    }
    if (parsed.port === "19420") return this.instanceId();
    if (parsed.port === "19421") {
      const preview = this.sessionAuthority?.instances().find((entry) => {
        const publicUrl = new URL(entry.public_origin);
        return entry.role === "preview" && publicUrl.port === "19421";
      });
      if (preview) return preview.instance_id;
    }
    throw new Error("Legacy browser origin is not bound to a registered replacement instance.");
  }

  completeLegacyConversion(reference: string, secret: string): IssuedBrowserSession | null {
    if (!this.sessionAuthority) throw new Error("Legacy conversion is owned by the installation authority.");
    return this.sessionAuthority.completeLegacyConversion(reference, secret);
  }

  legacyConversionReturnPath(reference: string): string | null {
    return this.sessionAuthority?.legacyConversionReturnPath(reference) ?? null;
  }

  legacyConversionDetails(identity: ResolvedClientIdentity): {
    browser_state: Record<string, string>;
    return_path: string;
    finalized: boolean;
  } | null {
    if (!this.sessionAuthority || !identity.session_family || !identity.root_session_family
        || !identity.audience) return null;
    return this.sessionAuthority.legacyConversionDetails(this.browserSessionFromIdentity(identity));
  }

  finalizeLegacyConversion(identity: ResolvedClientIdentity): boolean {
    if (!this.sessionAuthority || !identity.session_family || !identity.root_session_family
        || !identity.audience) return false;
    const fingerprint = this.sessionAuthority.finalizeLegacyConversion(this.browserSessionFromIdentity(identity));
    if (!fingerprint) return false;
    retireLegacyDashboardSessions([fingerprint], this.secretsDir);
    return true;
  }

  approvePairing(reference: string, userId: string): void {
    if (!this.sessionAuthority) throw new Error("Pairing is owned by the installation authority.");
    this.sessionAuthority.approvePairing(reference, userId);
  }

  completePairing(reference: string, secret: string): IssuedBrowserSession | null {
    if (!this.sessionAuthority) throw new Error("Pairing is owned by the installation authority.");
    return this.sessionAuthority.completePairing(reference, secret, (userId) => {
      const user = getUserById(this.db, userId);
      return user?.status === "active" ? user.slug : null;
    });
  }

  revokeBrowserFamily(identity: ResolvedClientIdentity): boolean {
    const scope = this.sessionAuthority && identity.session_family
      ? this.sessionAuthority.revokeFamily(identity.session_family)
      : null;
    if (scope) this.emitRevocation(scope);
    return Boolean(scope);
  }

  revokeAllBrowserFamilies(identity: ResolvedClientIdentity): number {
    const scope = this.sessionAuthority?.revokeUser(identity.user_id) ?? null;
    if (scope) this.emitRevocation(scope);
    return scope?.family_ids.length ?? 0;
  }

  onBrowserSessionRevoked(listener: (scope: BrowserSessionRevocation) => void): () => void {
    this.revocationListeners.add(listener);
    return () => this.revocationListeners.delete(listener);
  }

  private emitRevocation(scope: BrowserSessionRevocation): void {
    for (const listener of this.revocationListeners) listener(scope);
  }

  browserSessionMetadata(identity: ResolvedClientIdentity): Record<string, unknown> | null {
    if (!identity.session_family || !identity.audience) return null;
    return {
      family_id: identity.session_family,
      audience: identity.audience,
      csrf_token: identity.csrf_token,
      effect_ceiling: identity.effect_ceiling,
    };
  }

  private identityFromBrowserSession(
    session: BrowserSession,
    source: ResolvedClientIdentity["source"],
  ): ResolvedClientIdentity {
    return {
      user_id: session.user_id,
      slug: session.slug,
      method: source === "installation_context" ? "installation_context" : "browser_session",
      credential_id: session.evidence.credential_id,
      source,
      effect_ceiling: session.effect_ceiling,
      session_family: session.family_id,
      root_session_family: session.root_family_id,
      audience: session.audience,
      csrf_token: session.csrf_token,
      auth_context_expires_at: source === "installation_context" ? session.expires_at : null,
    };
  }

  private browserSessionFromIdentity(identity: ResolvedClientIdentity): BrowserSession {
    return {
      family_id: identity.session_family!,
      root_family_id: identity.root_session_family!,
      user_id: identity.user_id,
      slug: identity.slug,
      audience: identity.audience!,
      effect_ceiling: identity.effect_ceiling,
      csrf_token: identity.csrf_token ?? "",
      expires_at: identity.auth_context_expires_at ?? this.now() + 1,
      absolute_expires_at: identity.auth_context_expires_at ?? this.now() + 1,
      evidence: { method: identity.method, credential_id: identity.credential_id, authenticated_at: this.now() },
    };
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
   * for native enrollment, the operator bootstrap-token file, and
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
    });
    if (purpose.startsWith(WRAP_SESSION_PURPOSE_PREFIX)) {
      this.enforceWrapSessionLimit();
    } else {
      this.enforceEphemeralLimit();
    }
    return raw;
  }

  /** Revoke one daemon-lifetime capability without retaining its raw value. */
  revokeEphemeralToken(raw: string): void {
    const key = fingerprintForToken(this.pepper, raw);
    this.ephemeral.delete(key);
  }

  /**
   * Mint a session-scoped ephemeral token for an already-authenticated agent
   * identity (issue 0b989d1). The caller has proved the identity with a durable
   * api_token; this narrows that identity to one `sessions` row so a leaked
   * transcript yields a credential that dies when the session ends. A short
   * grace covers registration immediately after exchange; the TTL is the
   * backstop for a registered session that never reports an end.
   *
   * The token lives in the in-memory ephemeral map, so a daemon restart also
   * invalidates it — deliberately tighter than the PAT it replaces, and safe
   * because wrap.sh falls back to the PAT when the exchange is unavailable.
   */
  issueSessionScopedToken(
    identity: { user_id: string; slug: string },
    sessionId: string,
    options: { ttlMs?: number } = {},
  ): { token: string; expires_at: number; purpose: string } {
    const purpose = wrapSessionPurpose(sessionId);
    const ttlMs = options.ttlMs ?? this.wrapSessionTtlMs;
    for (const [key, entry] of this.ephemeral) {
      if (entry.purpose === purpose) this.ephemeral.delete(key);
    }
    const token = this.issueEphemeralToken(identity, purpose, { ttlMs });
    const entry = this.ephemeral.get(fingerprintForToken(this.pepper, token));
    if (!entry || entry.expiresAt === null) {
      throw new Error("Failed to create an expiring session-scoped token.");
    }
    return { token, expires_at: entry.expiresAt, purpose };
  }

  /**
   * Drop every session-scoped token bound to one session. Called when the
   * session is marked ended so the credential stops working immediately rather
   * than at the next authenticate() liveness read. Returns the count revoked.
   */
  revokeSessionScopedTokens(sessionId: string): number {
    const purpose = wrapSessionPurpose(sessionId);
    let revoked = 0;
    for (const [key, entry] of this.ephemeral) {
      if (entry.purpose !== purpose) continue;
      this.ephemeral.delete(key);
      revoked += 1;
    }
    return revoked;
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
   * The operator's bootstrap token: a daemon-lifetime ephemeral token. Lazily
   * minted and reused. Returns null when no operator is configured yet.
   */
  bootstrapToken(): string | null {
    const operator = getOperator(this.db);
    if (!operator) return null;
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

  private evictExpired(): void {
    const now = this.now();
    for (const [key, entry] of this.ephemeral) {
      if (entry.expiresAt !== null && entry.expiresAt <= now) {
        this.ephemeral.delete(key);
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

  /**
   * Liveness gate for a wrap-time session-scoped token (issue 0b989d1). The
   * explicit revocation on PATCH /api/sessions/:id/end is the fast path; this
   * read is the one that also catches every other way a session stops being
   * active (reaper marking it `dead`, dashboard end, direct registry update),
   * and it survives a route that forgets to revoke.
   *
   * wrap.sh exchanges before it registers the session, so a missing row is
   * allowed only for a short pre-registration grace. A still-missing row after
   * that deadline is dead; once the row exists, its normal active/ended state
   * is authoritative.
   */
  private wrapSessionStillLive(entry: EphemeralEntry): boolean {
    if (!entry.purpose.startsWith(WRAP_SESSION_PURPOSE_PREFIX)) return true;
    const sessionId = entry.purpose.slice(WRAP_SESSION_PURPOSE_PREFIX.length);
    const row = this.db
      .prepare("SELECT status, ended_at FROM sessions WHERE id = ?")
      .get(sessionId) as { status: string; ended_at: string | null } | undefined;
    if (!row) {
      return this.now() < entry.createdAt + this.wrapSessionPreRegistrationGraceMs;
    }
    return row.status === "active" && row.ended_at === null;
  }

  private enforceWrapSessionLimit(): void {
    // Map iteration is insertion order. Same-session replacement deletes the
    // previous entry before inserting its successor, so the first wrap entry is
    // always the oldest even when multiple tokens share the same millisecond.
    const entries = [...this.ephemeral.entries()]
      .filter(([, entry]) => entry.purpose.startsWith(WRAP_SESSION_PURPOSE_PREFIX));
    while (entries.length > this.maxWrapSessionTokens) {
      const [key] = entries.shift()!;
      this.ephemeral.delete(key);
    }
  }

  private enforceEphemeralLimit(): void {
    let retained = [...this.ephemeral.values()]
      .filter((entry) => (
        !entry.purpose.startsWith(WRAP_SESSION_PURPOSE_PREFIX)
      ))
      .length;
    if (retained <= this.maxEphemeralTokens) return;
    const evictable = [...this.ephemeral.entries()]
      .filter(([, entry]) => (
        entry.purpose !== "operator_bootstrap"
        && !entry.purpose.startsWith(WRAP_SESSION_PURPOSE_PREFIX)
      ))
      .sort((a, b) => a[1].createdAt - b[1].createdAt);
    while (retained > this.maxEphemeralTokens && evictable.length > 0) {
      const [key] = evictable.shift()!;
      this.ephemeral.delete(key);
      retained -= 1;
    }
  }

}
