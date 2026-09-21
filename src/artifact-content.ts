import { hashFileSha256OffThread } from "./artifact-content-worker.js";
import os from "node:os";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Db } from "./db.js";
import { readCommittedArtifactFiles } from "./artifact-repo-resolution.js";
import { getArtifact, resolveArtifactRefReadonly } from "./provider-artifacts.js";
import type { ArtifactMaterializationCheck, ArtifactRecord } from "./types.js";

const DEFAULT_PREVIEW_BYTES = 128 * 1024;
const HTML_PREVIEW_BYTES = 8 * 1024 * 1024;
const JSON_COMPLETE_PREVIEW_BYTES = 1 * 1024 * 1024;
const JSON_PARTIAL_PREVIEW_BYTES = 256 * 1024;

export type ArtifactContentKind = "text" | "markdown" | "json" | "html" | "binary" | "unavailable";
export type ArtifactContentSourceKind = "managed_file" | "repo_locator" | "local_file";

export interface ArtifactContentPreview {
  encoding: "utf-8";
  text: string;
  raw_text?: string;
  formatted?: "json";
  truncated: boolean;
  preview_bytes: number;
  total_bytes: number;
  omitted_bytes: number;
  format_skipped?: "partial_preview";
}

export interface ArtifactDownloadMetadata {
  available: boolean;
  media_type: string;
  size_bytes: number;
  filename: string | null;
  reason?: string;
}

export interface ArtifactContentResult {
  artifact_id: string;
  status: "available" | "unavailable";
  kind: ArtifactContentKind;
  media_type: string;
  size_bytes: number;
  source: {
    kind: ArtifactContentSourceKind;
    locator: string;
  } | null;
  preview: ArtifactContentPreview | null;
  download: ArtifactDownloadMetadata;
  reason?: string;
  warnings?: string[];
}

export type ArtifactOpenFileResult =
  | { ok: true; artifact_id: string; path: string; source_kind: ArtifactContentSourceKind }
  | { ok: false; reason: string };

/** One read path: a version's custody is never changed by blob dedup or source relocation. */
export function readArtifactBytesFull(db: Db, id: string, maxBytes = MAX_DIFF_BYTES):
  {ok:true;bytes:Buffer;source:string} | {ok:false;reason:string} {
  const artifact = getArtifact(db,id);
  if (!artifact) return {ok:false,reason:'artifact not found'};
  if (artifact.custody_mode === null) return {ok:false,reason:'Select a saved version to read its Git authority; this blob has no stored bytes'};
  try {
    let bytes: Buffer;
    let source: string;
    if (artifact.custody_mode === 'git') {
      const locator = artifact.repo_locator;
      if (!artifact.home_repo_id || typeof locator.commit !== 'string' || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(locator.commit) || typeof locator.path !== 'string') {
        return {ok:false,reason:'invalid Git custody'};
      }
      const file = readCommittedArtifactFiles(db,{project:artifact.home_repo_id,commit:locator.commit,paths:[locator.path]})[0];
      bytes = file.bytes; source = artifact.uri;
    } else {
      if (!artifact.uri.startsWith('file://')) return {ok:false,reason:'stored artifact bytes are unavailable'};
      const filename = fileURLToPath(artifact.uri);
      const stat = fs.statSync(filename);
      if (!stat.isFile()) return {ok:false,reason:'stored artifact is not a regular file'};
      if (stat.size > maxBytes) return {ok:false,reason:'artifact exceeds size limit'};
      bytes = fs.readFileSync(filename); source = artifact.uri;
    }
    if (bytes.length > maxBytes) return {ok:false,reason:'artifact exceeds size limit'};
    if (crypto.createHash('sha256').update(bytes).digest('hex') !== artifact.content_hash) return {ok:false,reason:'artifact bytes do not match registered sha256'};
    return {ok:true,bytes,source};
  } catch(error) { return {ok:false,reason:String(error)}; }
}

