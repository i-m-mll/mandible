import * as readline from "node:readline";
import { openLogicalSource, canonicalSourcePath, discoverLogicalSources, readLogicalSourcePrefix } from "./logical-source.js";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { getMandibleHomePath } from "../platform-paths.js";
import { canonicalJson } from "../canonical-json.js";
import type {
  CustodyCaptureOptions,
  CustodyCaptureResult,
  CustodyDependency,
  CustodyFileRecord,
  CustodyManifest,
  CustodySource,
  CustodyState,
  CustodyStatusRecord,
  IntegrityResult,
  ProviderRestoreClaim,
} from "./custody-types.js";

const ARCHIVE_FORMAT = "mandible-conversation-custody@1" as const;
const ADAPTER_VERSION = "1";

export class CustodyError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

function sha256(data: Buffer | string): string {
  return crypto.createHash("sha256").update(data).digest("hex");
}

/**
 * Stable path order for custody identities and checksum manifests.
 *
 * `localeCompare` reads the host's default collation, so the same file set can
 * order differently on two machines — and the order feeds `versionDigest`,
 * which names the archive's immutable on-disk directory. A custody version is a
 * content identity, so its input order must be a function of the paths alone.
 *
 * This is not only a non-ASCII concern. Collation folds case, so `toolu_01Qo…`
 * sorts before `toolu_01QS…` under en-CA while code units put the uppercase
 * `S` first. Provider tool-result filenames differ in exactly that way, so
 * ASCII-only archives diverge too.
 */
function comparePathCodeUnits(
  left: { path: string },
  right: { path: string },
): number {
  return left.path < right.path ? -1 : left.path > right.path ? 1 : 0;
}

function versionDigest(files: CustodyFileRecord[]): string {
  return sha256(canonicalJson(files.map(({ path: archivePath, size, sha256: digest }) => ({ path: archivePath, size, sha256: digest }))));
}

function custodyVersionDigest(
  sourceVersion: string,
  sourceVersionId?: string,
  sourceSha256?: string,
): string {
  if (!sourceVersionId && !sourceSha256) return sourceVersion;
  return sha256(canonicalJson({ source_version: sourceVersion, source_version_id: sourceVersionId, source_sha256: sourceSha256 }));
}

function assertSafeComponent(value: string, label: string): void {
  if (!value || value === "." || value === ".." || value.includes("/") || value.includes("\\") || value.includes("\0")) {
    throw new CustodyError(`${label} is not a safe path component`, "unsafe_path");
  }
}

function assertRelative(value: string, label: string): string {
  const normalized = value.replace(/\\/g, "/");
  if (!normalized || path.posix.isAbsolute(normalized) || normalized.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new CustodyError(`${label} must be a root-relative path without traversal`, "unsafe_path");
  }
  return normalized;
}

function within(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== "..");
}

function assertWithinProviderRoot(root: string, candidate: string): void {
  const lexicalRoot = path.resolve(root);
  const lexicalCandidate = path.resolve(candidate);
  if (!within(lexicalRoot, lexicalCandidate)) {
    throw new CustodyError(`provider dependency escaped its root: ${candidate}`, "unsafe_path");
  }
  const realRoot = fs.realpathSync(lexicalRoot);
  const realCandidate = fs.realpathSync(lexicalCandidate);
  if (!within(realRoot, realCandidate)) {
    throw new CustodyError(`provider dependency escaped through a symlink: ${candidate}`, "symlink_rejected");
  }
}

function ensureDir(directory: string, mode = 0o700): void {
  fs.mkdirSync(directory, { recursive: true, mode });
  fs.chmodSync(directory, mode);
}

function atomicJson(filePath: string, value: unknown): void {
  ensureDir(path.dirname(filePath));
  const temporary = `${filePath}.tmp-${process.pid}-${crypto.randomUUID()}`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  fs.renameSync(temporary, filePath);
  fs.chmodSync(filePath, 0o600);
}

function listRegularFiles(root: string): string[] {
  if (!fs.existsSync(root)) return [];
  const result: string[] = [];
  const visit = (directory: string) => {
    const stat = fs.lstatSync(directory);
    if (stat.isSymbolicLink()) throw new CustodyError(`symlink dependency rejected: ${directory}`, "symlink_rejected");
    if (!stat.isDirectory()) throw new CustodyError(`dependency root is not a directory: ${directory}`, "non_regular_source");
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const candidate = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new CustodyError(`symlink dependency rejected: ${candidate}`, "symlink_rejected");
      if (entry.isDirectory()) visit(candidate);
      else if (entry.isFile()) result.push(candidate);
      else throw new CustodyError(`non-regular dependency rejected: ${candidate}`, "non_regular_source");
    }
  };
  visit(root);
  return result.sort();
}

