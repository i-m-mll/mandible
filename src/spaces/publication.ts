import crypto from 'node:crypto';
import * as z from 'zod';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Db } from '../db.js';
import { resolveOperationalIssueRef } from '../ledger/operational-links.js';
import { createSpace, getSpace } from '../ledger/spaces.js';
import { createSpaceBlock } from '../ledger/space-blocks.js';
import { resolveArtifactIdentity, recordArtifactVersion } from '../provider-artifacts.js';
import { artifactMaterializationTarget } from '../artifact-identity.js';
import { readArtifactMaterial } from '../artifact-materialization.js';
import { documentHistoryEntry } from './history.js';
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
function preparePublicationValue(db: Db, input: { spaceId: string; repoId?: string | null; path: string; issue: string; message?: string }): SpacePublication {
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
    content, source_kind: 'managed', custody_mode: 'managed', repo_id: checkout.project_id,
    series_key: `space-publication:${space.id}`, logical_name: space.title, media_type: 'text/markdown',
    metadata: { space_id: space.id, source_revision: hash(content) },
  });
  const id = crypto.randomUUID();
  db.prepare(`INSERT INTO space_publications (id,space_id,source_revision,snapshot_ref,content,repo_id,path,
    expected_destination_sha256,issue_id,message,state,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,'prepared',?)`)
    .run(id,space.id,hash(content),snapshot.artifact_version.id,content,checkout.id,relative,expected,issue.issue_id,
      input.message?.trim() || `Publish ${space.title}`,Date.now());
  return getPublication(db,space.id,id);
}