export function checkArtifactMaterialization(db: Db,id:string,options:{ref?:string}={}): ArtifactMaterializationCheck | null {
  const artifact = getArtifact(db,id);
  if (!artifact) return null;
  const read = readArtifactBytesFull(db,id,Number.MAX_SAFE_INTEGER);
  return {artifact_id:artifact.id,ref:options.ref,materializable:read.ok,
    hash_matches:read.ok ? true : read.reason.includes("do not match registered sha256") ? false : null,expected_sha256:artifact.content_hash,
    actual_sha256:read.ok ? artifact.content_hash : null,source:read.ok ? read.source : null,
    recoverability:artifact.custody_mode === 'git' ? 'repo_commit' : 'mandible_cas',
    reasons:read.ok ? [] : [read.reason],warnings:[]};
}

export function getArtifactContent(db:Db,id:string,options:{previewBytes?:number}={}):ArtifactContentResult|null {
  const artifact=getArtifact(db,id);
  if (!artifact) return null;
  const read=readArtifactBytesFull(db,id,Number.MAX_SAFE_INTEGER);
  if (read.ok) return artifactContentFromBytes(artifact,read.bytes,{kind:artifact.custody_mode === 'git' ? 'repo_locator' : 'managed_file',locator:read.source},options.previewBytes ?? DEFAULT_PREVIEW_BYTES);
  const media=artifact.media_type ?? inferMediaType(artifact);
  return {artifact_id:artifact.id,status:'unavailable',kind:'unavailable',media_type:media,size_bytes:artifact.size_bytes,
    source:null,preview:null,reason:read.reason,download:{available:false,media_type:media,size_bytes:artifact.size_bytes,filename:artifactFilename(artifact),reason:read.reason}};
}

export async function getArtifactContentAsync(db:Db,id:string,options:{previewBytes?:number}={}):Promise<ArtifactContentResult|null> {
  const artifact = getArtifact(db,id);
  if (!artifact || artifact.custody_mode === 'git') return getArtifactContent(db,id,options);
  try {
    if (!artifact.uri.startsWith('file://')) return getArtifactContent(db,id,options);
    const filename = fileURLToPath(artifact.uri);
    const before = await fs.promises.stat(filename);
    if (!before.isFile() || await hashFileSha256OffThread(filename) !== artifact.content_hash) throw new Error('stored artifact bytes do not match registered sha256');
    const limit = Math.max(options.previewBytes ?? DEFAULT_PREVIEW_BYTES, HTML_PREVIEW_BYTES);
    const file = await fs.promises.open(filename,'r');
    let bytes: Buffer;
    try {
      bytes = Buffer.alloc(Math.min(before.size,limit));
      const read = await file.read(bytes,0,bytes.length,0);
      bytes = bytes.subarray(0,read.bytesRead);
      const after = await file.stat();
      if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ino !== after.ino) throw new Error('stored artifact changed during preview');
    } finally { await file.close(); }
    return artifactContentFromBytes(artifact,bytes,{kind:'managed_file',locator:artifact.uri},options.previewBytes ?? DEFAULT_PREVIEW_BYTES,before.size);
  } catch(error) {
    const media = artifact.media_type ?? inferMediaType(artifact), reason = String(error);
    return {artifact_id:artifact.id,status:'unavailable',kind:'unavailable',media_type:media,size_bytes:artifact.size_bytes,source:null,preview:null,reason,
      download:{available:false,media_type:media,size_bytes:artifact.size_bytes,filename:artifactFilename(artifact),reason}};
  }
}

