// Resolve intrinsic local browser identity and explicit agent credentials.

import type { Db } from "../db.js";
import { resolveManagedRequestOrigin, type ManagedRequestOrigin } from "../request-origin.js";
import fs from "node:fs";
import path from "node:path";
import { createHmac } from "node:crypto";
import type { InstanceInfo } from "../types.js";
import { PRODUCTION_EFFECTS } from "../security/effect-policy.js";
import { getOperator, getOperatorId, getUserById } from "../users/store.js";
import { resolveProviderSessionAttributionResult, resolveSessionAttributionResult, resolveSessionIdAttributionResult } from "../identity/resolver.js";
import type { AmbientProviderIdentity } from "../ambient-provider-identity.js";
import type {
  ClientAuthRequestContext,
  ClientAuthGate,
  ClientAuthMode,
  LocalManagedIdentity,
  ResolvedClientIdentity,
} from "../server.js";
import { getClientAuthMode } from "./mode.js";
import {
  defaultClientAuthDir,
  loadOrCreatePepper,
  loadOrCreateClientAuthAuthorityId,
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
  resolvedApiTokenIdentity,
  type MintedToken,
} from "./tokens.js";
import {
  LocalSessionAuthority,
  type InstanceRegistration,
} from "./session-authority.js";

interface EphemeralEntry {
  identity: { user_id: string; slug: string };
  purpose: string;
  createdAt: number;
  expiresAt: number | null;
}

export interface ClientAuthenticatorOptions {
  /** Override the filesystem secrets directory (tests). Defaults to config dir. */
  secretsDir?: string;
  /** Hard cap for general daemon-lifetime ephemeral credentials. */
  maxEphemeralTokens?: number;
  /** Injectable clock for expiry tests. */
  now?: () => number;
  /** Exact daemon instance policy used for preview signing. */
  instance?: InstanceInfo;
  startupEpoch?: string;
  /** Explicit initialization is used only by install/setup and isolated tests. */
  initializeSessionAuthority?: boolean;
  sessionAuthorityDir?: string;
  contextVerificationKeyPem?: string;
}

const DEFAULT_EPHEMERAL_TTL_MS = 15 * 60 * 1_000;
const DEFAULT_MAX_EPHEMERAL_TOKENS = 256;

export class ClientAuthenticator implements ClientAuthGate {
  private readonly ephemeral = new Map<string, EphemeralEntry>();
  private readonly telemetry = new ClientAuthTelemetry();
  private readonly secretsDir: string;
  private readonly maxEphemeralTokens: number;
  private readonly now: () => number;
  /** Pepper is loaded from the filesystem ONCE at construction (startup). */
  private readonly pepper: string;
  private readonly clientAuthAuthorityId: string;
  private readonly instance: InstanceInfo | null;
  private readonly sessionAuthority: LocalSessionAuthority;
  private readonly ownsSessionAuthority: boolean;
  private readonly contextVerificationKeyPem: string | null;

  constructor(
    private readonly db: Db,
    options: ClientAuthenticatorOptions = {},
  ) {
    this.secretsDir = options.secretsDir ?? defaultClientAuthDir();
    this.maxEphemeralTokens = Math.max(
      2,
      options.maxEphemeralTokens ?? DEFAULT_MAX_EPHEMERAL_TOKENS,
    );
    this.now = options.now ?? Date.now;
    this.instance = options.instance ?? null;
    this.pepper = loadOrCreatePepper(db, this.secretsDir);
    this.clientAuthAuthorityId = options.instance?.installation_id
      ?? loadOrCreateClientAuthAuthorityId(this.secretsDir);
    this.ownsSessionAuthority = options.instance?.role !== "preview";
    this.sessionAuthority = new LocalSessionAuthority(
      options.sessionAuthorityDir ?? (options.secretsDir
        ? path.join(this.secretsDir, "local-sessions")
        : path.join(path.dirname(this.secretsDir), "local-sessions")),
      options.instance?.installation_id ?? this.clientAuthAuthorityId,
      {
        initialize: options.initializeSessionAuthority ?? this.ownsSessionAuthority,
        now: this.now,
      },
    );
    this.contextVerificationKeyPem = options.contextVerificationKeyPem
      ?? (process.env.MANDIBLE_CONTEXT_VERIFICATION_KEY
        ? fs.readFileSync(process.env.MANDIBLE_CONTEXT_VERIFICATION_KEY, "utf8")
        : this.sessionAuthority.verificationKeyPem());
  }

