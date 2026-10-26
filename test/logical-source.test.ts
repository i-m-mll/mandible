import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import * as zlib from "node:zlib";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  discoverLogicalSources, openLogicalSource, readLogicalSourcePrefix,
} from "../src/conversations/logical-source.js";

const zstd = zlib as typeof zlib & {
  zstdCompressSync: (bytes: Buffer) => Buffer;
  createZstdCompress: () => Transform;
};
let root: string;
let source: string;
let cacheRoot: string;
const header = Buffer.from('{"type":"session_meta","payload":{"id":"native-session"}}\n');

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-logical-source-"));
  source = path.join(root, ".codex", "sessions", "rollout-a.jsonl");
  cacheRoot = path.join(root, "cache");
  fs.mkdirSync(path.dirname(source), { recursive: true });
});
afterEach(() => { vi.restoreAllMocks(); fs.rmSync(root, { recursive: true, force: true }); });

it("resolves representations once, keeps raw precedence, and never serves a cache without its current provider", async () => {
  fs.writeFileSync(`${source}.zst`, zstd.zstdCompressSync(header));
  expect(await Array.fromAsync(discoverLogicalSources(path.dirname(source)))).toEqual([source]);
  const first = await openLogicalSource(source, { cacheRoot, reserveBytes: 0 });
  expect((await first.stat()).size).toBe(header.length);
  expect(await first.readFile()).toEqual(header);
  await first.close();
  fs.writeFileSync(source, "raw wins, including invalid provider bytes");
  expect(await Array.fromAsync(discoverLogicalSources(path.dirname(source)))).toEqual([source]);
  const raw = await openLogicalSource(`${source}.zst`, { cacheRoot });
  expect(raw.encoding).toBe("raw");
  expect(await raw.readFile("utf8")).toContain("raw wins");
  await raw.close();
  fs.unlinkSync(source);
  const changed = Buffer.from(header.toString().replace("native-session", "replacement-session"));
  fs.writeFileSync(`${source}.zst`, zstd.zstdCompressSync(changed));
  const replacement = await openLogicalSource(source, { cacheRoot, reserveBytes: 0 });
  expect(await replacement.readFile()).toEqual(changed);
  await replacement.close();
  fs.unlinkSync(`${source}.zst`);
  await expect(openLogicalSource(source, { cacheRoot })).rejects.toThrow();
});

it("rejects corrupt frames, invalid native headers, mutation during decode, and escaped provider paths", async () => {
  const compressed = zstd.zstdCompressSync(header);
  for (const bytes of [compressed.subarray(0, compressed.length - 3), Buffer.from("corrupt"), zstd.zstdCompressSync(Buffer.from('{"type":"event_msg"}\n'))]) {
    fs.writeFileSync(`${source}.zst`, bytes);
    await expect(openLogicalSource(source, { cacheRoot, reserveBytes: 0 })).rejects.toThrow();
  }
  fs.writeFileSync(`${source}.zst`, compressed);
  let mutated = false;
  await expect(openLogicalSource(source, { cacheRoot, reserveBytes: 0, onDecode() {
    if (!mutated) { mutated = true; fs.appendFileSync(`${source}.zst`, "changed"); }
  } })).rejects.toThrow();
  fs.unlinkSync(`${source}.zst`);
  const outside = path.join(root, "outside.zst");
  fs.writeFileSync(outside, compressed);
  fs.symlinkSync(outside, `${source}.zst`);
  await expect(openLogicalSource(source, { cacheRoot })).rejects.toThrow();
});

it("keeps active cache leases while enforcing output and disk quotas", async () => {
  fs.writeFileSync(`${source}.zst`, zstd.zstdCompressSync(header));
  const options = { cacheRoot, reserveBytes: 0, cacheBytes: header.length * 2, maxLogicalBytes: header.length };
  const first = await openLogicalSource(source, options);
  const other = source.replace("-a", "-b");
  fs.writeFileSync(`${other}.zst`, zstd.zstdCompressSync(Buffer.from(header.toString().replace("native", "second"))));
  const second = await openLogicalSource(other, options);
  expect(await first.readFile()).toEqual(header);
  const third = source.replace("-a", "-c");
  fs.writeFileSync(`${third}.zst`, zstd.zstdCompressSync(Buffer.from(header.toString().replace("native", "third-"))));
  await expect(openLogicalSource(third, options)).rejects.toThrow(/quota/);
  await first.close();
  const evicted = await openLogicalSource(third, options);
  await evicted.close();
  await second.close();
  await expect(openLogicalSource(source, { ...options, maxLogicalBytes: 5 })).rejects.toThrow(/budget|quota/);
});

it("shares a cold decode and disk budget between daemon and ingestion processes", async () => {
  fs.writeFileSync(`${source}.zst`, zstd.zstdCompressSync(header));
  const script = `import {openLogicalSource} from ${JSON.stringify(path.resolve("src/conversations/logical-source.ts"))};
    let bytes=0;
    const handle=await openLogicalSource(${JSON.stringify(source)}, {cacheRoot:${JSON.stringify(cacheRoot)},reserveBytes:0,onDecode(n){bytes+=n;}});
    await handle.close(); console.log(bytes);`;
  const run = () => promisify(execFile)(process.env.MANDIBLE_RUNTIME!, ["--eval", script], { timeout: 10_000 });
  const results = await Promise.all([run(), run()]);
  expect(results.reduce((total, result) => total + Number(result.stdout.trim()), 0)).toBe(header.length);
});

