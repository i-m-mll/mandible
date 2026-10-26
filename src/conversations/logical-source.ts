import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import type { FileHandle } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable, Transform, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import * as zlib from "node:zlib";


/** Provider aliases always name logical JSONL; encoding is a physical observation. */
export function canonicalSourcePath(filename: string): string {
  return isCodexLogicalSource(filename) && filename.endsWith(".zst") ? filename.slice(0, -4) : filename;
}

export function sourceRepresentationPaths(filename: string, provider?: string): string[] {
  const codex = provider === "codex" || isCodexLogicalSource(filename);
  const canonical = codex && filename.endsWith(".jsonl.zst") ? filename.slice(0, -4) : filename;
  return codex ? [canonical, `${canonical}.zst`] : [canonical];
}

/** Collision checks test logical occupancy, including non-provider restore roots. */
export function sourceRepresentationExistsSync(filename: string, provider?: string): boolean {
  for (const candidate of sourceRepresentationPaths(filename, provider)) {
    try { fs.lstatSync(candidate); return true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  return false;
}

export function isCodexLogicalSource(filename: string): boolean {
  return /[/\\]\.codex[/\\](sessions|archived_sessions)[/\\].+\.jsonl(?:\.zst)?$/.test(filename);
}

export class LogicalSourceChangedError extends Error {}

interface CachedSource {
  token: string;
  digest: string;
  size: number;
  nativeId: string;
  cacheToken: string;
}

export interface LogicalSourceOptions {
  rootPath?: string;
  cacheRoot?: string;
  maxLogicalBytes?: number;
  cacheBytes?: number;
  reserveBytes?: number;
  onDecode?: (bytes: number) => void;
}

export type LogicalSourceHandle = FileHandle & {
  readonly encoding: "raw" | "zstd";
  readonly physicalPath: string;
  readonly logicalHash: string | null;
  /** Synchronous revalidation for the final in-transaction publication guard. */
  statSync(): fs.BigIntStats;
};

const flights = new Map<string, Promise<CachedSource>>();
const leases = new Map<string, number>();
let activeDecodes = 0;
const decodeWaiters: Array<() => void> = [];
const DEFAULT_CACHE_BYTES = 2 * 1024 ** 3;
const DEFAULT_MAX_LOGICAL_BYTES = 1024 ** 3;
const DEFAULT_RESERVE_BYTES = 256 * 1024 ** 2;

function processAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
}

/** The daemon and ingestion workers share one disk budget and cold decode lane. */
async function withCacheWriter<T>(root: string, run: () => Promise<T>): Promise<T> {
  const lock = path.join(root, ".writer");
  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      await fs.promises.mkdir(lock, { mode: 0o700 });
      await fs.promises.writeFile(path.join(lock, "owner"), String(process.pid), { mode: 0o600 });
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const owner = Number(await fs.promises.readFile(path.join(lock, "owner"), "utf8").catch(() => "0"));
      if (owner > 0 && !processAlive(owner)) {
        const reap = path.join(lock, "reap");
        try {
          const claim = await fs.promises.open(reap, "wx", 0o600);
          await claim.close();
          const currentOwner = Number(await fs.promises.readFile(path.join(lock, "owner"), "utf8"));
          if (currentOwner === owner && !processAlive(owner)) await fs.promises.rm(lock, { recursive: true, force: true });
          else await fs.promises.unlink(reap);
        } catch (error) {
          if (!["EEXIST", "ENOENT"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
        }
        continue;
      }
      if (Date.now() >= deadline) throw new Error("logical source cache writer timed out");
      await new Promise<void>((resolve, reject) => {
        const watcher = fs.watch(root, () => { clearTimeout(timer); watcher.close(); resolve(); });
        const timer = setTimeout(() => { watcher.close(); resolve(); }, 100);
        watcher.once("error", (error) => { clearTimeout(timer); watcher.close(); reject(error); });
      });
    }
  }
  try {
    for (const name of await fs.promises.readdir(root)) {
      if (name.startsWith(".decode-") || name.endsWith(".tmp")) await fs.promises.unlink(path.join(root, name));
    }
    return await run();
  }
  finally { await fs.promises.rm(lock, { recursive: true, force: true }); }
}

async function decodeSlot<T>(run: () => Promise<T>): Promise<T> {
  if (activeDecodes >= 2) await new Promise<void>((resolve) => decodeWaiters.push(resolve));
  else activeDecodes++;
  try { return await run(); }
  finally {
    const next = decodeWaiters.shift();
    if (next) next();
    else activeDecodes--;
  }
}

function token(stat: fs.BigIntStats): string {
  return [stat.dev, stat.ino, stat.size, stat.ctimeNs, stat.mtimeNs].join(":");
}

function inside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

async function selectedPath(filename: string): Promise<string> {
  const candidates = sourceRepresentationPaths(filename);
  for (const candidate of candidates) {
    try { await fs.promises.lstat(candidate); return candidate; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  return candidates[candidates.length - 1];
}

async function openProvider(filename: string, declaredRoot?: string): Promise<{ handle: FileHandle; physicalPath: string }> {
  const physicalPath = await selectedPath(filename);
  const canonical = path.resolve(canonicalSourcePath(filename));
  const providerRoot = isCodexLogicalSource(canonical)
    ? canonical.match(/^(.*[/\\]\.codex[/\\](?:sessions|archived_sessions))[/\\]/)![1]
    : path.dirname(canonical);
  const root = path.resolve(declaredRoot ?? providerRoot);
  if (!inside(root, canonical)) throw new Error("conversation source escapes its declared root");
  const [realRoot, realParent] = await Promise.all([
    fs.promises.realpath(root), fs.promises.realpath(path.dirname(physicalPath)),
  ]);
  if (!inside(realRoot, realParent)) throw new Error("conversation source escaped through a symlink");
  if ((await fs.promises.lstat(physicalPath)).isSymbolicLink()) throw new Error(`symlink source rejected: ${physicalPath}`);
  const handle = await fs.promises.open(physicalPath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  if (!(await handle.stat()).isFile()) {
    await handle.close();
    throw new Error("conversation source is not a regular file");
  }
  return { handle, physicalPath };
}

async function cacheRoom(root: string, required: number, options: LogicalSourceOptions): Promise<void> {
  const quota = options.cacheBytes ?? DEFAULT_CACHE_BYTES;
  if (required > quota) throw new Error("logical source exceeds seekable cache quota");
  const names = await fs.promises.readdir(root);
  const held = new Set<string>();
  for (const name of names) {
    const match = name.match(/^\.lease-([a-f0-9]{64})-(\d+)-/);
    if (!match) continue;
    if (processAlive(Number(match[2]))) held.add(path.join(root, `${match[1]}.jsonl`));
    else await fs.promises.unlink(path.join(root, name)).catch((error) => {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    });
  }
  const files = (await Promise.all(names
    .filter((name) => /^[a-f0-9]{64}\.jsonl$/.test(name))
    .map(async (name) => {
      const filename = path.join(root, name);
      return { filename, stat: await fs.promises.stat(filename).catch(() => null) };
    }))).filter((entry) => entry.stat !== null);
  let used = files.reduce((sum, entry) => sum + entry.stat!.size, 0);
  for (const entry of files.sort((a, b) => a.stat!.mtimeMs - b.stat!.mtimeMs)) {
    if (used + required <= quota) break;
    if (leases.get(entry.filename) || held.has(entry.filename)) continue;
    await fs.promises.unlink(entry.filename).catch((error) => {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    });
    used -= entry.stat!.size;
  }
  if (used + required > quota) throw new Error("seekable cache quota is occupied by active readers");
  const space = await fs.promises.statfs(root, { bigint: true });
  if (space.bavail * space.bsize < BigInt(required + (options.reserveBytes ?? DEFAULT_RESERVE_BYTES))) {
    throw new Error("insufficient free space for logical source cache");
  }
}

async function decode(
  provider: FileHandle, physicalPath: string, before: fs.BigIntStats,
  root: string, manifest: string, options: LogicalSourceOptions,
): Promise<CachedSource> {
  const temporary = path.join(root, `.decode-${process.pid}-${randomUUID()}`);
  const output = await fs.promises.open(temporary, "wx", 0o600);
  let size = 0;
  let header = Buffer.alloc(0);
  const hash = createHash("sha256");
  const limit = Math.min(options.maxLogicalBytes ?? DEFAULT_MAX_LOGICAL_BYTES, options.cacheBytes ?? DEFAULT_CACHE_BYTES);
  try {
    await cacheRoom(root, limit, options);
    const meter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        size += chunk.length;
        if (size > limit) { callback(new Error("decoded source exceeds logical byte budget")); return; }
        hash.update(chunk);
        if (header.length < 256 * 1024 && header.indexOf(0x0a) < 0) {
          header = Buffer.concat([header, chunk.subarray(0, 256 * 1024 - header.length)]);
        }
        options.onDecode?.(chunk.length);
        // The up-front reservation bounds disk use even for highly compressed frames.
        callback(null, chunk);
      },
    });
    const createZstdDecompress = (zlib as typeof zlib & { createZstdDecompress: () => Transform }).createZstdDecompress;
    await pipeline(provider.createReadStream({ autoClose: false }), createZstdDecompress(), meter,
      new Writable({
        write(chunk: Buffer, _encoding, callback) {
          output.writeFile(chunk).then(() => callback(), callback);
        },
      }));
    const after = await provider.stat({ bigint: true });
    const current = await fs.promises.lstat(physicalPath, { bigint: true });
    if (token(before) !== token(after) || token(before) !== token(current)
        || await selectedPath(canonicalSourcePath(physicalPath)) !== physicalPath) {
      throw new LogicalSourceChangedError("compressed provider source changed during decode");
    }
    const firstLine = header.subarray(0, header.indexOf(0x0a) < 0 ? header.length : header.indexOf(0x0a)).toString("utf8");
    const record = JSON.parse(firstLine) as { type?: string; payload?: { id?: string } };
    if (record.type !== "session_meta" || typeof record.payload?.id !== "string" || !record.payload.id.trim()) {
      throw new Error("compressed Codex rollout has no native session identity");
    }
    const entry: CachedSource = { token: token(before), digest: hash.digest("hex"), size, nativeId: record.payload.id, cacheToken: "" };
    await output.sync();
    await output.chmod(0o400);
    const destination = path.join(root, `${entry.digest}.jsonl`);
    await fs.promises.rename(temporary, destination);
    entry.cacheToken = token(await fs.promises.stat(destination, { bigint: true }));
    const manifestTemp = `${manifest}.${randomUUID()}.tmp`;
    await fs.promises.writeFile(manifestTemp, JSON.stringify(entry), { flag: "wx", mode: 0o600 });
    await fs.promises.rename(manifestTemp, manifest);
    return entry;
  } finally {
    await output.close();
    await fs.promises.unlink(temporary).catch((error) => {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    });
  }
}

/** Open seekable logical bytes, keeping the provider descriptor as authority for the lease. */
export async function openLogicalSource(filename: string, options: LogicalSourceOptions = {}): Promise<LogicalSourceHandle> {
  const { handle: provider, physicalPath } = await openProvider(filename, options.rootPath);
  const before = await provider.stat({ bigint: true });
  let reader = provider;
  let cachePath: string | null = null;
  let leasePath: string | null = null;
  let entry: CachedSource | null = null;
  try {
    const compressed = physicalPath !== canonicalSourcePath(physicalPath);
    if (compressed) {
      const root = options.cacheRoot ?? path.join(process.env.XDG_CACHE_HOME ?? path.join(process.env.HOME || os.homedir(), ".cache"), "mandible", "logical-sources");
      await fs.promises.mkdir(root, { recursive: true, mode: 0o700 });
      await fs.promises.chmod(root, 0o700);
      const key = createHash("sha256").update(`${physicalPath}\0${token(before)}`).digest("hex");
      const manifest = path.join(root, `${createHash("sha256").update(physicalPath).digest("hex")}.json`);
      const flightKey = `${root}/${key}`;
      const cachedSource = async (): Promise<CachedSource | null> => {
        try {
          const cached = JSON.parse(await fs.promises.readFile(manifest, "utf8")) as CachedSource;
          if (cached.token === token(before) && /^[a-f0-9]{64}$/.test(cached.digest)
              && token(await fs.promises.stat(path.join(root, `${cached.digest}.jsonl`), { bigint: true })) === cached.cacheToken) return cached;
        } catch (error) {
          if (!(error instanceof SyntaxError) && (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        return null;
      };
      let flight = flights.get(flightKey);
      if (!flight) {
        flight = (async () => await cachedSource() ?? withCacheWriter(root, async () =>
          await cachedSource() ?? decodeSlot(() => decode(provider, physicalPath, before, root, manifest, options))))();
        flights.set(flightKey, flight);
        void flight.finally(() => flights.delete(flightKey)).catch(() => {});
      }
      entry = await flight;
      if (entry.size > (options.maxLogicalBytes ?? DEFAULT_MAX_LOGICAL_BYTES)) throw new Error("decoded source exceeds logical byte budget");
      const acquire = async () => {
        const candidate = path.join(root, `${entry!.digest}.jsonl`);
        reader = await fs.promises.open(candidate, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
        cachePath = candidate;
        leases.set(candidate, (leases.get(candidate) ?? 0) + 1);
        leasePath = path.join(root, `.lease-${entry!.digest}-${process.pid}-${randomUUID()}`);
        await fs.promises.writeFile(leasePath, "", { flag: "wx", mode: 0o600 });
      };
      try { await acquire(); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT" || reader !== provider) throw error;
        // An unleased cache entry may disappear after lookup. Retry publication
        // and acquire its descriptor/lease within the eviction writer protocol.
        await withCacheWriter(root, async () => {
          entry = await cachedSource() ?? await decodeSlot(() => decode(provider, physicalPath, before, root, manifest, options));
          await acquire();
        });
      }
    }
    let closed = false;
    const logicalStat = async (statOptions?: { bigint?: boolean }) => {
      const observed = await provider.stat({ bigint: true });
      const currentPath = await selectedPath(filename);
      const current = await fs.promises.lstat(currentPath, { bigint: true });
      if (currentPath !== physicalPath || current.dev !== before.dev || current.ino !== before.ino
          || (compressed && (token(observed) !== token(before) || token(current) !== token(before)))) {
        throw new LogicalSourceChangedError("provider source changed during logical read");
      }
      const stat = statOptions?.bigint ? observed : await provider.stat();
      return entry ? Object.assign(Object.create(Object.getPrototypeOf(stat)), stat,
        { size: statOptions?.bigint ? BigInt(entry.size) : entry.size }) : stat;
    };
    await logicalStat();
    return new Proxy(reader, {
      get(target, property) {
        if (property === "encoding") return compressed ? "zstd" : "raw";
        if (property === "physicalPath") return physicalPath;
        if (property === "logicalHash") return entry?.digest ?? null;
        if (property === "statSync") return () => {
          const candidates = sourceRepresentationPaths(filename);
          let selected = candidates[candidates.length - 1];
          for (const candidate of candidates) {
            try { fs.lstatSync(candidate); selected = candidate; break; }
            catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
          }
          const observed = fs.fstatSync(provider.fd, { bigint: true });
          const current = fs.lstatSync(selected, { bigint: true });
          if (selected !== physicalPath || current.dev !== before.dev || current.ino !== before.ino
              || (compressed && (token(observed) !== token(before) || token(current) !== token(before)))) {
            throw new LogicalSourceChangedError("provider source changed during logical read");
          }
          return entry ? Object.assign(Object.create(Object.getPrototypeOf(observed)), observed, { size: BigInt(entry.size) }) : observed;
        };
        if (property === "stat") return logicalStat;
        if (property === "close") return async () => {
          if (closed) return;
          closed = true;
          try { if (reader !== provider) await reader.close(); }
          finally {
            if (cachePath) leases.set(cachePath, Math.max(0, (leases.get(cachePath) ?? 1) - 1));
            if (leasePath) await fs.promises.unlink(leasePath);
            await provider.close();
          }
        };
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as LogicalSourceHandle;
  } catch (error) {
    if (reader !== provider) await reader.close();
    if (cachePath) leases.set(cachePath, Math.max(0, (leases.get(cachePath) ?? 1) - 1));
    if (leasePath) await fs.promises.unlink(leasePath);
    await provider.close();
    throw error;
  }
}

export async function logicalSourceStat(filename: string): Promise<fs.Stats & { physicalGeneration: { device: string; inode: string; ctimeNs: string } }> {
  const handle = await openLogicalSource(filename);
  try {
    const exact = await handle.stat({ bigint: true });
    return Object.assign(await handle.stat(), { physicalGeneration: {
      device: String(exact.dev), inode: String(exact.ino), ctimeNs: String(exact.ctimeNs),
    } });
  }
  finally { await handle.close(); }
}

export async function logicalSourceExists(filename: string): Promise<boolean> {
  try { const { handle } = await openProvider(filename); await handle.close(); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}

/** Physical metadata and unsealed prefixes are for discovery only, never content proof. */
export async function inspectSourceRepresentation(filename: string): Promise<{
  path: string; physicalPath: string; size: number; mtimeMs: number;
  physicalGeneration: { device: string; inode: string; ctimeNs: string };
}> {
  const { handle, physicalPath } = await openProvider(filename);
  try {
    const stat = await handle.stat({ bigint: true });
    return { path: canonicalSourcePath(filename), physicalPath, size: Number(stat.size), mtimeMs: Number(stat.mtimeNs) / 1_000_000,
      physicalGeneration: { device: String(stat.dev), inode: String(stat.ino), ctimeNs: String(stat.ctimeNs) } };
  } finally { await handle.close(); }
}

export async function readLogicalSourcePrefix(filename: string, maxBytes = 256 * 1024): Promise<Buffer> {
  const { handle, physicalPath } = await openProvider(filename);
  try {
    const before = await handle.stat({ bigint: true });
    const source = Readable.from((async function* () {
      let offset = 0;
      while (offset < Number(before.size)) {
        const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, Number(before.size) - offset));
        const { bytesRead } = await handle.read(chunk, 0, chunk.length, offset);
        if (!bytesRead) break;
        offset += bytesRead;
        yield chunk.subarray(0, bytesRead);
      }
    })());
    const createZstdDecompress = (zlib as typeof zlib & { createZstdDecompress: () => Transform }).createZstdDecompress;
    const input = physicalPath.endsWith(".zst") ? source.pipe(createZstdDecompress()) : source;
    if (input !== source) source.on("error", (error) => input.destroy(error));
    const chunks: Buffer[] = [];
    let size = 0;
    try {
      for await (const chunk of input) {
        const bytes = (chunk as Buffer).subarray(0, maxBytes - size);
        chunks.push(bytes);
        size += bytes.length;
        if (size === maxBytes) break;
      }
    } finally { input.destroy(); source.destroy(); }
    if (token(before) !== token(await handle.stat({ bigint: true }))) {
      throw new LogicalSourceChangedError("provider changed during prefix read");
    }
    return Buffer.concat(chunks, size);
  } finally { await handle.close(); }
}

export async function* discoverLogicalSources(root: string): AsyncGenerator<string> {
  const seen = new Set<string>();
  async function* walk(directory: string): AsyncGenerator<string> {
    const entries = await fs.promises.readdir(directory, { withFileTypes: true }).catch((error) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    });
    for (const entry of entries) {
      const filename = path.join(directory, entry.name);
      if (entry.isDirectory()) yield* walk(filename);
      else if (entry.isFile() && /\.jsonl(?:\.zst)?$/.test(filename)) {
        const canonical = canonicalSourcePath(filename);
        if (!seen.has(canonical)) { seen.add(canonical); yield canonical; }
      }
    }
  }
  yield* walk(root);
}
