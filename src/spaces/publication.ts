import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import type { Db } from '../db.js';
import { resolveOperationalIssueRef } from '../ledger/operational-links.js';
import { createSpace, getSpace } from '../ledger/spaces.js';
import { createSpaceBlock } from '../ledger/space-blocks.js';
import { resolveArtifactIdentity, recordArtifactVersion } from '../provider-artifacts.js';
import { artifactMaterializationTarget } from '../artifact-identity.js';
import { readArtifactMaterial } from '../artifact-materialization.js';
import { importDocument } from './serialize.js';
import { ExportError, getProjectCheckout, normalizeRepoRelativePath, resolveCheckoutForSpace, serializeSpaceDocument } from './export.js';

export type SpacePublication = {
  id: string; space_id: string; source_revision: string; snapshot_ref: string; content: string;
  repo_id: string; path: string; expected_destination_sha256: string | null; issue_id: string; message: string;
  branch: string | null; worktree: string | null; commit_sha: string | null; version_ref: string | null;
  auth_request_id: string | null; state: 'prepared' | 'committed' | 'submitted'; created_at: number;
};
const hash = (bytes: string | Buffer): string => crypto.createHash('sha256').update(bytes).digest('hex');
function destinationHash(root: string, relative: string): string | null {
  const absolute = path.join(root, relative);
  let parent = path.dirname(absolute);
  while (!fs.existsSync(parent)) parent = path.dirname(parent);
  const actual = fs.realpathSync(parent), canonical = fs.realpathSync(root);
  if (actual !== canonical && !actual.startsWith(`${canonical}${path.sep}`)) throw new ExportError('invalid_path', 'Destination escapes the checkout through a symbolic link');
  if (!fs.existsSync(absolute)) return null;
  if (fs.lstatSync(absolute).isSymbolicLink()) throw new ExportError('invalid_path', 'Destination must not be a symbolic link');
  return hash(fs.readFileSync(absolute));
}
export function listPublications(db: Db, spaceId: string): SpacePublication[] {
  return db.prepare('SELECT * FROM space_publications WHERE space_id=? ORDER BY created_at DESC,id').all(spaceId) as SpacePublication[];
}
export function getPublication(db: Db, spaceId: string, id: string): SpacePublication {
  const value = db.prepare('SELECT * FROM space_publications WHERE space_id=? AND id=?').get(spaceId,id) as SpacePublication | undefined;
  if (!value) throw new ExportError('invalid_publication','Publication not found');
  return value;
}
export function preparePublication(db: Db, input: { spaceId: string; repoId?: string | null; path: string; issue: string; message?: string }): SpacePublication {
  const space = getSpace(db,input.spaceId);
  if (!space) throw new ExportError('space_not_found','Space not found');
  const checkout = resolveCheckoutForSpace(db,space,input.repoId);
  const issue = resolveOperationalIssueRef(db,input.issue,checkout.project_id);
  if (!issue.ok) throw new ExportError('invalid_issue','Publication requires an issue in the destination project');
  const relative = normalizeRepoRelativePath(input.path);
  if (relative === '.' || relative.startsWith('.git/') || relative === '.git') throw new ExportError('invalid_path','Invalid document destination');
  const expected = destinationHash(checkout.root,relative);
  const content = serializeSpaceDocument(db,space.id);
  const snapshot = recordArtifactVersion(db, {
    content, source_kind: 'managed', custody_mode: 'managed', project: checkout.project_id,
    series_key: `space-publication:${space.id}`, logical_name: space.title, media_type: 'text/markdown',
    metadata: { space_id: space.id, source_revision: hash(content) },
  });
  const id = crypto.randomUUID();
  db.prepare(`INSERT INTO space_publications (id,space_id,source_revision,snapshot_ref,content,repo_id,path,
    expected_destination_sha256,issue_id,message,state,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,'prepared',?)`)
    .run(id,space.id,hash(content),snapshot.artifact_version.id,content,checkout.id,relative,expected,input.issue,
      input.message?.trim() || `Publish ${space.title}`,Date.now());
  return getPublication(db,space.id,id);
}

