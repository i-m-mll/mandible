// Installation-scoped registration and short signed context for a preview's
// request. Human access itself belongs to the local OS account and has no
// session database, expiry, renewal, or enrollment ceremony.
import { generateKeyPairSync, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import SqliteDatabase from "../sqlite.js";
import { SignJWT, importPKCS8, importSPKI, jwtVerify } from "jose";
import type { Effect } from "../security/effect-policy.js";

const INTERNAL_CONTEXT_TTL_SECONDS = 5;

export type InstanceRegistration = {
  instance_id: string;
  installation_id: string;
  role: "main" | "preview";
  public_origin: string;
  backend_origin: string;
  backend_generation: string;
  effect_ceiling: readonly Effect[];
  writable_roots: readonly string[];
};

export type PreviewContext = {
  user_id: string;
  slug: string;
  audience: string;
  effect_ceiling: readonly Effect[];
  csrf_token: string;
  evidence: { authenticated_at: number };
};

export class LocalSessionAuthority {
  private readonly db: SqliteDatabase;
  private readonly now: () => number;
  private readonly privateKeyPath: string;
  private readonly publicKeyPath: string;

  constructor(
    directory: string,
    readonly installationId: string,
    options: { now?: () => number; initialize?: boolean } = {},
  ) {
    this.now = options.now ?? Date.now;
    if (!fs.existsSync(directory) && !options.initialize) {
      throw new Error(`Installation authority is not initialized: ${directory}`);
    }
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    fs.chmodSync(directory, 0o700);
    const databasePath = path.join(directory, "sessions.db");
    if (!fs.existsSync(databasePath) && !options.initialize) {
      throw new Error(`Installation authority database is missing: ${databasePath}`);
    }
    this.db = new SqliteDatabase(databasePath);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS authority_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS instance_registrations (
        instance_id TEXT PRIMARY KEY,
        installation_id TEXT NOT NULL,
        role TEXT NOT NULL CHECK(role IN ('main', 'preview')),
        public_origin TEXT NOT NULL UNIQUE,
        backend_origin TEXT NOT NULL,
        backend_generation TEXT NOT NULL,
        effect_ceiling_json TEXT NOT NULL,
        writable_roots_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);
    const existing = this.db.prepare("SELECT value FROM authority_meta WHERE key = 'installation_id'")
      .get() as { value: string } | undefined;
    if (existing && existing.value !== installationId) {
      throw new Error("Installation authority belongs to another installation.");
    }
    if (!existing) this.db.prepare("INSERT INTO authority_meta (key, value) VALUES ('installation_id', ?)").run(installationId);
    this.privateKeyPath = path.join(directory, "context-signing-key.pem");
    this.publicKeyPath = path.join(directory, "context-verification-key.pem");
    if (options.initialize) this.ensureSigningKeys();
    if (!fs.existsSync(this.publicKeyPath)) throw new Error("Preview context verification key is missing.");
  }

  close(): void { this.db.close(); }
  verificationKeyPem(): string { return fs.readFileSync(this.publicKeyPath, "utf8"); }

  registerInstance(registration: InstanceRegistration): void {
    validateRegistration(registration, this.installationId);
    const previous = this.instance(registration.instance_id);
    if (previous && (previous.installation_id !== registration.installation_id
        || previous.role !== registration.role || previous.public_origin !== registration.public_origin)) {
      throw new Error(`Conflicting registration for instance ${registration.instance_id}.`);
    }
    this.db.prepare(`INSERT INTO instance_registrations (
      instance_id, installation_id, role, public_origin, backend_origin,
      backend_generation, effect_ceiling_json, writable_roots_json, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(instance_id) DO UPDATE SET
      backend_origin = excluded.backend_origin,
      backend_generation = excluded.backend_generation,
      effect_ceiling_json = excluded.effect_ceiling_json,
      writable_roots_json = excluded.writable_roots_json,
      updated_at = excluded.updated_at`).run(
      registration.instance_id, registration.installation_id, registration.role,
      registration.public_origin, registration.backend_origin, registration.backend_generation,
      JSON.stringify(registration.effect_ceiling), JSON.stringify(registration.writable_roots),
      this.now(),
    );
  }

  instance(instanceId: string): InstanceRegistration | null {
    const row = this.db.prepare("SELECT * FROM instance_registrations WHERE instance_id = ?")
      .get(instanceId) as Record<string, unknown> | undefined;
    return row ? registrationFromRow(row) : null;
  }
  instances(): InstanceRegistration[] {
    return (this.db.prepare("SELECT * FROM instance_registrations ORDER BY role, instance_id")
      .all() as Record<string, unknown>[]).map(registrationFromRow);
  }

  async signPreviewContext(context: PreviewContext, previewInstanceId: string): Promise<string> {
    const preview = this.instance(previewInstanceId);
    if (!preview || preview.role !== "preview" || !fs.existsSync(this.privateKeyPath)) {
      throw new Error("Preview context signing is unavailable.");
    }
    const key = await importPKCS8(fs.readFileSync(this.privateKeyPath, "utf8"), "EdDSA");
    const effects = preview.effect_ceiling.filter((effect) => context.effect_ceiling.includes(effect));
    return new SignJWT({
      uid: context.user_id,
      slug: context.slug, effects, csrf: context.csrf_token,
      generation: preview.backend_generation, auth_time: context.evidence.authenticated_at,
    })
      .setProtectedHeader({ alg: "EdDSA", typ: "JWT" })
      .setIssuer(this.installationId).setAudience(preview.instance_id)
      .setJti(randomBytes(16).toString("base64url"))
      .setIssuedAt().setExpirationTime(`${INTERNAL_CONTEXT_TTL_SECONDS}s`).sign(key);
  }

  static async verifyPreviewContext(
    compact: string, verificationKeyPem: string, registration: InstanceRegistration,
  ): Promise<PreviewContext | null> {
    try {
      const key = await importSPKI(verificationKeyPem, "EdDSA");
      const { payload } = await jwtVerify(compact, key, {
        issuer: registration.installation_id, audience: registration.instance_id,
        algorithms: ["EdDSA"], maxTokenAge: `${INTERNAL_CONTEXT_TTL_SECONDS}s`,
      });
      if (typeof payload.uid !== "string" || typeof payload.slug !== "string"
          || typeof payload.csrf !== "string" || payload.generation !== registration.backend_generation
          || !Array.isArray(payload.effects)
          || payload.effects.some((effect) => !registration.effect_ceiling.includes(effect as Effect))) return null;
      return {
        user_id: payload.uid, slug: payload.slug, audience: registration.instance_id,
        effect_ceiling: payload.effects as Effect[], csrf_token: payload.csrf,
        evidence: { authenticated_at: Number(payload.auth_time) },
      };
    } catch { return null; }
  }

  private ensureSigningKeys(): void {
    if (fs.existsSync(this.privateKeyPath) && fs.existsSync(this.publicKeyPath)) return;
    if (fs.existsSync(this.privateKeyPath) || fs.existsSync(this.publicKeyPath)) {
      throw new Error("Preview signing key state is incomplete.");
    }
    const pair = generateKeyPairSync("ed25519");
    writeProtected(this.privateKeyPath, pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString());
    writeProtected(this.publicKeyPath, pair.publicKey.export({ type: "spki", format: "pem" }).toString());
  }
}

function writeProtected(filePath: string, contents: string): void {
  fs.writeFileSync(filePath, contents, { mode: 0o600, flag: "wx" });
  fs.chmodSync(filePath, 0o600);
}
function registrationFromRow(row: Record<string, unknown>): InstanceRegistration {
  return {
    instance_id: String(row.instance_id), installation_id: String(row.installation_id),
    role: row.role === "preview" ? "preview" : "main", public_origin: String(row.public_origin),
    backend_origin: String(row.backend_origin), backend_generation: String(row.backend_generation),
    effect_ceiling: JSON.parse(String(row.effect_ceiling_json)) as Effect[],
    writable_roots: JSON.parse(String(row.writable_roots_json)) as string[],
  };
}
function validateRegistration(registration: InstanceRegistration, installationId: string): void {
  if (registration.installation_id !== installationId) throw new Error("Registration installation mismatch.");
  const publicOrigin = new URL(registration.public_origin);
  const backendOrigin = new URL(registration.backend_origin);
  for (const [raw, origin] of [[registration.public_origin, publicOrigin], [registration.backend_origin, backendOrigin]] as const) {
    if (origin.username || origin.password || !origin.port || origin.pathname !== "/" || origin.search || origin.hash) {
      throw new Error(`Invalid instance origin: ${raw}`);
    }
  }
  if (publicOrigin.protocol !== "https:" || !publicOrigin.hostname.toLowerCase().endsWith(".mandible.localhost")) {
    throw new Error("Instance public origin must be an exact Mandible HTTPS hostname.");
  }
  if (backendOrigin.protocol !== "http:" || !new Set(["127.0.0.1", "::1", "[::1]"]).has(backendOrigin.hostname.toLowerCase())) {
    throw new Error("Instance backend origin must be loopback HTTP.");
  }
  if (new Set(registration.effect_ceiling).size !== registration.effect_ceiling.length) {
    throw new Error("Instance effect ceiling contains duplicates.");
  }
  if (registration.writable_roots.some((root) => !path.isAbsolute(root))) {
    throw new Error("Instance writable roots must be absolute.");
  }
}