function readStableFile(sourcePath: string, afterRead?: (sourcePath: string) => void): { data: Buffer; stat: fs.Stats } {
  const before = fs.lstatSync(sourcePath);
  if (before.isSymbolicLink()) throw new CustodyError(`symlink source rejected: ${sourcePath}`, "symlink_rejected");
  if (!before.isFile()) throw new CustodyError(`non-regular source rejected: ${sourcePath}`, "non_regular_source");
  const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0);
  const descriptor = fs.openSync(sourcePath, flags);
  try {
    const opened = fs.fstatSync(descriptor);
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino) {
      throw new CustodyError(`source changed while opening: ${sourcePath}`, "source_changed", 409);
    }
    const data = fs.readFileSync(descriptor);
    afterRead?.(sourcePath);
    const after = fs.fstatSync(descriptor);
    const current = fs.lstatSync(sourcePath);
    if (after.size !== data.length || before.size !== after.size || before.mtimeMs !== current.mtimeMs || before.dev !== current.dev || before.ino !== current.ino) {
      throw new CustodyError(`source changed during capture: ${sourcePath}`, "source_changed", 409);
    }
    return { data, stat: after };
  } finally {
    fs.closeSync(descriptor);
  }
}

async function streamStableFile(sourcePath: string, destination?: string, rootPath?: string, afterRead?: (sourcePath: string) => void): Promise<{ size: number; sha256: string }> {
  const handle = await openLogicalSource(sourcePath, { rootPath });
  let output: fs.promises.FileHandle | undefined;
  try {
    const before = await handle.stat({ bigint: true });
    if (destination) output = await fs.promises.open(destination, "wx", 0o600);
    const hash = crypto.createHash("sha256");
    let size = 0;
    for await (const chunk of handle.createReadStream({ autoClose: false })) {
      const bytes = chunk as Buffer;
      size += bytes.length;
      hash.update(bytes);
      if (output) await output.write(bytes);
    }
    afterRead?.(sourcePath);
    const after = await handle.stat({ bigint: true });
    if (BigInt(size) !== before.size || before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) {
      throw new CustodyError(`source changed during capture: ${sourcePath}`, "source_changed", 409);
    }
    if (output) await output.sync();
    return { size, sha256: hash.digest("hex") };
  } finally { await output?.close(); await handle.close(); }
}

function filteredJsonLines(filePath: string, sessionIds: Set<string>): Buffer | null {
  if (!fs.existsSync(filePath)) return null;
  const { data } = readStableFile(filePath);
  const lines = data.toString("utf8").split(/\r?\n/).filter(Boolean);
  const selected = lines.filter((line) => {
    try {
      const value = JSON.parse(line) as Record<string, unknown>;
      const id = typeof value.id === "string" ? value.id : typeof value.session_id === "string" ? value.session_id : "";
      return sessionIds.has(id);
    } catch {
      return false;
    }
  });
  return selected.length ? Buffer.from(`${selected.join("\n")}\n`) : null;
}

function claudeDependencies(source: CustodySource, options: CustodyCaptureOptions) {
  const sourcePath = path.resolve(source.source_path);
  const projectsMarker = `${path.sep}.claude${path.sep}projects${path.sep}`;
  const marker = sourcePath.indexOf(projectsMarker);
  if (marker < 0) throw new CustodyError("Claude source is outside a .claude/projects root", "unsupported_source");
  const claudeRoot = sourcePath.slice(0, marker + `${path.sep}.claude`.length);
  const projectDir = path.dirname(sourcePath);
  const relativeMain = path.relative(claudeRoot, sourcePath);
  const dependencies: CustodyDependency[] = [{
    source_path: sourcePath,
    archive_path: `providers/claude_code/${assertRelative(relativeMain, "Claude source path")}`,
    provider_relative_path: assertRelative(relativeMain, "Claude source path"),
    role: "main_transcript",
    required: true,
  }];
  const sessionDir = path.join(projectDir, source.session_id);
  for (const file of listRegularFiles(sessionDir)) {
    const relative = assertRelative(path.relative(claudeRoot, file), "Claude dependency path");
    dependencies.push({ source_path: file, archive_path: `providers/claude_code/${relative}`, provider_relative_path: relative, role: relative.includes("/subagents/") ? "subagent_transcript" : relative.includes("tool") ? "spilled_tool_result" : "session_artifact", required: false });
  }
  if (options.rewind) {
    const historyRoot = path.join(claudeRoot, "file-history", source.session_id);
    for (const file of listRegularFiles(historyRoot)) {
      const relative = assertRelative(path.relative(claudeRoot, file), "Claude file-history path");
      dependencies.push({ source_path: file, archive_path: `providers/claude_code/${relative}`, provider_relative_path: relative, role: "file_history_checkpoint", required: false });
    }
  }
  const generated: Array<{ archive_path: string; role: string; data: Buffer }> = [];
  const indexPath = path.join(projectDir, "sessions-index.json");
  if (fs.existsSync(indexPath)) {
    const { data } = readStableFile(indexPath);
    try {
      const parsed = JSON.parse(data.toString("utf8")) as { version?: number; originalPath?: string; entries?: Array<Record<string, unknown>> };
      const entries = (parsed.entries ?? []).filter((entry) => entry.sessionId === source.session_id);
      if (entries.length) generated.push({ archive_path: "metadata/claude_code/sessions-index-entry.json", role: "session_index_metadata", data: Buffer.from(`${JSON.stringify({ version: parsed.version, entries }, null, 2)}\n`) });
    } catch {
      throw new CustodyError("Claude sessions-index.json is not valid JSON", "invalid_provider_metadata");
    }
  }
  const nativeIdentities = [source.session_id, ...dependencies
    .filter((dependency) => dependency.role === "subagent_transcript")
    .map((dependency) => path.basename(dependency.source_path, path.extname(dependency.source_path)))];
  return { providerRoot: claudeRoot, nativeIdentities, dependencies, generated, restore: { capability: "partial" as const, adapter_version: ADAPTER_VERSION, limitations: ["Provider reinjection is staged only; Claude Code resume semantics are not guaranteed.", ...(options.rewind ? [] : ["File-history checkpoints were not requested, so rewind is not promised."])] } };
}