export async function resolveArtifactOpenFile(db:Db,id:string):Promise<ArtifactOpenFileResult|null> {
  const artifact=getArtifact(db,id);
  if (!artifact) return null;
  const read=readArtifactBytesFull(db,id,Number.MAX_SAFE_INTEGER);
  if (!read.ok) return read;
  if (artifact.custody_mode === 'managed') return {ok:true,artifact_id:artifact.id,path:fileURLToPath(artifact.uri),source_kind:'managed_file'};
  // Opening a historical Git version materializes a disposable verified view, never the worktree file.
  const filename=path.join(os.tmpdir(),'mandible-artifact-open',artifact.content_hash,artifactFilename(artifact) ?? 'artifact');
  fs.mkdirSync(path.dirname(filename),{recursive:true});
  fs.writeFileSync(filename,read.bytes);
  return {ok:true,artifact_id:artifact.id,path:filename,source_kind:'repo_locator'};
}

function artifactContentFromBytes(
  artifact: ArtifactRecord,
  bytes: Buffer,
  source: NonNullable<ArtifactContentResult["source"]>,
  previewBytes: number,
  totalBytes = bytes.byteLength,
): ArtifactContentResult {
  const mediaType = artifact.media_type ?? inferMediaType(artifact);
  const filename = artifactFilename(artifact);
  const sizeBytes = totalBytes;
  const base = {
    artifact_id: artifact.id,
    status: "available" as const,
    media_type: mediaType,
    size_bytes: sizeBytes,
    source,
    download: {
      available: true,
      media_type: mediaType,
      size_bytes: sizeBytes,
      filename,
    },
    warnings: [] as string[],
  };
  const kind = previewKind(mediaType, filename);
  if (kind === "binary") return { ...base, kind, preview: null };

  const textPreviewBytes = kind === "html"
    ? Math.max(previewBytes, HTML_PREVIEW_BYTES)
    : kind === "json"
      ? sizeBytes <= JSON_COMPLETE_PREVIEW_BYTES
        ? Math.max(previewBytes, JSON_COMPLETE_PREVIEW_BYTES)
        : Math.max(previewBytes, JSON_PARTIAL_PREVIEW_BYTES)
      : previewBytes;
  const preview = readTextPreviewBytes(bytes, textPreviewBytes);
  if (!preview) return { ...base, kind: "binary", preview: null };
  preview.total_bytes = sizeBytes;
  preview.omitted_bytes = Math.max(0,sizeBytes-preview.preview_bytes);
  preview.truncated = preview.omitted_bytes > 0;
  if (kind === "json") {
    const formatted = preview.truncated ? null : prettyJson(preview.text);
    return {
      ...base,
      kind,
      preview: {
        ...preview,
        ...(formatted && formatted !== preview.text ? { raw_text: preview.text, formatted: "json" as const } : {}),
        ...(preview.truncated ? { format_skipped: "partial_preview" as const } : {}),
        text: formatted ?? preview.text,
      },
    };
  }
  return { ...base, kind, preview };
}

function previewKind(mediaType: string, filename: string | null): Exclude<ArtifactContentKind, "unavailable"> {
  const lowerMediaType = mediaType.toLowerCase();
  const lowerName = (filename ?? "").toLowerCase();
  if (lowerMediaType.includes("json") || lowerName.endsWith(".json")) return "json";
  if (lowerMediaType.includes("html") || lowerName.endsWith(".html") || lowerName.endsWith(".htm")) return "html";
  if (lowerMediaType.includes("markdown") || lowerName.endsWith(".md") || lowerName.endsWith(".markdown")) {
    return "markdown";
  }
  if (lowerMediaType.startsWith("text/") || [".txt", ".log", ".csv", ".tsv"].some((ext) => lowerName.endsWith(ext))) {
    return "text";
  }
  if (isSourceLikeFilename(lowerName)) return "text";
  return "binary";
}

function readTextPreviewBytes(bytes: Buffer, maxBytes: number): ArtifactContentPreview | null {
  const limit = Math.max(0, maxBytes);
  const bytesToRead = Math.min(bytes.byteLength, limit + 1);
  const truncated = bytesToRead > limit;
  const previewBytes = bytes.subarray(0, truncated ? limit : bytesToRead);
  const decoded = decodeUtf8Preview(previewBytes, truncated);
  if (decoded === null) return null;
  return {
    encoding: "utf-8",
    text: decoded,
    truncated,
    preview_bytes: previewBytes.byteLength,
    total_bytes: bytes.byteLength,
    omitted_bytes: Math.max(0, bytes.byteLength - previewBytes.byteLength),
  };
}

