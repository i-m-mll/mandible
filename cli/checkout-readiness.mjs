import { execFile } from 'node:child_process';
import { lstat, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

function observe(program, args, options) {
  const { deadline, ...childOptions } = options;
  const timeout = Math.ceil(deadline - performance.now());
  if (timeout <= 0) return Promise.resolve({ status: null, stdout: '', stderr: 'Checkout readiness inspection exceeded 5000ms.' });
  return new Promise(resolve => {
    execFile(program, args, { ...childOptions, encoding: 'utf8', timeout, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      resolve({ status: error ? error.code : 0, stdout, stderr, error });
    });
  });
}

function quote(value) {
  if (!value) return "''";
  if (/[\x00-\x1f\x7f]/.test(value)) {
    return "$'" + value.replace(/[\\'\x00-\x1f\x7f]/g, char => ({ '\n': '\\n', '\r': '\\r', '\t': '\\t', "'": "\\'", '\\': '\\\\' }[char] ?? `\\${char.charCodeAt(0).toString(8).padStart(3, '0')}`)) + "'";
  }
  return value.replace(/[^a-zA-Z0-9_./-]/g, '\\$&');
}

function trackedEntries(records) {
  const entries = [];
  for (let i = 0; i < records.length; i++) {
    const record = records[i];
    const kind = record[0];
    if (!['1', '2', 'u'].includes(kind)) continue;
    const fields = kind === '1' ? 8 : kind === '2' ? 9 : 10;
    let start = 0;
    for (let n = 0; n < fields; n++) start = record.indexOf(' ', start) + 1;
    const state = record.slice(2, 4).replaceAll('.', ' ');
    const description = kind === 'u' ? 'unmerged' : state[0] !== ' ' && state[1] !== ' ' ? 'staged and unstaged' : state[0] !== ' ' ? 'staged' : 'unstaged';
    entries.push(`${description} [${state}]: ${quote(record.slice(start))}`);
    if (kind === '2') i++;
  }
  return entries;
}

/** Observe current checkout state afresh. Never retains a verdict across calls. */
export async function checkCheckoutReadiness(checkout, candidate, env = process.env) {
  const options = { cwd: checkout, env: { ...env, GIT_OPTIONAL_LOCKS: '0' }, deadline: performance.now() + 5_000 };
  const git = args => observe('git', args, options);
  const location = await git(['rev-parse', '--path-format=relative', '--show-toplevel', '--absolute-git-dir']);
  if (location.status !== 0) return { status: 'error', exitCode: 2, message: `Checkout readiness inspection failed for ${checkout}: ${location.stderr.trim() || String(location.error)}` };
  const separator = location.stdout.indexOf('\n');
  let root;
  try { root = resolve(await realpath(checkout), location.stdout.slice(0, separator)); }
  catch (error) { return { status: 'error', exitCode: 2, message: `Could not inspect checkout ${quote(checkout)}: ${error.message}` }; }
  const mergeHead = join(location.stdout.slice(separator + 1, -1), 'MERGE_HEAD');
  try {
    await lstat(mergeHead);
    return { status: 'error', exitCode: 1, message: `Checkout ${quote(root)} has a merge in progress. Resolve it separately, then refresh approval readiness.` };
  } catch (error) {
    if (error.code !== 'ENOENT') return { status: 'error', exitCode: 2, message: `Could not inspect merge state in checkout ${quote(root)}: ${error.message}` };
  }
  const status = await git(['status', '--porcelain=v2', '--branch', '-z', '--untracked-files=no', '--ignore-submodules=none']);
  if (status.status !== 0) return { status: 'error', exitCode: 2, message: `Could not inspect tracked state in checkout ${quote(root)}. This readiness check changed no checkout files.` };
  const records = status.stdout.split('\0');
  const entries = trackedEntries(records);
  if (entries.length) return { status: 'error', exitCode: 1, message: `Protected checkout ${quote(root)}: tracked worktree changes are present:\n${entries.map(entry => `  ${entry}`).join('\n')}\nCheckout blocked: ${entries.join('; ')} (checkout ${quote(root)}). Preserve the edits in their intended worktree, restore a clean checkout and refresh. This readiness check changed no checkout files.` };
  const branch = records.find(record => record.startsWith('# branch.head '))?.slice(14);
  const oid = records.find(record => record.startsWith('# branch.oid '))?.slice(13);
  if (candidate && branch === candidate.baseBranch && oid === candidate.base) {
    const sync = await git(['read-tree', '-m', '-u', '-n', candidate.base, candidate.target]);
    if (sync.status !== 0) {
      const diagnostic = await observe('bash', [fileURLToPath(new URL('./checkout-sync-check.sh', import.meta.url)), root, candidate.base, candidate.target], options);
      return { status: 'error', exitCode: 1, message: diagnostic.stdout.trim() || `Checkout ${quote(root)} cannot be synced: ${sync.stderr.trim() || String(sync.error)}` };
    }
  }
  return { status: 'clean' };
}