function extractHistoryBases(data: Buffer): string[] {
  const ids = new Set<string>();
  for (const line of data.toString("utf8").split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      const visit = (value: unknown, key = "") => {
        if (key === "history_base" && typeof value === "string" && value) ids.add(value);
        else if (value && typeof value === "object") {
          for (const [childKey, child] of Object.entries(value as Record<string, unknown>)) visit(child, childKey);
        }
      };
      visit(parsed);
    } catch {
      // Provider JSONL can contain a partially written final line. The stable
      // bytes remain captured, but an unreadable record cannot add a base.
    }
  }
  return [...ids].sort();
}

function extractCodexSessionId(data: Buffer): string | null {
  for (const line of data.toString("utf8").split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const record = JSON.parse(line) as Record<string, unknown>;
      if (record.type !== "session_meta" || !record.payload || typeof record.payload !== "object") continue;
      const id = (record.payload as Record<string, unknown>).id;
      if (typeof id === "string" && id) return id;
    } catch {
      // A partial final provider record cannot establish native identity.
    }
  }
  return null;
}

async function findCodexRollout(codexRoot: string, id: string): Promise<string | null> {
  const matches: string[] = [];
  for (const rootName of ["sessions", "archived_sessions"]) {
    const root = path.join(codexRoot, rootName);
    for await (const file of discoverLogicalSources(root)) {
      const data = await readLogicalSourcePrefix(file);
      if (extractCodexSessionId(data) === id) matches.push(file);
    }
  }
  if (matches.length > 1) throw new CustodyError(`Codex native session identity is ambiguous: ${id}`, "dependency_ambiguous", 409);
  return matches[0] ?? null;
}

async function codexMetadata(file: string): Promise<{ nativeId: string | null; historyBases: string[] }> {
  const handle = await openLogicalSource(file);
  const bases = new Set<string>();
  let nativeId: string | null = null;
  try {
    const before = await handle.stat({ bigint: true });
    const lines = readline.createInterface({ input: handle.createReadStream({ autoClose: false }), crlfDelay: Infinity });
    for await (const line of lines) {
      if (line.length > 64 * 1024 * 1024) throw new CustodyError("provider record exceeds metadata scan budget", "unsupported_source");
      const bytes = Buffer.from(line);
      nativeId ??= extractCodexSessionId(bytes);
      for (const id of extractHistoryBases(bytes)) bases.add(id);
    }
    const after = await handle.stat({ bigint: true });
    if (before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) {
      throw new CustodyError("source changed during metadata scan", "source_changed", 409);
    }
    return { nativeId, historyBases: [...bases] };
  } finally { await handle.close(); }
}

async function codexDependencies(source: CustodySource) {
  const sourcePath = path.resolve(canonicalSourcePath(source.source_path));
  const match = sourcePath.match(/^(.*[/\\]\.codex)[/\\](sessions|archived_sessions)[/\\]/);
  if (!match) throw new CustodyError("Codex source is outside a .codex sessions root", "unsupported_source");
  const codexRoot = match[1];
  const pending = [sourcePath];
  const seen = new Set<string>();
  const dependencies: CustodyDependency[] = [];
  const sessionIds = new Set<string>([source.session_id]);
  while (pending.length) {
    const file = pending.shift()!;
    if (seen.has(file)) continue;
    seen.add(file);
    const metadata = await codexMetadata(file);
    const nativeId = metadata.nativeId;
    if (!nativeId) throw new CustodyError(`Codex rollout has no parsed native session identity: ${file}`, "invalid_provider_metadata");
    if (file === sourcePath && nativeId !== source.session_id) {
      throw new CustodyError("Codex selected rollout identity does not match the conversation source", "source_version_mismatch", 409);
    }
    const relative = assertRelative(path.relative(codexRoot, file), "Codex rollout path");
    dependencies.push({ source_path: file, archive_path: `providers/codex/${relative}`, provider_relative_path: relative, role: file === sourcePath ? "selected_rollout" : "history_base_rollout", required: true });
    for (const id of metadata.historyBases) {
      sessionIds.add(id);
      const base = await findCodexRollout(codexRoot, id);
      if (!base) throw new CustodyError(`required Codex history_base rollout is unavailable: ${id}`, "dependency_unavailable", 409);
      pending.push(base);
    }
  }
  const generated: Array<{ archive_path: string; role: string; data: Buffer }> = [];
  const title = filteredJsonLines(path.join(codexRoot, "session_index.jsonl"), sessionIds);
  if (title) generated.push({ archive_path: "metadata/codex/session_index.jsonl", role: "thread_title_metadata", data: title });
  generated.push({ archive_path: "metadata/codex/thread-state.json", role: "thread_ui_state", data: Buffer.from(`${JSON.stringify({ schema: "mandible-codex-thread-state@1", session_ids: [...sessionIds].sort(), title_source: title ? "session_index.jsonl" : null, unsupported_fields: ["provider-private-ui-state"] }, null, 2)}\n`) });
  return { providerRoot: codexRoot, nativeIdentities: [...sessionIds], dependencies, generated, restore: { capability: "partial" as const, adapter_version: ADAPTER_VERSION, limitations: ["Codex rollout and history-base bytes are restorable without overwrite.", "Provider-private UI state has no guaranteed thread-scoped export API and is recorded as unsupported.", "Native resume after reinjection is provider-version-dependent and not guaranteed."] } };
}