const executeFile = promisify(execFile);
async function run(cwd: string, command: string, args: string[]): Promise<string> {
  try {
    const execution = await executeFile(command,args,{ cwd, encoding:'utf8', env:{...process.env,GIT_OPTIONAL_LOCKS:'0'}, timeout:120_000,maxBuffer:4*1024*1024 });
    return execution.stdout.trim();
  } catch (failure) { throw new ExportError('git_failed',`${command} failed: ${String(failure)}`); }
}
function executable(name: string): string {
  const bundled = path.join(os.homedir(),'.dotfiles','bin',name);
  return fs.existsSync(bundled) ? bundled : name;
}
export interface PublicationRunner {
  createWorktree(root: string, branch: string, issue: string): string | Promise<string>;
  commit(worktree: string, publication: SpacePublication): string | Promise<string>;
  submit(worktree: string, publication: SpacePublication, db: Db): string | Promise<string>;
}
export const publicationRunner: PublicationRunner = {
  async createWorktree(root,branch,issue) {
    await run(root,executable('wt'),['new',branch,'--issue',issue]);
    const entries = (await run(root,'git',['worktree','list','--porcelain'])).split('\n\n');
    const entry = entries.find(value=>value.split('\n').includes(`branch refs/heads/${branch}`));
    const directory = entry?.split('\n').find(value=>value.startsWith('worktree '))?.slice(9);
    if (!directory) throw new ExportError('git_failed','Created publication checkout could not be located');
    return directory;
  },
  async commit(worktree,publication) {
    const staged=(await run(worktree,'git',['diff','--cached','--name-only'])).split('\n').filter(Boolean);
    if(staged.some(file=>file!==publication.path))throw new ExportError('worktree_dirty','Publication checkout contains unrelated staged changes; preserve and review them before committing');
    const prior=await run(worktree,'git',['log','-1','--format=%B']);
    if(prior.includes(`Spaces revision ${publication.source_revision}.`) &&
      (await run(worktree,'git',['diff','HEAD','--',publication.path]))==='') return run(worktree,'git',['rev-parse','HEAD']);
    await run(worktree,executable('commit-linked'),['--issue',publication.issue_id,'-m',
      `${publication.message}\n\nPublish the reviewed immutable Spaces revision ${publication.source_revision}.`, '--',publication.path]);
    return run(worktree,'git',['rev-parse','HEAD']);
  },
  async submit(worktree,publication,db) {
    await run(worktree,executable('mandible'),['work-unit','activate','--issue',publication.issue_id,
      '--repo',worktree,'--branch',publication.branch!]);
    const existing = await readPublicationAuth(worktree,publication);
    if (existing) return existing;
    await run(worktree,executable('mandible'),['auth','request' ,publication.branch!,
      '--title',publication.message,'--issue',publication.issue_id,'--space-publication',publication.id,'--message',
      `${publication.message}\n\nWhy:\nPublish the selected Spaces document revision while retaining an editable managed copy.`,
      '--verification',`Frozen source ${publication.source_revision}; destination checked before writing; signed issue-linked commit ${publication.commit_sha}.`,
      '--spec',`Publish ${publication.path} from frozen revision ${publication.source_revision}. Managed editing remains independent.\nconvergence: live-on-merge\noperator-gate: none`, '--dirty-policy','block','--no-watch']);
    const submitted = await readPublicationAuth(worktree,getPublication(db,publication.space_id,publication.id));
    if (!submitted) throw new ExportError('git_failed','Submission outcome is uncertain. Inspect this publication branch in the auth queue before retrying; the signed proposal is retained.');
    return submitted;
  },
};
async function readPublicationAuth(worktree:string,publication:SpacePublication):Promise<string | null> {
  if (await run(worktree,'git',['rev-parse','HEAD']) !== publication.commit_sha)
    throw new ExportError('stale_destination','Publication branch changed after its signed commit; inspect the retained proposal before submission');
  const listed = JSON.parse(await run(worktree,executable('mandible'),['auth','list','--repo',worktree,'--head',publication.branch!,'--json'])) as {requests:Array<{id:string;head_branch:string;merge_head_sha:string;status:string}>};
  if(!Array.isArray(listed.requests))throw new ExportError('git_failed','Invalid auth queue response');
  const requests=listed.requests.filter(request=>request.head_branch===publication.branch);
  if(requests.length>1)throw new ExportError('git_failed','Multiple requests belong to this publication branch; inspect the queue');
  const request=requests[0];
  if(!request)return null;
  if(request.id !== publication.auth_request_id)throw new ExportError('stale_destination','Existing auth request is not atomically bound to this publication; inspect the retained proposal before submission');
  if(request.merge_head_sha!==publication.commit_sha)throw new ExportError('stale_destination','Existing auth request reviews different bytes');
  if(['rejected','withdrawn','expired','failed'].includes(request.status))throw new ExportError('git_failed',`Existing publication request is ${request.status}; inspect it and prepare a new publication if another attempt is needed`);
  return request.id;
}
const executing = new Set<string>();
async function executePublicationValue(db: Db, spaceId: string, id: string, runner = publicationRunner): Promise<SpacePublication> {
  if (executing.has(id)) throw new ExportError('locked','Publication is already executing');
  executing.add(id);
  try {
    let publication = getPublication(db,spaceId,id);
    if (publication.state === 'submitted') return publication;
    const checkout = getProjectCheckout(db,publication.repo_id);
    if (!checkout) throw new ExportError('checkout_not_found','Destination checkout unavailable');
    const checkDestination = () => {
      if (destinationHash(checkout.root,publication.path) !== publication.expected_destination_sha256)
        throw new ExportError('stale_destination','Destination changed since preparation. Prepare a new publication; the frozen snapshot and draft are retained.');
    };
    checkDestination();
    if (publication.state === 'prepared') {
      const branch = publication.branch ?? `feature/spaces-${id}`;
      const worktree = publication.worktree ?? await runner.createWorktree(checkout.root,branch,publication.issue_id);
      db.prepare('UPDATE space_publications SET branch=?,worktree=? WHERE id=?').run(branch,worktree,id);
      publication = getPublication(db,spaceId,id);
      const current = destinationHash(worktree,publication.path);
      if (current !== publication.expected_destination_sha256 && current !== publication.source_revision)
        throw new ExportError('stale_destination','Publication checkout destination changed. Its bytes are retained for review.');
      const absolute = path.join(worktree,publication.path);
      fs.mkdirSync(path.dirname(absolute),{recursive:true});
      fs.writeFileSync(absolute,publication.content,{encoding:'utf8',flag:current === null ? 'wx' : 'w'});
      const commit = await runner.commit(worktree,publication);
      db.prepare("UPDATE space_publications SET commit_sha=?,state='committed' WHERE id=?").run(commit,id);
    }
    publication = getPublication(db,spaceId,id);
    if (!publication.version_ref) {
      const produced = recordArtifactVersion(db,{ project:checkout.project_id,commit:publication.commit_sha!,
        path:publication.path,source_kind:'tracked_repo',custody_mode:'git',metadata:{ source_snapshot:publication.snapshot_ref,space_id:spaceId } });
      db.prepare('UPDATE space_publications SET version_ref=? WHERE id=?').run(produced.artifact_version.id,id);
      publication = getPublication(db,spaceId,id);
    }
    const committed = artifactMaterializationTarget(resolveArtifactIdentity(db,publication.version_ref!,'strict-read'));
    if (!committed.ok || committed.value.custody.hash !== publication.source_revision)
      throw new ExportError('stale_destination','Signed publication differs from its frozen source; inspect the retained commit before submitting');
    checkDestination();
    if (destinationHash(publication.worktree!,publication.path) !== publication.source_revision)
      throw new ExportError('stale_destination','Publication checkout changed after committing; the signed snapshot is retained.');
    const auth = await runner.submit(publication.worktree!,publication,db);
    const bound = getPublication(db,spaceId,id);
    if(bound.state !== 'submitted' || bound.auth_request_id !== auth)
      throw new ExportError('git_failed','Auth submission did not atomically bind this publication; the signed proposal is retained for inspection');
    return bound;
  } finally { executing.delete(id); }
}