function prettyJson(text: string): string | null {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return null;
  }
}

function inferMediaType(artifact: ArtifactRecord): string {
  const filename = artifactFilename(artifact);
  const lowerName = (filename ?? "").toLowerCase();
  if (lowerName.endsWith(".json")) return "application/json";
  if (lowerName.endsWith(".html") || lowerName.endsWith(".htm")) return "text/html";
  if (lowerName.endsWith(".md") || lowerName.endsWith(".markdown")) return "text/markdown";
  if (isSourceLikeFilename(lowerName)) return "text/plain";
  if (lowerName.endsWith(".txt") || lowerName.endsWith(".log")) return "text/plain";
  return "application/octet-stream";
}

const SOURCE_TEXT_EXTENSIONS = new Set([
  ".bash",
  ".c",
  ".cc",
  ".cfg",
  ".conf",
  ".cpp",
  ".css",
  ".env",
  ".fish",
  ".go",
  ".h",
  ".hpp",
  ".ini",
  ".java",
  ".jl",
  ".js",
  ".jsx",
  ".kt",
  ".kts",
  ".lua",
  ".mjs",
  ".php",
  ".py",
  ".r",
  ".rb",
  ".rs",
  ".scss",
  ".sh",
  ".sql",
  ".swift",
  ".toml",
  ".ts",
  ".tsx",
  ".yaml",
  ".yml",
  ".zsh",
]);

const SOURCE_TEXT_FILENAMES = new Set([
  ".dockerignore",
  ".env",
  ".gitignore",
  "dockerfile",
  "makefile",
]);

function isSourceLikeFilename(lowerName: string): boolean {
  const basename = lowerName.split(/[\\/]/).pop() ?? lowerName;
  if (SOURCE_TEXT_FILENAMES.has(basename)) return true;
  return SOURCE_TEXT_EXTENSIONS.has(path.extname(basename));
}

function decodeUtf8Preview(bytes: Buffer, allowTrim = false): string | null {
  if (bytes.includes(0)) return null;
  const minEnd = allowTrim ? Math.max(0, bytes.byteLength - 3) : bytes.byteLength;
  for (let end = bytes.byteLength; end >= minEnd; end -= 1) {
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, end));
    } catch {
      // A truncated preview may stop in the middle of one UTF-8 codepoint.
    }
  }
  return null;
}