  authorityId(): string {
    return this.clientAuthAuthorityId;
  }

  credentialDirectory(): string {
    return this.secretsDir;
  }

  instanceId(): string {
    return this.instance?.instance_id ?? "production";
  }

  /** The registered production origin belongs to the logged-in OS account.
   * No browser credential, family, expiry, or enrollment is involved. Preview
   * ingress instead receives a short-lived, instance-scoped signed context.
   */
  localBrowserIdentity(): ResolvedClientIdentity | null {
    if (this.instance?.role === "preview") return null;
    const operator = getOperator(this.db);
    if (!operator || operator.status !== "active" || operator.kind !== "human") return null;
    const audience = this.instanceId();
    return {
      user_id: operator.id,
      slug: operator.slug,
      method: "local_os_user",
      credential_id: null,
      source: "local_os_user",
      effect_ceiling: this.instance?.allowed_effects ?? PRODUCTION_EFFECTS,
      audience,
      csrf_token: createHmac("sha256", this.pepper)
        .update(`mandible:local-csrf:${this.clientAuthAuthorityId}:${audience}`)
        .digest("base64url"),
    };
  }

  resolveManagedOrigin(identity: LocalManagedIdentity): ManagedRequestOrigin {
    return resolveManagedRequestOrigin(this.db, identity);
  }

  localSocketIdentity(
    ambient: AmbientProviderIdentity | null,
    managed: boolean,
    localManaged: LocalManagedIdentity | null = null,
  ): ResolvedClientIdentity | null {
    let userId: string | null = null;
    if (ambient) {
      const provider = resolveProviderSessionAttributionResult(this.db, ambient.provider);
      const session = resolveSessionIdAttributionResult(this.db, ambient.provider_session_id);
      if (provider.status !== "resolved" || session.status === "conflict"
          || (session.status === "resolved" && session.attribution.user_id !== provider.attribution.user_id)) return null;
      userId = provider.attribution.user_id;
    }
    if (localManaged) {
      const registered = this.db.prepare("SELECT app, owner_user_id FROM sessions WHERE id = ?")
        .get(localManaged.session_id) as { app: string; owner_user_id: string | null } | undefined;
      if (registered && registered.app !== localManaged.app_name) return null;
      const alias = resolveSessionAttributionResult(this.db, {
        app_name: localManaged.app_name,
        provider_session_env: localManaged.session_id,
      });
      if (alias.status !== "resolved") return null;
      if (registered?.owner_user_id && registered.owner_user_id !== alias.attribution.user_id) return null;
      if (userId && userId !== alias.attribution.user_id) return null;
      userId = alias.attribution.user_id;
    }
    if (userId) {
      const user = getUserById(this.db, userId);
      if (!user || user.status !== "active" || user.kind !== "agent") return null;
      return {
        user_id: user.id,
        slug: user.slug,
        method: "local_socket",
        credential_id: null,
        source: "local_socket",
        effect_ceiling: this.instance?.allowed_effects ?? PRODUCTION_EFFECTS,
      };
    }
    if (managed) return null;
    const operator = getOperator(this.db);
    if (!operator || operator.status !== "active" || operator.kind !== "human") return null;
    return {
      user_id: operator.id,
      slug: operator.slug,
      method: "local_socket",
      credential_id: null,
      source: "local_socket",
      effect_ceiling: this.instance?.allowed_effects ?? PRODUCTION_EFFECTS,
    };
  }

  localSocketBootstrapAllowed(): boolean {
    return this.instance?.role === "main" && getOperatorId(this.db) === null;
  }

  instanceRegistration(instanceId: string): InstanceRegistration | null {
    return this.sessionAuthority.instance(instanceId);
  }

  productionRegistration(): InstanceRegistration | null {
    return this.sessionAuthority.instances().find((entry) => entry.role === "main") ?? null;
  }