function importManagedDocumentValue(db: Db, input: { ref: string; projectId?: string | null; title: string }): ReturnType<typeof createSpace> {
  const pinned = artifactMaterializationTarget(resolveArtifactIdentity(db,input.ref,'strict-read'));
  if (!pinned.ok) throw new ExportError('invalid_publication',pinned.error.message);
  const material = readArtifactMaterial(db,pinned.value,8*1024*1024);
  if (!material.ok) throw new ExportError('invalid_publication',material.error.message);
  const imported = importDocument(material.value.bytes.toString('utf8'));
  const encodedState = imported.tree.frontmatter.mandible_document_state;
  const stateSchema=z.object({description:z.string().nullable().optional(),metadata:z.record(z.string(),z.unknown()).optional(),
    blocks:z.record(z.string(),z.object({metadata:z.record(z.string(),z.unknown()).optional(),item_snapshot:z.record(z.string(),z.unknown()).nullable().optional()})).optional()});
  let rawState:unknown={};
  try {if(encodedState)rawState=JSON.parse(Buffer.from(encodedState,'base64').toString('utf8'));}
  catch {throw new ExportError('invalid_publication','Document metadata is malformed; its immutable source is retained');}
  const parsedState=stateSchema.safeParse(rawState);
  if(!parsedState.success)throw new ExportError('invalid_publication','Document metadata has an invalid shape; its immutable source is retained');
  const state=parsedState.data;

  if (imported.conflicts.some(conflict=>['duplicate_id','invalid_parent'].includes(conflict.kind)))
    throw new ExportError('invalid_publication','Document contains invalid block relationships');
  return db.transaction(()=> {
    const space = createSpace(db,{ project_id:input.projectId,title:input.title,default_renderer:'document',description:state.description,
      metadata:{ ...state.metadata,imported_from:pinned.value.version_id ?? pinned.value.id, imported_sha256:hash(material.value.bytes) } });
    const ids = new Map(imported.tree.blocks.map(block=>[block.id,crypto.randomUUID()]));
    const pending = [...imported.tree.blocks];
    const added = new Set<string>();
    while (pending.length) {
      const index = pending.findIndex(block=>!block.parent_id || added.has(block.parent_id));
      if (index < 0) throw new ExportError('invalid_publication','Document has cyclic or missing parents');
      const [block] = pending.splice(index,1);
      createSpaceBlock(db,space.id,{ ...block,id:ids.get(block.id)!,parent_id:block.parent_id ? ids.get(block.parent_id)! : null,
        item_id:null,item_snapshot:state.blocks?.[block.id]?.item_snapshot ?? (block.item_id ? { item_id:block.item_id } : null),
        metadata:{ ...state.blocks?.[block.id]?.metadata,imported_block_id:block.id, imported_item_id:block.item_id } });
      added.add(block.id);
    }
    return space;
  })();
}

