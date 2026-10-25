import { createHash } from "node:crypto";
import { execFile, execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { Db } from "./db.js";
import { resolveProjectRef } from "./ledger/project-registry.js";

function runGit(cwd: string, args: string[]): string | null {
  try {
    return execFileSync("git", ["-C", cwd, ...args], {
      encoding: "utf8",
      timeout: 15_000,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

export interface CommittedArtifactFile {
  project_id: string;
  project_key: string;
  commit: string;
  path: string;
  bytes: Buffer;
}

/** Resolve the ref once, then read all requested blobs without touching the checkout. */
export function readCommittedArtifactFiles(db: Db, input: {
  project?: string; cwd?: string; commit: string; paths: string[];
}): CommittedArtifactFile[] {
  return readCommittedSource(db, input).files;
}

interface GitRead { root: string; args: string[]; input?: string; allowFailure?: boolean }
type CommittedSource = { root: string; files: CommittedArtifactFile[] };

function executeGitRead(command: GitRead): Promise<Buffer | null> {
  return new Promise((resolve, reject) => {
    const child = execFile('git', ['--no-optional-locks', '-C', command.root, ...command.args], {
      encoding: 'buffer', timeout: 15_000, maxBuffer: 128 * 1024 * 1024,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
    }, (error, stdout) => {
      if (error) { if (command.allowFailure) resolve(null); else reject(error); }
      else resolve(stdout);
    });
    child.stdin?.on('error', () => undefined);
    child.stdin?.end(command.input ?? '');
  });
}

/** Daemon reads yield while Git resolves the ref and returns the committed blobs. */
export async function readCommittedArtifactFilesAsync(db: Db, input: {
  project?: string; cwd?: string; commit: string; paths: string[];
}): Promise<CommittedArtifactFile[]> {
  const reads = committedSourceReads(db, input);
  let step = reads.next();
  while (!step.done) step = reads.next(await executeGitRead(step.value));
  return step.value.files;
}

function readCommittedSource(db: Db, input: {
  project?: string; cwd?: string; commit: string; paths: string[];
}): CommittedSource {
  const reads = committedSourceReads(db, input);
  let step = reads.next();
  while (!step.done) {
    const command = step.value;
    let output: Buffer | null;
    try {
      output = execFileSync('git', ['--no-optional-locks', '-C', command.root, ...command.args], {
        input: command.input, timeout: 15_000, maxBuffer: 128 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (error) { if (!command.allowFailure) throw error; output = null; }
    step = reads.next(output);
  }
  return step.value;
}

function* committedSourceReads(db: Db, input: {
  project?: string; cwd?: string; commit: string; paths: string[];
}): Generator<GitRead, CommittedSource, Buffer | null> {
  if (typeof input.commit !== 'string' || !input.commit.trim()) throw new Error('A nonempty commit ref is required');
  const repo = resolveProjectRef(db, input.project ?? path.resolve(input.cwd ?? process.cwd()));
  if (!repo.ok) throw new Error(`Committed source repository is ${repo.reason}`);
  const roots = repo.project.checkouts.map(checkout => checkout.root);
  let root: string | undefined;
  let commit: string | null = null;
  for (const candidate of roots) {
    if (!fs.existsSync(candidate)) continue;
    commit = (yield { root: candidate, args: ['rev-parse', '--verify', '--end-of-options', `${input.commit}^{commit}`], allowFailure: true })?.toString().trim() ?? null;
    if (commit) { root = candidate; break; }
  }
  if (!root || !commit) throw new Error('Committed source requires an available registered repository object store');
  const resolvedRoot = root;
  const resolvedCommit = commit;
  const paths = input.paths.map(p => {
    const relative = p;
    if (path.isAbsolute(relative)) throw new Error('Committed paths must be repository-relative');
    if (!relative || relative.includes('\\') || relative.includes('\n') || relative.includes('\0')
      || relative.split('/').some(part => !part || part === '.' || part === '..')) throw new Error('Committed paths must be normalized repository-relative paths');
    return relative;
  });
  const tree = (yield { root: resolvedRoot, args: ['--literal-pathspecs', 'ls-tree', '-rz', resolvedCommit, '--', ...paths] })!.toString();
  const entries = new Map(tree.split('\0').filter(Boolean).map(entry => {
    const match = /^(\d+) (\w+) ([a-f0-9]+)\t([\s\S]+)$/.exec(entry)!;
    return [match[4], { mode: match[1], type: match[2], oid: match[3] }];
  }));
  const ids = paths.map(p => {
    const entry = entries.get(p);
    if (!entry || entry.type !== 'blob' || !['100644', '100755'].includes(entry.mode)) throw new Error(`Not a tracked regular file at ${resolvedCommit}: ${p}`);
    return entry.oid;
  });
  const output = (yield { root: resolvedRoot, args: ['cat-file', '--batch'], input: ids.join('\n') + '\n' })!;
  let offset = 0;
  const files = paths.map((p, i) => {
    const end = output.indexOf(10, offset);
    const header = output.subarray(offset, end).toString().split(' ');
    const size = Number(header[2]);
    if (header[0] !== ids[i] || header[1] !== 'blob' || !Number.isSafeInteger(size) || size < 0) throw new Error('Invalid Git blob response');
    const bytes = output.subarray(end + 1, end + 1 + size);
    if (bytes.length !== size) throw new Error('Truncated Git blob response');
    offset = end + size + 2;
    return { project_id: repo.project.id, project_key: repo.project.project_key, commit: resolvedCommit, path: p, bytes };
  });
  return { root: resolvedRoot, files };
}

/** Pin a verified committed source against branch removal and ordinary Git GC. */
export function retainArtifactCommit(db: Db, input: {
  project: string; commit: string; path: string; sha256: string;
}): string {
  const { root, files: [file] } = readCommittedSource(db, {project:input.project,commit:input.commit,paths:[input.path]});
  if (createHash('sha256').update(file.bytes).digest('hex') !== input.sha256) throw new Error('Git artifact bytes do not match registered sha256');
  const ref = `refs/mandible/artifacts/${file.commit}`;
  if (runGit(root,['symbolic-ref','-q',ref])) throw new Error('Artifact retention ref must not be symbolic');
  const existing=runGit(root,['rev-parse','--verify',ref]);
  if (existing && existing !== file.commit) throw new Error('Artifact retention ref points to an unexpected commit');
  execFileSync('git',['--no-optional-locks','-C',root,'update-ref','--no-deref',ref,file.commit,existing ?? '0'.repeat(file.commit.length)],{timeout:15000,stdio:['ignore','pipe','pipe']});
  return ref;
}