function artifactFilename(artifact: ArtifactRecord): string | null {
  return stringValue(artifact.metadata.filename)
    ?? stringValue(artifact.metadata.logical_name)
    ?? stringValue(artifact.repo_locator.path)?.split(/[\\/]/).pop()
    ?? null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

// ---------------------------------------------------------------------------
// Artifact full-byte reads and text/JSON/Markdown diffs (issue f7a994e).
//
// Diffs are DERIVED from full snapshot bytes (never stored as the canonical
// representation) — analogous to the issue/comment body-revision diff
// precedent. The immutable artifact rows remain the source of truth.
// ---------------------------------------------------------------------------

const MAX_DIFF_BYTES = 4 * 1024 * 1024;
const MAX_DIFF_CELLS = 4_000_000;

export interface ArtifactDiffSide {
  ref: string;
  artifact_id: string | null;
  content_hash: string | null;
  media_type: string;
  size_bytes: number | null;
  available: boolean;
  reason?: string;
}

export interface ArtifactDiffResult {
  a: ArtifactDiffSide;
  b: ArtifactDiffSide;
  diffable: boolean;
  identical: boolean;
  kind: ArtifactContentKind;
  unified: string | null;
  stats: { added: number; removed: number } | null;
  reason?: string;
}

function diffSideMeta(artifact: ArtifactRecord | null, ref: string): ArtifactDiffSide {
  if (!artifact) {
    return { ref, artifact_id: null, content_hash: null, media_type: "application/octet-stream", size_bytes: null, available: false, reason: "artifact ref did not resolve" };
  }
  return {
    ref,
    artifact_id: artifact.id,
    content_hash: artifact.content_hash,
    media_type: artifact.media_type ?? inferMediaType(artifact),
    size_bytes: artifact.size_bytes,
    available: true,
  };
}

// Resolve a diff ref to its immutable artifact WITHOUT mutating the registry
// (these GET endpoints must not materialize artifact rows/aliases/graph
// entities). Accepts canonical logical artifact, artifact-version,
// artifact-blob, and URI-style refs already known to the registry.
function resolveDiffArtifact(db: Db, ref: string): ArtifactRecord | null {
  return resolveArtifactRefReadonly(db, ref);
}

export function diffArtifacts(db: Db, refA: string, refB: string): ArtifactDiffResult {
  const artifactA = resolveDiffArtifact(db, refA);
  const artifactB = resolveDiffArtifact(db, refB);
  const sideA = diffSideMeta(artifactA, refA);
  const sideB = diffSideMeta(artifactB, refB);

  const fail = (reason: string, kind: ArtifactContentKind = "unavailable"): ArtifactDiffResult => ({
    a: sideA, b: sideB, diffable: false, identical: false, kind, unified: null, stats: null, reason,
  });

  if (!artifactA || !artifactB) {
    return fail("one or both artifact refs did not resolve");
  }

  const kindA = previewKind(sideA.media_type, artifactFilename(artifactA));
  const kindB = previewKind(sideB.media_type, artifactFilename(artifactB));
  if (kindA === "binary" || kindB === "binary") {
    return fail("artifact content is not text-like; diff is unavailable", "binary");
  }

  const identical = artifactA.algorithm === "sha256"
    && artifactB.algorithm === "sha256"
    && artifactA.content_hash.toLowerCase() === artifactB.content_hash.toLowerCase();

  const bytesA = readArtifactBytesFull(db, stringValue(artifactA.reference.canonical_version_id) ?? artifactA.id);
  if (!bytesA.ok) {
    sideA.available = false;
    sideA.reason = bytesA.reason;
    return fail(`left artifact bytes unavailable: ${bytesA.reason}`);
  }
  const bytesB = readArtifactBytesFull(db, stringValue(artifactB.reference.canonical_version_id) ?? artifactB.id);
  if (!bytesB.ok) {
    sideB.available = false;
    sideB.reason = bytesB.reason;
    return fail(`right artifact bytes unavailable: ${bytesB.reason}`);
  }

  const isJson = kindA === "json" || kindB === "json";
  const textA = normalizeDiffText(bytesA.bytes.toString("utf8"), isJson);
  const textB = normalizeDiffText(bytesB.bytes.toString("utf8"), isJson);
  const kind: ArtifactContentKind = isJson
    ? "json"
    : (kindA === "markdown" || kindB === "markdown")
      ? "markdown"
      : (kindA === "html" || kindB === "html")
        ? "html"
        : "text";

  if (identical || textA === textB) {
    return { a: sideA, b: sideB, diffable: true, identical: true, kind, unified: "", stats: { added: 0, removed: 0 } };
  }

  const linesA = textA.split("\n");
  const linesB = textB.split("\n");
  if (linesA.length * linesB.length > MAX_DIFF_CELLS) {
    return {
      a: sideA,
      b: sideB,
      diffable: true,
      identical: false,
      kind,
      unified: `# diff omitted: content too large for line-level diff (${linesA.length} vs ${linesB.length} lines)\n`,
      stats: null,
    };
  }

  const ops = diffLines(linesA, linesB);
  const stats = ops.reduce(
    (acc, op) => {
      if (op.tag === "+") acc.added += 1;
      if (op.tag === "-") acc.removed += 1;
      return acc;
    },
    { added: 0, removed: 0 },
  );
  const unified = formatUnifiedDiff(
    artifactFilename(artifactA) ?? sideA.artifact_id ?? refA,
    artifactFilename(artifactB) ?? sideB.artifact_id ?? refB,
    ops,
  );
  return { a: sideA, b: sideB, diffable: true, identical: false, kind, unified, stats };
}

function normalizeDiffText(text: string, isJson: boolean): string {
  const stripped = text.replace(/\r\n/g, "\n");
  if (!isJson) return stripped;
  try {
    return JSON.stringify(JSON.parse(stripped), null, 2);
  } catch {
    return stripped;
  }
}

type DiffOp = { tag: " " | "-" | "+"; text: string };

// Line-based LCS diff. Standard O(n*m) DP with backtracking; callers bound
// n*m via MAX_DIFF_CELLS before invoking.
function diffLines(a: string[], b: string[]): DiffOp[] {
  const n = a.length;
  const m = b.length;
  const width = m + 1;
  const dp = new Int32Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      dp[i * width + j] = a[i] === b[j]
        ? dp[(i + 1) * width + (j + 1)] + 1
        : Math.max(dp[(i + 1) * width + j], dp[i * width + (j + 1)]);
    }
  }
  const ops: DiffOp[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ tag: " ", text: a[i] });
      i += 1;
      j += 1;
    } else if (dp[(i + 1) * width + j] >= dp[i * width + (j + 1)]) {
      ops.push({ tag: "-", text: a[i] });
      i += 1;
    } else {
      ops.push({ tag: "+", text: b[j] });
      j += 1;
    }
  }
  while (i < n) {
    ops.push({ tag: "-", text: a[i] });
    i += 1;
  }
  while (j < m) {
    ops.push({ tag: "+", text: b[j] });
    j += 1;
  }
  return ops;
}