function importHistoryDocumentValue(db: Db, spaceId: string, id: string, title: string) {
  const entry = documentHistoryEntry(db,spaceId,id), source = getSpace(db,spaceId);
  if (!entry || !source) throw new ExportError('space_not_found','Historical document not found');
  if (typeof entry.artifact_ref === 'string') return importManagedDocumentValue(db,{ref:entry.artifact_ref,title,projectId:source.project_id});
  if (typeof entry.content !== 'string') throw new ExportError('invalid_publication','Historical content is unavailable; inspect its preserved checkout details');
  const frozen=recordArtifactVersion(db,{source_kind:'managed',custody_mode:'managed',content:entry.content,
    series_key:`space-history:${id}`,metadata:{history_id:id,space_id:spaceId}});
  return importManagedDocumentValue(db,{ref:frozen.artifact_version.id,title,projectId:source.project_id});
}
function importGitDocumentValue(db: Db, input: { project: string; commit: string; path: string; title: string; projectId?: string | null }) {
  const pinned=recordArtifactVersion(db,{ source_kind:'tracked_repo',custody_mode:'git',project:input.project,
    commit:input.commit,path:normalizeRepoRelativePath(input.path) });
  return importManagedDocumentValue(db,{ref:pinned.artifact_version.id,title:input.title,projectId:input.projectId});
}

export type PublicationResult<T> = { ok:true; value:T } | { ok:false; error:{code:ExportError['code'] | 'storage_failed';message:string} };
function publicationFailure(error:unknown): PublicationResult<never> {
  return {ok:false,error:{code:error instanceof ExportError ? error.code:'storage_failed',message:error instanceof Error ? error.message:String(error)}};
}
function publicationBoundary<T>(operation:()=>T):PublicationResult<T> {
  try{return {ok:true,value:operation()};}catch(error){return publicationFailure(error);}
}
export function preparePublication(...args:Parameters<typeof preparePublicationValue>):PublicationResult<SpacePublication> {
  return publicationBoundary(()=>preparePublicationValue(...args));
}
export async function executePublication(...args:Parameters<typeof executePublicationValue>):Promise<PublicationResult<SpacePublication>> {
  try{return {ok:true,value:await executePublicationValue(...args)};}catch(error){return publicationFailure(error);}
}
export function importManagedDocument(...args:Parameters<typeof importManagedDocumentValue>):PublicationResult<ReturnType<typeof createSpace>> {
  return publicationBoundary(()=>importManagedDocumentValue(...args));
}
export function importHistoryDocument(...args:Parameters<typeof importHistoryDocumentValue>):PublicationResult<ReturnType<typeof createSpace>> {
  return publicationBoundary(()=>importHistoryDocumentValue(...args));
}
export function importGitDocument(...args:Parameters<typeof importGitDocumentValue>):PublicationResult<ReturnType<typeof createSpace>> {
  return publicationBoundary(()=>importGitDocumentValue(...args));
}

export type PublicationDestination = { id:string; project_id:string; project_name:string; name:string };
export function publicationDestinations(db:Db,spaceId:string):PublicationDestination[] {
  const space=getSpace(db,spaceId);
  if(!space)throw new ExportError('space_not_found','Space not found');
  return db.prepare(`SELECT c.id,c.project_id,COALESCE(p.display_name,p.project_key) AS project_name,c.name
    FROM ledger_project_checkouts c JOIN ledger_projects p ON p.id=c.project_id
    WHERE (? IS NULL OR c.project_id=?) ORDER BY project_name,c.name,c.id`).all(space.project_id,space.project_id) as PublicationDestination[];
}