function run(cwd: string, command: string, args: string[]): string {
  const execution = spawnSync(command,args,{ cwd, encoding:'utf8', env:{...process.env,GIT_OPTIONAL_LOCKS:'0'}, timeout:120_000 });
  if (execution.status !== 0) throw new ExportError('git_failed',`${command} failed: ${execution.stderr || execution.error || execution.stdout}`);
  return execution.stdout.trim();
}
function executable(name: string): string {
  const bundled = path.join(os.homedir(),'.dotfiles','bin',name);
  return fs.existsSync(bundled) ? bundled : name;
}
export interface PublicationRunner {
  createWorktree(root: string, branch: string, issue: string): string;
  commit(worktree: string, publication: SpacePublication): string;
  submit(worktree: string, publication: SpacePublication): string;
}
export const publicationRunner: PublicationRunner = {
  createWorktree(root,branch,issue) {
    run(root,executable('wt'),['new',branch,'--issue',issue]);
    const entries = run(root,'git',['worktree','list','--porcelain']).split('\n\n');
    const entry = entries.find(value=>value.split('\n').includes(`branch refs/heads/${branch}`));
    const directory = entry?.split('\n').find(value=>value.startsWith('worktree '))?.slice(9);
    if (!directory) throw new ExportError('git_failed','Created publication checkout could not be located');
    return directory;
  },
  commit(worktree,publication) {
    run(worktree,executable('commit-linked'),['--issue',publication.issue_id,'-m',
      `${publication.message}\n\nPublish the reviewed immutable Spaces revision ${publication.source_revision}.`, '--',publication.path]);
    return run(worktree,'git',['rev-parse','HEAD']);
  },
  submit(worktree,publication) {
    run(worktree,executable('mandible'),['work-unit','activate','--issue',publication.issue_id,
      '--repo',worktree,'--branch',publication.branch!]);
    const result = run(worktree,executable('mandible'),['auth','request',publication.branch!,
      '--title',publication.message,'--issue',publication.issue_id,'--message',
      `${publication.message}\n\nWhy\nPublish the selected Spaces document revision while retaining an editable managed copy.`,
      '--verification',`Frozen source ${publication.source_revision}; destination checked before writing; signed issue-linked commit ${publication.commit_sha}.`,
      '--spec',`Publish ${publication.path} from frozen revision ${publication.source_revision}. Managed editing remains independent.\nconvergence: live-on-merge\noperator-gate: none`, '--no-watch']);
    const found = result.match(/\b[0-9a-f]{8}-[0-9a-f-]{27,}\b/i) ?? result.match(/\b[0-9a-f]{8,64}\b/i);
    if (!found) throw new ExportError('git_failed',`Auth request submitted but its identity could not be read. Inspect the auth queue before retrying: ${result}`);
    return found[0];
  },
};
const executing = new Set<string>();
export async function executePublication(db: Db, spaceId: string, id: string, runner = publicationRunner): Promise<SpacePublication> {
  if (executing.has(id)) throw new ExportError('locked','Publication is already executing');
  executing.add(id);
  try {
    let publication = getPublication(db,spaceId,id);
    if (publication.state === 'submitted') return publication;
    const checkout = getProjectCheckout(db,publication.repo_id);
    if (!checkout) throw new ExportError('checkout_not_found','Destination checkout unavailable');
    if (publication.state === 'prepared') {
      if (destinationHash(checkout.root,publication.path) !== publication.expected_destination_sha256)
        throw new ExportError('stale_destination','Destination changed since preparation. Prepare a new publication; the frozen snapshot and draft are retained.');
      const branch = publication.branch ?? `feature/spaces-${id}`;
      const worktree = publication.worktree ?? runner.createWorktree(checkout.root,branch,publication.issue_id);
      db.prepare('UPDATE space_publications SET branch=?,worktree=? WHERE id=?').run(branch,worktree,id);
      publication = getPublication(db,spaceId,id);
      const current = destinationHash(worktree,publication.path);
      if (current !== publication.expected_destination_sha256 && current !== publication.source_revision)
        throw new ExportError('stale_destination','Publication checkout destination changed. Its bytes are retained for review.');
      const absolute = path.join(worktree,publication.path);
      fs.mkdirSync(path.dirname(absolute),{recursive:true});
      fs.writeFileSync(absolute,publication.content,{encoding:'utf8',flag:current === null ? 'wx' : 'w'});
      const commit = runner.commit(worktree,publication);
      db.prepare("UPDATE space_publications SET commit_sha=?,state='committed' WHERE id=?").run(commit,id);
    }
    publication = getPublication(db,spaceId,id);
    if (!publication.version_ref) {
      const produced = recordArtifactVersion(db,{ project:checkout.project_id,commit:publication.commit_sha!,
        path:publication.path,source_kind:'tracked_repo',custody_mode:'git',metadata:{ source_snapshot:publication.snapshot_ref,space_id:spaceId } });
      db.prepare('UPDATE space_publications SET version_ref=? WHERE id=?').run(produced.artifact_version.id,id);
      publication = getPublication(db,spaceId,id);
    }
    const auth = runner.submit(publication.worktree!,publication);
    db.prepare("UPDATE space_publications SET auth_request_id=?,state='submitted' WHERE id=?").run(auth,id);
    return getPublication(db,spaceId,id);
  } finally { executing.delete(id); }
}

export function importManagedDocument(db: Db, input: { ref: string; projectId?: string | null; title: string }): ReturnType<typeof createSpace> {
  const pinned = artifactMaterializationTarget(resolveArtifactIdentity(db,input.ref,'strict-read'));
  if (!pinned.ok) throw new ExportError('invalid_publication',pinned.error.message);
  const material = readArtifactMaterial(db,pinned.value,8*1024*1024);
  if (!material.ok) throw new ExportError('invalid_publication',material.error.message);
  const imported = importDocument(material.value.bytes.toString('utf8'));
  if (imported.conflicts.some(conflict=>['duplicate_id','invalid_parent'].includes(conflict.kind)))
    throw new ExportError('invalid_publication','Document contains invalid block relationships');
  return db.transaction(()=> {
    const space = createSpace(db,{ project_id:input.projectId,title:input.title,default_renderer:'document',
      metadata:{ imported_from:input.ref, imported_sha256:hash(material.value.bytes) } });
    const ids = new Map(imported.tree.blocks.map(block=>[block.id,crypto.randomUUID()]));
    const pending = [...imported.tree.blocks];
    const added = new Set<string>();
    while (pending.length) {
      const index = pending.findIndex(block=>!block.parent_id || added.has(block.parent_id));
      if (index < 0) throw new ExportError('invalid_publication','Document has cyclic or missing parents');
      const [block] = pending.splice(index,1);
      createSpaceBlock(db,space.id,{ ...block,id:ids.get(block.id)!,parent_id:block.parent_id ? ids.get(block.parent_id)! : null,
        item_id:null,item_snapshot:block.item_id ? { item_id:block.item_id } : null,
        metadata:{ imported_block_id:block.id, imported_item_id:block.item_id } });
      added.add(block.id);
    }
    return space;
  })();
}