  mode(): ClientAuthMode {
    return getClientAuthMode(this.db);
  }

  authenticate(
    credential: string | null | undefined,
    source: ResolvedClientIdentity["source"] = "http_bearer",
    context?: ClientAuthRequestContext,
  ): ResolvedClientIdentity | null {
    void context;
    const token = normalizeBearer(credential);
    if (!token) return null;

    // Ephemeral agent and file-RPC capability tokens take
    // precedence: they are daemon-lifetime secrets minted by the daemon itself.
    const key = fingerprintForToken(this.pepper, token);
    const eph = this.ephemeral.get(key);
    if (eph) {
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
      const identity: ResolvedClientIdentity = {
        user_id: eph.identity.user_id,
        slug: eph.identity.slug,
        method: "ephemeral",
        credential_id: null,
        source,
        ephemeral_purpose: eph.purpose,
        effect_ceiling: this.instance?.allowed_effects ?? PRODUCTION_EFFECTS,
      };
      return identity;
    }

    const verified = verifyApiToken(this.db, this.pepper, token);
    if (verified) {
      return resolvedApiTokenIdentity(verified, source, this.instance?.allowed_effects ?? PRODUCTION_EFFECTS);
    }
    return null;
  }

  registerInstance(registration: InstanceRegistration): void {
    if (!this.ownsSessionAuthority) throw new Error("Preview backends cannot mutate installation registrations.");
    this.sessionAuthority.registerInstance(registration);
  }

  async signPreviewContext(identity: ResolvedClientIdentity, previewInstanceId: string): Promise<string> {
    if (!this.ownsSessionAuthority || identity.source !== "local_os_user"
        || !identity.audience || !identity.csrf_token) {
      throw new Error("Local OS-user access is required for preview authorization.");
    }
    return this.sessionAuthority.signPreviewContext({
      user_id: identity.user_id,
      slug: identity.slug,
      audience: identity.audience,
      effect_ceiling: identity.effect_ceiling,
      csrf_token: identity.csrf_token,
      evidence: { authenticated_at: this.now() },
    }, previewInstanceId);
  }

  async authenticateInternalContext(compact: string | null | undefined): Promise<ResolvedClientIdentity | null> {
    if (!compact || !this.instance || !this.contextVerificationKeyPem) return null;
    const context = await LocalSessionAuthority.verifyPreviewContext(
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
    if (!context) return null;
    const user = getUserById(this.db, context.user_id);
    if (!user || user.status !== "active" || user.slug !== context.slug) return null;
    return {
      user_id: user.id,
      slug: user.slug,
      method: "installation_context",
      credential_id: null,
      source: "installation_context",
      effect_ceiling: context.effect_ceiling,
      audience: context.audience,
      csrf_token: context.csrf_token,
    };
  }

  validateBrowserCsrf(identity: ResolvedClientIdentity, csrf: string | null | undefined): boolean {
    return Boolean(identity.csrf_token && csrf === identity.csrf_token);
  }

  localAccessMetadata(identity: ResolvedClientIdentity): Record<string, unknown> | null {
    if ((identity.source !== "local_os_user" && identity.source !== "installation_context")
        || !identity.audience) return null;
    return {
      audience: identity.audience,
      csrf_token: identity.csrf_token,
      effect_ceiling: identity.effect_ceiling,
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
   * Register a daemon-lifetime ephemeral token bound to a user identity. Used for per-agent file-RPC capability tokens. Returns the raw token (shown once).
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
    this.enforceEphemeralLimit();
    return raw;
  }

  /** Revoke one daemon-lifetime capability without retaining its raw value. */
  revokeEphemeralToken(raw: string): void {
    const key = fingerprintForToken(this.pepper, raw);
    this.ephemeral.delete(key);
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

  private enforceEphemeralLimit(): void {
    let retained = this.ephemeral.size;
    if (retained <= this.maxEphemeralTokens) return;
    const evictable = [...this.ephemeral.entries()]
      .sort((a, b) => a[1].createdAt - b[1].createdAt);
    while (retained > this.maxEphemeralTokens && evictable.length > 0) {
      const [key] = evictable.shift()!;
      this.ephemeral.delete(key);
      retained -= 1;
    }
  }

}