// Group ops into unified-diff hunks with 3 lines of context.
function formatUnifiedDiff(nameA: string, nameB: string, ops: DiffOp[], context = 3): string {
  const lines: string[] = [`--- ${nameA}`, `+++ ${nameB}`];
  const changeIdx = ops
    .map((op, idx) => (op.tag === " " ? -1 : idx))
    .filter((idx) => idx >= 0);
  if (changeIdx.length === 0) return "";

  // Compute hunk ranges (indices into ops) merged when within 2*context.
  const ranges: Array<{ start: number; end: number }> = [];
  for (const idx of changeIdx) {
    const start = Math.max(0, idx - context);
    const end = Math.min(ops.length - 1, idx + context);
    const last = ranges[ranges.length - 1];
    if (last && start <= last.end + 1) {
      last.end = Math.max(last.end, end);
    } else {
      ranges.push({ start, end });
    }
  }

  let aLine = 1;
  let bLine = 1;
  // Precompute per-op starting line numbers.
  const aStarts: number[] = [];
  const bStarts: number[] = [];
  for (const op of ops) {
    aStarts.push(aLine);
    bStarts.push(bLine);
    if (op.tag !== "+") aLine += 1;
    if (op.tag !== "-") bLine += 1;
  }

  for (const range of ranges) {
    let aCount = 0;
    let bCount = 0;
    for (let k = range.start; k <= range.end; k += 1) {
      if (ops[k].tag !== "+") aCount += 1;
      if (ops[k].tag !== "-") bCount += 1;
    }
    const aStart = aCount === 0 ? aStarts[range.start] - 1 : aStarts[range.start];
    const bStart = bCount === 0 ? bStarts[range.start] - 1 : bStarts[range.start];
    lines.push(`@@ -${aStart},${aCount} +${bStart},${bCount} @@`);
    for (let k = range.start; k <= range.end; k += 1) {
      lines.push(`${ops[k].tag}${ops[k].text}`);
    }
  }
  return `${lines.join("\n")}\n`;
}