function geminiDependencies(source: CustodySource) {
  const sourcePath = path.resolve(source.source_path);
  const match = sourcePath.match(/^(.*[/\\]\.gemini)[/\\]tmp[/\\]([^/\\]+)[/\\]chats[/\\]/);
  if (!match) throw new CustodyError("Gemini source is outside a .gemini/tmp project root", "unsupported_source");
  const geminiRoot = match[1];
  const projectRoot = path.join(geminiRoot, "tmp", match[2]);
  const dependencies: CustodyDependency[] = [];
  for (const file of listRegularFiles(projectRoot)) {
    const relativeProject = path.relative(projectRoot, file).replace(/\\/g, "/");
    const isMain = path.resolve(file) === sourcePath;
    const exactPathIdentity = relativeProject.split("/").some((part) => part === source.session_id);
    let parsedIdentity = false;
    if (!exactPathIdentity) {
      const { data } = readStableFile(file);
      try {
        const parsed = JSON.parse(data.toString("utf8")) as unknown;
        const visit = (value: unknown, key = ""): void => {
          if (parsedIdentity) return;
          if ((key === "sessionId" || key === "session_id") && value === source.session_id) {
            parsedIdentity = true;
          } else if (value && typeof value === "object") {
            for (const [childKey, child] of Object.entries(value as Record<string, unknown>)) visit(child, childKey);
          }
        };
        visit(parsed);
      } catch {
        // Non-JSON sidecars require an exact session-id path component.
      }
    }
    const sessionScoped = exactPathIdentity || parsedIdentity;
    if (!isMain && !sessionScoped) continue;
    const relative = assertRelative(path.relative(geminiRoot, file), "Gemini dependency path");
    const role = isMain ? "chat" : /subagent/i.test(relative) ? "subagent_artifact" : /plan/i.test(relative) ? "plan" : /task/i.test(relative) ? "task" : /tool/i.test(relative) ? "tool_output" : /log|activit/i.test(relative) ? "activity_log" : "session_artifact";
    dependencies.push({ source_path: file, archive_path: `providers/gemini/${relative}`, provider_relative_path: relative, role, required: isMain });
  }
  const generated: Array<{ archive_path: string; role: string; data: Buffer }> = [];
  const projectsPath = path.join(geminiRoot, "projects.json");
  if (fs.existsSync(projectsPath)) {
    const { data } = readStableFile(projectsPath);
    try {
      const parsed = JSON.parse(data.toString("utf8")) as { projects?: Record<string, string> };
      const value = parsed.projects?.[match[2]];
      if (value) generated.push({ archive_path: "metadata/gemini/project-mapping.json", role: "project_root_mapping", data: Buffer.from(`${JSON.stringify({ schema: "mandible-gemini-project-mapping@1", projects: { [match[2]]: value } }, null, 2)}\n`) });
    } catch {
      throw new CustodyError("Gemini projects.json is not valid JSON", "invalid_provider_metadata");
    }
  }
  return { providerRoot: geminiRoot, nativeIdentities: [source.session_id, `project:${match[2]}`], dependencies, generated, restore: { capability: "partial" as const, adapter_version: ADAPTER_VERSION, limitations: ["Only session-addressable Gemini artifacts are captured; provider-global databases are never copied.", "Gemini native resume after reinjection is provider-version-dependent and not guaranteed."] } };
}

async function discover(source: CustodySource, options: CustodyCaptureOptions) {
  if (source.provider === "claude_code") return claudeDependencies(source, options);
  if (source.provider === "codex") return codexDependencies(source);
  if (source.provider === "gemini") return geminiDependencies(source);
  throw new CustodyError(`unsupported provider: ${String(source.provider)}`, "unsupported_provider");
}

export class ConversationCustodyStore {
  readonly root: string;

  constructor(
    root = getMandibleHomePath("conversation-custody"),
    private readonly hooks: { afterSourceRead?: (sourcePath: string) => void } = {},
  ) {
    this.root = path.resolve(root);
    ensureDir(this.root);
  }