it.each(["warm", "cold"])("acquires a readable %s source when another process evicts it before its lease", async (state) => {
  fs.writeFileSync(`${source}.zst`, zstd.zstdCompressSync(header));
  const options = { cacheRoot, reserveBytes: 0, cacheBytes: header.length, maxLogicalBytes: header.length };
  if (state === "warm") {
    const warm = await openLogicalSource(source, options);
    await warm.close();
  }
  let paused!: () => void;
  const pause = new Promise<void>((resolve) => { paused = resolve; });
  let resume!: () => void;
  const barrier = new Promise<void>((resolve) => { resume = resolve; });
  let intercepted = false;
  const actualOpen = fs.promises.open.bind(fs.promises);
  vi.spyOn(fs.promises, "open").mockImplementation(async (...args) => {
    if (!intercepted && String(args[0]).startsWith(`${cacheRoot}${path.sep}`) && String(args[0]).endsWith(".jsonl")) {
      intercepted = true; paused(); await barrier;
    }
    return actualOpen(...args);
  });
  const pending = openLogicalSource(source, options);
  await pause;
  const other = source.replace("-a", "-b");
  fs.writeFileSync(`${other}.zst`, zstd.zstdCompressSync(Buffer.from(header.toString().replace("native", "second"))));
  const script = `import {openLogicalSource} from ${JSON.stringify(path.resolve("src/conversations/logical-source.ts"))};
    const h=await openLogicalSource(${JSON.stringify(other)},${JSON.stringify(options)}); await h.close();`;
  try { await promisify(execFile)(process.env.MANDIBLE_RUNTIME!, ["--eval", script], { timeout: 10_000 }); }
  finally { resume(); }
  const acquired = await pending;
  expect(await acquired.readFile()).toEqual(header);
  await acquired.close();
});

it("serves native inventory and raw-path inspection through bounded prefixes with raw precedence", async () => {
  fs.writeFileSync(`${source}.zst`, zstd.zstdCompressSync(header));
  fs.writeFileSync(source, header.toString().replace("native-session", "raw-session"));
  const older = source.replace("-a", "-older");
  fs.writeFileSync(`${older}.zst`, "invalid frame that inventory must not decode before its limit");
  fs.utimesSync(`${older}.zst`, new Date(0), new Date(0));
  const run = async (...args: string[]) => JSON.parse((await promisify(execFile)(process.env.MANDIBLE_RUNTIME!,
    [path.resolve("src/cli/logical-sources.ts"), ...args], { timeout: 10_000, env: { ...process.env, HOME: root } })).stdout);
  const inventory = await run("inventory", "0", "1");
  expect(inventory).toHaveLength(1);
  expect(inventory[0]).toMatchObject({ path: source, session_id: "raw-session" });
  fs.unlinkSync(source);
  expect(await run("find", source)).toBe(source);
  expect(await run("head", source, "1")).toEqual([JSON.parse(header.toString())]);
});

it("accepts a native missing-source catalog larger than the OS argument limit through stdin", async () => {
  fs.writeFileSync(`${source}.zst`, zstd.zstdCompressSync(header));
  const indexed = [source, ...Array.from({ length: 20_000 }, (_, index) => `/tmp/${"catalog-path/".repeat(9)}${index}.jsonl`)];
  const input = JSON.stringify(indexed);
  expect(Buffer.byteLength(input)).toBeGreaterThan(2 * 1024 ** 2);
  const output = await new Promise<string>((resolve, reject) => {
    const child = spawn(process.env.MANDIBLE_RUNTIME!, [path.resolve("src/cli/logical-sources.ts"), "missing"],
      { env: { ...process.env, HOME: root }, timeout: 10_000, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code) => code === 0 ? resolve(stdout) : reject(new Error(stderr)));
    child.stdin.end(input);
  });
  expect(JSON.parse(output)).toEqual([]);
});

it("streams a 211MB cold rollout once for concurrent readers and seeks warm tail bytes without decoding again", async () => {
  const row = Buffer.from(`{"type":"response_item","payload":{"type":"function_call_output","call_id":"tool-1","output":"${"x".repeat(64 * 1024)}"}}\n`);
  const repetitions = Math.ceil(211_450_789 / row.length);
  const tail = Buffer.from('{"type":"event_msg","payload":{"message":"final record"}}\n');
  const logicalLength = header.length + repetitions * row.length + tail.length;
  await pipeline(Readable.from((async function* () {
    yield header;
    for (let i = 0; i < repetitions; i++) yield row;
    yield tail;
  })()), zstd.createZstdCompress(), fs.createWriteStream(`${source}.zst`));
  let decoded = 0;
  let turns = 0;
  let watching = true;
  let peakRss = process.memoryUsage().rss;
  const initialRss = peakRss;
  const tick = () => { if (watching) { turns++; setImmediate(tick); } };
  setImmediate(tick);
  const options = { cacheRoot, reserveBytes: 0, cacheBytes: 400 * 1024 ** 2,
    maxLogicalBytes: 300 * 1024 ** 2,
    onDecode(bytes: number) { decoded += bytes; peakRss = Math.max(peakRss, process.memoryUsage().rss); } };
  const handles = await Promise.all(Array.from({ length: 4 }, () => openLogicalSource(source, options)));
  watching = false;
  expect(decoded).toBe(logicalLength);
  expect(turns).toBeGreaterThan(2);
  expect(peakRss - initialRss).toBeLessThan(128 * 1024 ** 2);
  await Promise.all(handles.map((handle) => handle.close()));
  const warm = await openLogicalSource(source, options);
  const bytes = Buffer.alloc(tail.length);
  await warm.read(bytes, 0, bytes.length, logicalLength - bytes.length);
  expect(bytes).toEqual(tail);
  expect(decoded).toBe(logicalLength);
  await warm.close();
  expect((await readLogicalSourcePrefix(source, header.length)).toString()).toBe(header.toString());
  console.info("logical-source performance", { logicalLength, decoded, peakRssDelta: peakRss - initialRss, eventLoopTurns: turns });
}, 30_000);