  private conversationRoot(conversationId: string): string {
    assertSafeComponent(conversationId, "conversation id");
    return path.join(this.root, "conversations", conversationId);
  }

  private statusPath(conversationId: string): string {
    return path.join(this.conversationRoot(conversationId), "status.json");
  }

  status(conversationId: string): CustodyStatusRecord | null {
    const file = this.statusPath(conversationId);
    if (!fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, "utf8")) as CustodyStatusRecord;
  }

  private transition(conversationId: string, state: CustodyState, detail?: string, activeVersion?: string | null): CustodyStatusRecord {
    const current = this.status(conversationId);
    const now = new Date().toISOString();
    const next: CustodyStatusRecord = {
      conversation_id: conversationId,
      state,
      active_version: activeVersion === undefined ? current?.active_version ?? null : activeVersion,
      updated_at: now,
      error: state === "error" ? detail ?? "capture failed" : null,
      history: [...(current?.history ?? []), { state, at: now, ...(detail ? { detail } : {}) }],
    };
    atomicJson(this.statusPath(conversationId), next);
    return next;
  }

  async capture(source: CustodySource, options: CustodyCaptureOptions = {}): Promise<CustodyCaptureResult> {
    assertSafeComponent(source.conversation_id, "conversation id");
    assertSafeComponent(source.session_id, "session id");
    if (!!source.expected_source_version_id !== !!source.expected_source_sha256) {
      throw new CustodyError("source version id and SHA-256 must be supplied together", "source_version_mismatch", 409);
    }
    if (source.expected_source_sha256 && !/^[0-9a-f]{64}$/.test(source.expected_source_sha256)) {
      throw new CustodyError("expected source SHA-256 is not sealed", "source_version_mismatch", 409);
    }
    this.transition(source.conversation_id, "requested");
    this.transition(source.conversation_id, "capturing");
    let staging = "";
    try {
      const discovered = await discover(source, options);
      const dependencyKeys = new Set<string>();
      for (const dependency of discovered.dependencies) {
        const logical = await openLogicalSource(dependency.source_path, { rootPath: discovered.providerRoot });
        await logical.close();
        if (source.provider !== "codex") assertWithinProviderRoot(discovered.providerRoot, dependency.source_path);
        dependency.archive_path = assertRelative(dependency.archive_path, "archive path");
        if (dependencyKeys.has(dependency.archive_path)) throw new CustodyError(`duplicate archive path: ${dependency.archive_path}`, "archive_collision");
        dependencyKeys.add(dependency.archive_path);
      }
      staging = path.join(this.conversationRoot(source.conversation_id), `.capture-${crypto.randomUUID()}`);
      ensureDir(staging);
      const files: CustodyFileRecord[] = [];
      let selectedSourceMatched = false;
      for (const dependency of discovered.dependencies) {
        const destination = path.join(staging, dependency.archive_path);
        if (!within(staging, destination)) throw new CustodyError("archive destination escaped staging root", "unsafe_path");
        ensureDir(path.dirname(destination));
        const observed = await streamStableFile(dependency.source_path, destination, discovered.providerRoot, this.hooks.afterSourceRead);
        if (canonicalSourcePath(path.resolve(dependency.source_path)) === canonicalSourcePath(path.resolve(source.source_path))) {
          if (selectedSourceMatched) throw new CustodyError("selected transcript was discovered more than once", "archive_collision");
          selectedSourceMatched = true;
          if (source.expected_source_sha256 && observed.sha256 !== source.expected_source_sha256) {
            throw new CustodyError("selected transcript bytes no longer match the current sealed source version", "source_changed", 409);
          }
        }
        files.push({ path: dependency.archive_path, provider_relative_path: dependency.provider_relative_path, dependency_role: dependency.role, size: observed.size, sha256: observed.sha256, required: dependency.required });
      }
      if (!selectedSourceMatched) throw new CustodyError("selected transcript was not captured", "source_version_mismatch", 409);
      for (const generated of discovered.generated) {
        const archivePath = assertRelative(generated.archive_path, "generated metadata path");
        if (dependencyKeys.has(archivePath)) throw new CustodyError(`duplicate archive path: ${archivePath}`, "archive_collision");
        dependencyKeys.add(archivePath);
        const destination = path.join(staging, archivePath);
        ensureDir(path.dirname(destination));
        fs.writeFileSync(destination, generated.data, { mode: 0o600, flag: "wx" });
        files.push({ path: archivePath, provider_relative_path: archivePath, dependency_role: generated.role, size: generated.data.length, sha256: sha256(generated.data), required: false });
      }
      files.sort(comparePathCodeUnits);
      const sourceVersion = versionDigest(files);
      const custodyVersion = custodyVersionDigest(
        sourceVersion,
        source.expected_source_version_id,
        source.expected_source_sha256,
      );
      const manifest: CustodyManifest = {
        archive_format: ARCHIVE_FORMAT,
        provider: source.provider,
        provider_adapter_version: ADAPTER_VERSION,
        canonical_conversation_id: source.conversation_id,
        native_identities: [...new Set([...discovered.nativeIdentities, ...(source.native_identities ?? [])])].sort(),
        ...(source.expected_source_version_id ? { source_version_id: source.expected_source_version_id } : {}),
        ...(source.expected_source_sha256 ? { source_sha256: source.expected_source_sha256 } : {}),
        source_version: sourceVersion,
        custody_version: custodyVersion,
        capture_consistency: "file-by-file-stable",
        captured_at: new Date().toISOString(),
        files,
        restore: discovered.restore,
      };
      const versionsRoot = path.join(this.conversationRoot(source.conversation_id), "versions");
      ensureDir(versionsRoot);
      const versionPath = path.join(versionsRoot, custodyVersion);
      let reused = false;
      if (fs.existsSync(versionPath)) {
        const existing = await this.verifyVersionStreaming(source.conversation_id, custodyVersion);
        if (!existing.ok) throw new CustodyError(`existing immutable version failed verification: ${existing.errors.join("; ")}`, "integrity_failure", 409);
        reused = true;
        fs.rmSync(staging, { recursive: true, force: true });
        staging = "";
      } else {
        atomicJson(path.join(staging, "manifest.json"), manifest);
        const sums = files.map((file) => `${file.sha256}  ${file.path}`).join("\n");
        fs.writeFileSync(path.join(staging, "SHA256SUMS"), `${sums}\n`, { mode: 0o600, flag: "wx" });
        fs.renameSync(staging, versionPath);
        staging = "";
        const verified = await this.verifyVersionStreaming(source.conversation_id, custodyVersion);
        if (!verified.ok) throw new CustodyError(`captured version failed verification: ${verified.errors.join("; ")}`, "integrity_failure", 500);
      }
      this.transition(source.conversation_id, "verified", reused ? "verified existing immutable version" : undefined, custodyVersion);
      const finalState = options.seal === false ? "mirroring" : "sealed";
      const status = this.transition(source.conversation_id, finalState, undefined, custodyVersion);
      return { status, manifest: this.readManifest(versionPath), version_path: versionPath, reused };
    } catch (error) {
      if (staging && fs.existsSync(staging)) fs.rmSync(staging, { recursive: true, force: true });
      this.transition(source.conversation_id, "error", error instanceof Error ? error.message : String(error));
      throw error;
    }
  }

  private readManifest(versionPath: string): CustodyManifest {
    const manifest = JSON.parse(fs.readFileSync(path.join(versionPath, "manifest.json"), "utf8")) as CustodyManifest;
    if (manifest.archive_format !== ARCHIVE_FORMAT) throw new CustodyError("unsupported custody archive format", "unsupported_archive");
    return manifest;
  }

  private async verifyVersionStreaming(conversationId: string, version: string): Promise<IntegrityResult> {
    const result = this.verifyVersion(conversationId, version, true);
    const versionPath = path.join(this.conversationRoot(conversationId), "versions", version);
    for (const file of result.manifest.files) {
      try {
        const relative = assertRelative(file.path, "manifest file path");
        const observed = await streamStableFile(path.join(versionPath, relative), undefined, versionPath);
        if (observed.size !== file.size) result.errors.push(`${relative}: size mismatch`);
        if (observed.sha256 !== file.sha256) result.errors.push(`${relative}: checksum mismatch`);
      } catch (error) { result.errors.push(error instanceof Error ? error.message : String(error)); }
    }
    result.ok = result.errors.length === 0;
    return result;
  }

  verifyVersion(conversationId: string, version?: string, manifestOnly = false): IntegrityResult {
    const status = this.status(conversationId);
    const selected = version ?? status?.active_version;
    if (!selected) throw new CustodyError("conversation has no captured custody version", "custody_unavailable", 404);
    assertSafeComponent(selected, "custody version");
    const versionPath = path.join(this.conversationRoot(conversationId), "versions", selected);
    const manifest = this.readManifest(versionPath);
    const errors: string[] = [];
    const computedVersion = versionDigest(manifest.files);
    const computedCustodyVersion = custodyVersionDigest(
      computedVersion,
      manifest.source_version_id,
      manifest.source_sha256,
    );
    if (manifest.source_version !== computedVersion) errors.push("manifest source_version does not match its file records");
    if (manifest.custody_version !== computedCustodyVersion) errors.push("manifest custody_version does not match its file records and source binding");
    if (!!manifest.source_version_id !== !!manifest.source_sha256) {
      errors.push("manifest source binding is incomplete");
    }
    if (manifest.source_sha256) {
      const selectedRole = manifest.provider === "claude_code"
        ? "main_transcript"
        : manifest.provider === "codex" ? "selected_rollout" : "chat";
      const selectedFiles = manifest.files.filter((file) => file.dependency_role === selectedRole);
      if (selectedFiles.length !== 1 || selectedFiles[0].sha256 !== manifest.source_sha256) {
        errors.push("manifest source SHA-256 does not match the selected transcript");
      }
    }
    const declared = new Set(manifest.files.map((file) => file.path));
    for (const file of manifestOnly ? [] : manifest.files) {
      try {
        const relative = assertRelative(file.path, "manifest file path");
        const candidate = path.join(versionPath, relative);
        if (!within(versionPath, candidate)) throw new CustodyError("manifest file escaped version root", "unsafe_path");
        const { data } = readStableFile(candidate);
        if (data.length !== file.size) errors.push(`${relative}: size mismatch`);
        if (sha256(data) !== file.sha256) errors.push(`${relative}: checksum mismatch`);
      } catch (error) {
        errors.push(error instanceof Error ? error.message : String(error));
      }
    }
    for (const file of listRegularFiles(versionPath)) {
      const relative = path.relative(versionPath, file).replace(/\\/g, "/");
      if (relative !== "manifest.json" && relative !== "SHA256SUMS" && !declared.has(relative)) errors.push(`${relative}: undeclared file`);
    }
    return { ok: errors.length === 0, checked: manifest.files.length, errors, manifest };
  }

  exportArchive(conversationId: string, destination: string, annotations: unknown = {}): string {
    const result = this.verifyVersion(conversationId);
    if (!result.ok) throw new CustodyError(`cannot export corrupt custody: ${result.errors.join("; ")}`, "integrity_failure", 409);
    const output = path.resolve(destination);
    if (fs.existsSync(output)) throw new CustodyError(`archive destination already exists: ${output}`, "destination_exists", 409);
    const versionPath = path.join(this.conversationRoot(conversationId), "versions", result.manifest.custody_version);
    ensureDir(output);
    try {
      for (const file of result.manifest.files) {
        const sourcePath = path.join(versionPath, file.path);
        const destinationPath = path.join(output, file.path);
        ensureDir(path.dirname(destinationPath));
        fs.copyFileSync(sourcePath, destinationPath, fs.constants.COPYFILE_EXCL);
        fs.chmodSync(destinationPath, 0o600);
      }
      atomicJson(path.join(output, "manifest.json"), result.manifest);
      atomicJson(path.join(output, "metadata.json"), {
        schema: "mandible-conversation-recovery@1",
        canonical_conversation_id: conversationId,
        provider: result.manifest.provider,
        native_identities: result.manifest.native_identities,
        source_version_id: result.manifest.source_version_id ?? null,
        source_sha256: result.manifest.source_sha256 ?? null,
        source_version: result.manifest.source_version,
        custody_version: result.manifest.custody_version,
      });
      const annotationPath = `annotations/${conversationId}.json`;
      atomicJson(path.join(output, annotationPath), { schema: "mandible-conversation-annotations@1", conversation_id: conversationId, annotations });
      const records = [...result.manifest.files];
      for (const relative of ["manifest.json", "metadata.json", annotationPath]) {
        const data = fs.readFileSync(path.join(output, relative));
        records.push({ path: relative, provider_relative_path: relative, dependency_role: relative === "manifest.json" ? "manifest" : "annotations", size: data.length, sha256: sha256(data), required: true });
      }
      records.sort(comparePathCodeUnits);
      fs.writeFileSync(path.join(output, "SHA256SUMS"), `${records.map((file) => `${file.sha256}  ${file.path}`).join("\n")}\n`, { mode: 0o600, flag: "wx" });
      return output;
    } catch (error) {
      fs.rmSync(output, { recursive: true, force: true });
      throw error;
    }
  }

  verifyArchive(archiveRoot: string): IntegrityResult {
    const root = path.resolve(archiveRoot);
    const manifest = this.readManifest(root);
    const errors: string[] = [];
    const computedVersion = versionDigest(manifest.files);
    const computedCustodyVersion = custodyVersionDigest(
      computedVersion,
      manifest.source_version_id,
      manifest.source_sha256,
    );
    if (manifest.source_version !== computedVersion) errors.push("manifest source_version does not match its file records");
    if (manifest.custody_version !== computedCustodyVersion) errors.push("manifest custody_version does not match its file records and source binding");
    const annotationPath = `annotations/${manifest.canonical_conversation_id}.json`;
    const required = new Set(["manifest.json", "metadata.json", annotationPath, ...manifest.files.map((file) => file.path)]);
    const checksummed = new Set<string>();
    for (const line of fs.readFileSync(path.join(root, "SHA256SUMS"), "utf8").split(/\r?\n/).filter(Boolean)) {
      const match = line.match(/^([a-f0-9]{64})  (.+)$/);
      if (!match) { errors.push(`invalid SHA256SUMS line: ${line}`); continue; }
      try {
        const relative = assertRelative(match[2], "checksum path");
        if (checksummed.has(relative)) { errors.push(`${relative}: duplicate checksum entry`); continue; }
        checksummed.add(relative);
        const candidate = path.join(root, relative);
        if (!within(root, candidate)) throw new CustodyError("checksum path escaped archive root", "unsafe_path");
        const { data } = readStableFile(candidate);
        if (sha256(data) !== match[1]) errors.push(`${relative}: checksum mismatch`);
      } catch (error) {
        errors.push(error instanceof Error ? error.message : String(error));
      }
    }
    for (const relative of required) {
      if (!checksummed.has(relative)) errors.push(`${relative}: missing checksum entry`);
    }
    for (const file of listRegularFiles(root)) {
      const relative = path.relative(root, file).replace(/\\/g, "/");
      if (relative !== "SHA256SUMS" && !checksummed.has(relative)) errors.push(`${relative}: undeclared archive file`);
    }
    return { ok: errors.length === 0, checked: checksummed.size, errors, manifest };
  }

  importArchive(archiveRoot: string): CustodyCaptureResult {
    const verified = this.verifyArchive(archiveRoot);
    if (!verified.ok) throw new CustodyError(`archive integrity failed: ${verified.errors.join("; ")}`, "integrity_failure", 409);
    const manifest = verified.manifest;
    assertSafeComponent(manifest.canonical_conversation_id, "conversation id");
    assertSafeComponent(manifest.custody_version, "custody version");
    const destination = path.join(this.conversationRoot(manifest.canonical_conversation_id), "versions", manifest.custody_version);
    if (fs.existsSync(destination)) {
      const existing = this.verifyVersion(manifest.canonical_conversation_id, manifest.custody_version);
      if (!existing.ok) throw new CustodyError("existing custody version is corrupt", "integrity_failure", 409);
      const status = this.transition(manifest.canonical_conversation_id, "sealed", "verified existing immutable version", manifest.custody_version);
      return { status, manifest: existing.manifest, version_path: destination, reused: true };
    }
    const staging = `${destination}.import-${crypto.randomUUID()}`;
    ensureDir(staging);
    try {
      for (const file of [...manifest.files.map((entry) => entry.path), "manifest.json", "SHA256SUMS"]) {
        const relative = assertRelative(file, "archive import path");
        const sourcePath = path.join(path.resolve(archiveRoot), relative);
        const destinationPath = path.join(staging, relative);
        ensureDir(path.dirname(destinationPath));
        fs.copyFileSync(sourcePath, destinationPath, fs.constants.COPYFILE_EXCL);
        fs.chmodSync(destinationPath, 0o600);
      }
      ensureDir(path.dirname(destination));
      fs.renameSync(staging, destination);
      const recovery = path.join(this.conversationRoot(manifest.canonical_conversation_id), "recovery", manifest.custody_version);
      ensureDir(recovery);
      for (const relative of ["metadata.json", `annotations/${manifest.canonical_conversation_id}.json`]) {
        const recoveryTarget = path.join(recovery, relative);
        ensureDir(path.dirname(recoveryTarget));
        fs.copyFileSync(path.join(path.resolve(archiveRoot), relative), recoveryTarget, fs.constants.COPYFILE_EXCL);
        fs.chmodSync(recoveryTarget, 0o600);
      }
    } catch (error) {
      fs.rmSync(staging, { recursive: true, force: true });
      throw error;
    }
    const status = this.transition(manifest.canonical_conversation_id, "sealed", undefined, manifest.custody_version);
    return { status, manifest, version_path: destination, reused: false };
  }

  stageProviderRestore(conversationId: string, stagingRoot: string, providerRoot: string): { staging_path: string; files: number; capability: ProviderRestoreClaim } {
    const verified = this.verifyVersion(conversationId);
    if (!verified.ok) throw new CustodyError(`cannot restore corrupt custody: ${verified.errors.join("; ")}`, "integrity_failure", 409);
    const root = path.resolve(stagingRoot);
    const destination = path.join(root, `${conversationId}-${verified.manifest.custody_version.slice(0, 12)}`);
    if (fs.existsSync(destination)) throw new CustodyError(`restore staging destination already exists: ${destination}`, "destination_exists", 409);
    const provider = verified.manifest.provider;
    const providerFiles = verified.manifest.files.filter((file) => file.path.startsWith(`providers/${provider}/`));
    for (const file of providerFiles) {
      const relative = assertRelative(file.provider_relative_path, "provider restore path");
      const liveTarget = path.join(path.resolve(providerRoot), relative);
      if (!within(path.resolve(providerRoot), liveTarget)) throw new CustodyError("provider restore path escaped target root", "unsafe_path");
      if (fs.existsSync(liveTarget)) throw new CustodyError(`provider collision; refusing to overwrite: ${relative}`, "provider_collision", 409);
    }
    ensureDir(destination);
    try {
      const versionPath = path.join(this.conversationRoot(conversationId), "versions", verified.manifest.custody_version);
      for (const file of providerFiles) {
        const relative = assertRelative(file.provider_relative_path, "provider restore path");
        const target = path.join(destination, relative);
        ensureDir(path.dirname(target));
        fs.copyFileSync(path.join(versionPath, file.path), target, fs.constants.COPYFILE_EXCL);
        fs.chmodSync(target, 0o600);
      }
      atomicJson(path.join(destination, "restore-plan.json"), { schema: "mandible-provider-restore-plan@1", conversation_id: conversationId, provider, provider_root: path.resolve(providerRoot), capability: verified.manifest.restore, files: providerFiles.map((file) => file.provider_relative_path) });
      return { staging_path: destination, files: providerFiles.length, capability: verified.manifest.restore };
    } catch (error) {
      fs.rmSync(destination, { recursive: true, force: true });
      throw error;
    }
  }
}
