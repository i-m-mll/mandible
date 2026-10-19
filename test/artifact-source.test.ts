import { retainArtifactCommit } from '../src/artifact-repo-resolution.js';
import fs from 'node:fs';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, beforeEach, expect, it } from 'vitest';
import SqliteDatabase from "../src/sqlite.ts";
import { openDb, type Db } from '../src/db.js';
import { planArtifactVersionBatch, planArtifactVersion, associateProjectArtifact, getCanonicalArtifactVersion } from "../src/provider-artifacts.js";
import {
  appendArtifactVersion,
  commitArtifactVersionBatch,
  commitArtifactVersion,
  recordArtifactVersion,
} from "./helpers/artifact-http-write-fixtures.js";
import { getArtifactCurrentSource, planArtifactSourceMove, commitArtifactSourceMove, type ArtifactLifecycleResult } from '../src/artifact-source.js';
import { readArtifactBytesFull, checkArtifactMaterialization } from '../src/artifact-content.js';
import { resolveArtifactProject, artifactAccessProjectIds } from '../src/permissions/resources.js';
import { evaluateProjectAccess, setProjectRestricted } from '../src/permissions/store.js';
import { setClientAuthMode } from '../src/client-auth/mode.js';
import { ARTIFACT_SOURCE_SCHEMA_SQL, ARTIFACT_SOURCE_BACKFILL_SQL } from '../src/artifact-source-schema.js';
import { insertRawLedgerProject, insertRawLedgerCheckout } from './helpers/ledger-fixtures.js';

let db: Db;
let dir: string;
let previous: string | undefined;
function ok<T>(r: ArtifactLifecycleResult<T>): T { if (!r.ok) throw new Error(r.error.message); return r.value; }
function git(root: string, ...args: string[]): string {
  return execFileSync('git', ['--no-optional-locks','-C',root,...args], {encoding:'utf8',env:{...process.env,GIT_CONFIG_COUNT:'0'},stdio:['ignore','pipe','pipe']}).trim();
}
function repo(name:string, text='same bytes') {
  const root=path.join(dir,name); fs.mkdirSync(root);
  git(root,'init','-b','main'); git(root,'config','user.name','Test'); git(root,'config','user.email','test@example.invalid'); git(root,'config','commit.gpgsign','false');
  const file=path.join(root,'report.md'); fs.writeFileSync(file,text); git(root,'add','.'); git(root,'commit','-m','record');
  const project=insertRawLedgerProject(db,{name}); insertRawLedgerCheckout(db,{projectId:project,name,root,conflict:'replace'});
  return {root,file,project};
}
const identity = (series: string) => series.replace('artifact-series:','artifact:');
beforeEach(()=>{dir=fs.mkdtempSync(path.join(os.tmpdir(),'artifact-source-'));previous=process.env.MANDIBLE_ARTIFACT_DIR;process.env.MANDIBLE_ARTIFACT_DIR=path.join(dir,'cas');db=openDb(path.join(dir,'db'));});
afterEach(()=>{db.close();fs.rmSync(dir,{recursive:true,force:true});if(previous===undefined)delete process.env.MANDIBLE_ARTIFACT_DIR;else process.env.MANDIBLE_ARTIFACT_DIR=previous;});

it('moves across projects without transferring owner; old-path reuse and equal blobs preserve exact histories',()=>{
  const a=repo('source'), b=repo('destination');
  const first=recordArtifactVersion(db,{source_kind:'tracked_repo',path:a.file}); const id=identity(first.series.id);
  const move=ok(planArtifactSourceMove(db,{artifact_id:id,expected_revision:1,source:{kind:'repo',project_id:b.project,path:'report.md'},actor:'test-agent'}));
  expect(move.required_project_ids).toEqual([a.project,b.project].sort());
  ok(commitArtifactSourceMove(db,move));
  expect(commitArtifactSourceMove(db,move)).toMatchObject({ok:false,error:{code:'stale_plan'}});
  const second=recordArtifactVersion(db,{source_kind:'tracked_repo',path:b.file,artifact_id:id});
  expect(second.series.id).toBe(first.series.id);
  expect(getCanonicalArtifactVersion(db,second.version.id)?.source_project_id).toBe(b.project);
  expect(resolveArtifactProject(db,id)).toEqual({ok:true,project_id:a.project});
  expect(resolveArtifactProject(db,second.version.id)).toEqual({ok:true,project_id:a.project});
  setProjectRestricted(db,a.project,true);setClientAuthMode(db,'strict');
  expect(evaluateProjectAccess(db,{identity:null,project_id:a.project,required_role:'read'}).allowed).toBe(false);
  const reused=recordArtifactVersion(db,{source_kind:'tracked_repo',path:a.file});
  expect(reused.series.id).not.toBe(first.series.id);
  fs.rmSync(b.root,{recursive:true});
  expect(readArtifactBytesFull(db,first.version.id)).toMatchObject({ok:true,bytes:Buffer.from('same bytes')});
  expect(readArtifactBytesFull(db,second.version.id).ok).toBe(false);
  associateProjectArtifact(db,{project_ref:b.project,target_type:'artifact_version',target_id:first.version.id});
  expect(artifactAccessProjectIds(db,first.version.id)).toEqual([a.project,b.project].sort());
  expect(resolveArtifactProject(db,id)).toEqual({ok:false,reason:'ambiguous'});
});

it('rejects implicit source substitution and stale content/ownership before writing bytes or rows',()=>{
  const a=repo('a'), b=repo('b');
  const first=recordArtifactVersion(db,{source_kind:'tracked_repo',path:a.file});const id=identity(first.series.id);
  const counts=()=>db.prepare('SELECT (SELECT COUNT(*) FROM artifact_blob) blobs,(SELECT COUNT(*) FROM artifact_version) versions,(SELECT COUNT(*) FROM artifact_source) sources').get();
  const before=counts();
  expect(planArtifactVersion(db,{source_kind:'tracked_repo',path:b.file,series_key:first.series.series_key})).toMatchObject({ok:false,error:{code:'source_mismatch'}});
  const plan=ok(planArtifactVersion(db,{source_kind:'managed',artifact_id:id,content:'unpublished'}));
  associateProjectArtifact(db,{project_ref:b.project,target_type:'artifact',target_id:id});
  expect(commitArtifactVersion(db,plan)).toMatchObject({ok:false,error:{code:'stale_plan'}});
  expect(counts()).toEqual(before);expect(fs.existsSync(path.join(dir,'cas'))).toBe(false);
  const filePlan=ok(planArtifactVersion(db,{source_kind:'tracked_repo',path:a.file}));
  fs.writeFileSync(a.file,'changed');
  expect(commitArtifactVersion(db,filePlan)).toMatchObject({ok:false,error:{code:'stale_plan'}});
  expect(counts()).toEqual(before);
});

it('retains source for managed snapshots and resolves uploaded bytes against the registered source',()=>{
  const a=repo('a');const first=recordArtifactVersion(db,{source_kind:'tracked_repo',path:a.file});const id=identity(first.series.id);
  const source=getArtifactCurrentSource(db,id)!;
  const upload=ok(planArtifactVersion(db,{source_kind:'managed',source:source.source!,content:'uploaded'}));
  expect(upload.artifact_id).toBe(id);ok(commitArtifactVersion(db,upload));
  expect(getArtifactCurrentSource(db,id)).toEqual(source);
  expect(readArtifactBytesFull(db,first.version.id)).toMatchObject({ok:true,bytes:Buffer.from('same bytes')});
});

it('backfills only consistent sources and preserves duplicate/ambiguous history for reconciliation',()=>{
  const legacy=new SqliteDatabase(':memory:');
  legacy.exec(`CREATE TABLE ledger_projects(id TEXT PRIMARY KEY,project_key TEXT,display_name TEXT);
    CREATE TABLE ledger_project_checkouts(project_id TEXT,work_repo_id TEXT,name TEXT);
    CREATE TABLE artifact(id TEXT PRIMARY KEY,identity_key TEXT,source_kind TEXT,source_project_id TEXT,source_repo_id TEXT,source_path TEXT,metadata_json TEXT DEFAULT '{}',updated_at INTEGER);
    CREATE INDEX idx_artifact_source_repo ON artifact(source_repo_id) WHERE source_repo_id IS NOT NULL;
    CREATE TABLE artifact_version(id TEXT PRIMARY KEY,artifact_id TEXT,blob_id TEXT,source_kind TEXT,source_project_id TEXT,source_repo_id TEXT,repo_path TEXT,observed_path TEXT,created_at INTEGER DEFAULT 1);
    CREATE TABLE project_artifact_associations(id TEXT PRIMARY KEY,project_id TEXT,target_type TEXT,target_id TEXT,association_kind TEXT,role TEXT,status TEXT,source TEXT,created_at INTEGER,updated_at INTEGER);
    INSERT INTO ledger_projects VALUES ('p','repo','repo');
    INSERT INTO artifact VALUES ('one','one','tracked_repo',NULL,'repo','a','{}',1),('two','two','tracked_repo',NULL,'repo','a','{}',1),('mixed','mixed','mixed',NULL,'repo','c','{}',1),('unknown','unknown','external',NULL,NULL,NULL,'{}',1),('managed','managed','managed',NULL,NULL,NULL,'{}',1);
    INSERT INTO artifact_version(id,artifact_id,source_kind,source_project_id,source_repo_id,repo_path,observed_path) VALUES ('v1','one','tracked_repo',NULL,'repo','a',NULL),('v2','two','tracked_repo',NULL,'repo','a',NULL),('v3','mixed','tracked_repo',NULL,'repo','b',NULL),('v4','mixed','tracked_repo',NULL,'repo','c',NULL);`);
  const ids=legacy.prepare('SELECT id FROM artifact_version ORDER BY id').all();
  legacy.transaction(()=>{for(const sql of [...ARTIFACT_SOURCE_SCHEMA_SQL,...ARTIFACT_SOURCE_BACKFILL_SQL])legacy.exec(sql);})();
  expect(legacy.prepare('SELECT id FROM artifact_version ORDER BY id').all()).toEqual(ids);
  expect(legacy.prepare('SELECT reconciliation_reason FROM artifact_source ORDER BY artifact_id').all()).toEqual([
    {reconciliation_reason:null},{reconciliation_reason:'historical_source_ambiguous'},{reconciliation_reason:'duplicate_current_source'},{reconciliation_reason:'duplicate_current_source'},{reconciliation_reason:'historical_source_ambiguous'}]);
  const repair={artifact_id:'mixed',expected_revision:1,source:{kind:'managed' as const,key:'reconciled'},actor:'operator'};
  expect(planArtifactSourceMove(legacy,repair)).toMatchObject({ok:false,error:{code:'reconciliation_required'}});
  const plan=ok(planArtifactSourceMove(legacy,{...repair,reconcile:true}));
  expect(plan.required_project_ids).toEqual(['p']);
  expect(ok(commitArtifactSourceMove(legacy,plan))).toMatchObject({revision:2,reconciliation_reason:null});
  expect(commitArtifactSourceMove(legacy,plan)).toMatchObject({ok:false,error:{code:'stale_plan'}});
  expect(legacy.prepare('SELECT id FROM artifact_version ORDER BY id').all()).toEqual(ids);
  expect(legacy.pragma('foreign_key_check')).toEqual([]);legacy.close();
});

it('explicit managed custody keeps registered repo identity but reads frozen bytes after repository deletion',()=>{
  const a=repo('a');const first=recordArtifactVersion(db,{source_kind:'tracked_repo',path:a.file});const id=identity(first.series.id);
  const copy=recordArtifactVersion(db,{source_kind:'tracked_repo',path:a.file,custody_mode:'managed'});
  expect(copy.series.id).toBe(first.series.id);expect(copy.version.custody_mode).toBe('managed');
  expect(getArtifactCurrentSource(db,id)?.source).toEqual({kind:'repo',project_id:a.project,path:'report.md'});
  fs.rmSync(a.root,{recursive:true});
  expect(readArtifactBytesFull(db,copy.version.id)).toMatchObject({ok:true,bytes:Buffer.from('same bytes')});
});

it('owns uploaded repository-source artifacts without a separate repo argument and preserves that owner on moves',()=>{
  const a=repo('a'), b=repo('b');setProjectRestricted(db,b.project,true);setClientAuthMode(db,'strict');
  const planned=ok(planArtifactVersion(db,{source_kind:'managed',source:{kind:'repo',project_id:b.project,path:'uploaded.md'},content:'private upload'}));
  expect(planned.required_project_ids).toEqual([b.project]);
  const created=ok(commitArtifactVersion(db,planned));const id=identity(created.series.id);
  expect(resolveArtifactProject(db,id)).toEqual({ok:true,project_id:b.project});
  expect(resolveArtifactProject(db,created.version.id)).toEqual({ok:true,project_id:b.project});
  expect(evaluateProjectAccess(db,{identity:null,project_id:b.project,required_role:'read'}).allowed).toBe(false);
  const move=ok(planArtifactSourceMove(db,{artifact_id:id,expected_revision:1,source:{kind:'repo',project_id:a.project,path:'uploaded.md'},actor:'operator'}));
  expect(move.required_project_ids).toEqual([a.project,b.project].sort());ok(commitArtifactSourceMove(db,move));
  expect(resolveArtifactProject(db,id)).toEqual({ok:true,project_id:b.project});
});

it('uses the registered file source and project gate independently of version kind and custody',()=>{
  const a=repo('a');setProjectRestricted(db,a.project,true);setClientAuthMode(db,'strict');
  const first=recordArtifactVersion(db,{source_kind:'tracked_repo',path:a.file});const id=identity(first.series.id);
  for(const source_kind of ['tracked_repo','local_only','managed'] as const) {
    for(const custody_mode of ['managed'] as const) {
      fs.writeFileSync(a.file,`${source_kind}-${custody_mode}`);
      const plan=ok(planArtifactVersion(db,{source_kind,path:a.file,custody_mode}));
      expect(plan.artifact_id).toBe(id);
      expect(plan.source).toEqual({kind:'repo',project_id:a.project,path:'report.md'});
      expect(plan.required_project_ids).toEqual([a.project]);
      expect(plan.required_project_ids.every(project_id=>evaluateProjectAccess(db,{identity:null,project_id,required_role:'write'}).allowed)).toBe(false);
      expect(plan.custody_mode).toBe(custody_mode);
      const written=ok(commitArtifactVersion(db,plan));
      expect(written.version.custody_mode).toBe(custody_mode);
      expect(resolveArtifactProject(db,identity(written.series.id))).toEqual({ok:true,project_id:a.project});
      expect(readArtifactBytesFull(db,written.version.id)).toMatchObject({ok:true,bytes:Buffer.from(`${source_kind}-${custody_mode}`)});
    }
  }
  expect(db.prepare('SELECT COUNT(*) n FROM artifact').get()).toEqual({n:1});
  expect(planArtifactVersion(db,{source_kind:'managed',path:a.file,source:{kind:'local',path:a.file}})).toMatchObject({ok:false,error:{code:'source_mismatch'}});
  const untracked=path.join(a.root,'untracked.txt');fs.writeFileSync(untracked,'untracked');
  const plan=ok(planArtifactVersion(db,{source_kind:'local_only',path:untracked}));
  expect(plan.required_project_ids).toEqual([a.project]);
  expect(plan.source).toEqual({kind:'repo',project_id:a.project,path:'untracked.txt'});
});


it('takes a selected project as the owner of a non-repository file and still refuses a different repository',()=>{
  const a=repo('a'), b=repo('b');const file=path.join(dir,'loose.txt');fs.writeFileSync(file,'loose');
  const plan=ok(planArtifactVersion(db,{source_kind:'local_only',path:file,custody_mode:'managed',project:'b'}));
  expect(plan.required_project_ids).toEqual([b.project]);
  expect(resolveArtifactProject(db,identity(ok(commitArtifactVersion(db,plan)).series.id))).toEqual({ok:true,project_id:b.project});
  expect(planArtifactVersion(db,{source_kind:'tracked_repo',path:a.file,project:'b'})).toMatchObject({ok:false,error:{code:'source_mismatch'}});
});

it('requires registered project access for files in checkouts without Git metadata',()=>{
  const root=path.join(dir,'registered-folder');fs.mkdirSync(root);const file=path.join(root,'notes.txt');fs.writeFileSync(file,'private');
  const project=insertRawLedgerProject(db,{name:'folder'});insertRawLedgerCheckout(db,{projectId:project,name:'folder',root,conflict:'replace'});
  const plan=ok(planArtifactVersion(db,{source_kind:'managed',path:file}));
  expect(plan.source).toEqual({kind:'repo',project_id:project,path:'notes.txt'});
  expect(plan.required_project_ids).toEqual([project]);
});

it.each(['production commit/path', 'unmerged project/commit/path'])('reuses %s version IDs only when evidence matches and preserves producer keys', (shape) => {
  const a = repo('upgrade');
  const input = { source_kind: 'tracked_repo' as const, path: a.file, metadata: { x: 1, y: 2 } };
  const first = recordArtifactVersion(db, input);
  const id = identity(first.series.id);
  const key = shape === 'production commit/path' ? `${first.version.commit_sha}:report.md`
    : `${a.project}:${first.version.commit_sha}:report.md`;
  const oldId = 'artifact-version:' + crypto.createHash('sha256')
    .update(JSON.stringify([first.series.id, 'tracked_repo', key])).digest('hex').slice(0, 32);
  db.transaction(() => {
    db.prepare('UPDATE artifact SET latest_version_id=NULL WHERE id=?').run(id);
    db.prepare('UPDATE artifact_version SET id=? WHERE id=?').run(oldId, first.version.id);
    if (shape === 'production commit/path') db.prepare('UPDATE artifact_version SET observed_path=NULL WHERE id=?').run(oldId);
    db.prepare('UPDATE artifact SET latest_version_id=? WHERE id=?').run(oldId, id);
  })();
  const before = db.prepare('SELECT * FROM artifact_version').all();
  const again = recordArtifactVersion(db, { ...input, metadata: { y: 2, x: 1 } });
  expect(again.created).toBe(false); expect(again.version.id).toBe(oldId);
  const historical = recordArtifactVersion(db, { ...input, path: 'report.md', project: 'upgrade', commit: first.version.commit_sha! });
  expect(historical.created).toBe(false); expect(historical.version.id).toBe(oldId);
  expect(db.prepare('SELECT * FROM artifact_version').all()).toEqual(before);
  const trackedProducer = { series_id: first.series.id, artifact_id: `artifact-blob:${first.version.content_hash}`,
    source_kind: 'tracked_repo' as const, source_project_id: a.project, source_repo_id: 'upgrade',
    repo_path: 'report.md', commit_sha: first.version.commit_sha!, content_hash: first.version.content_hash,
    custody_mode: 'git', metadata: input.metadata, natural_key: 'producer-run' };
  const explicit = appendArtifactVersion(db, trackedProducer);
  expect(explicit.created).toBe(true); expect(explicit.version.id).not.toBe(oldId);
  expect(appendArtifactVersion(db, trackedProducer).version.id).toBe(explicit.version.id);
  expect(appendArtifactVersion(db, { ...trackedProducer, natural_key: 'another-producer-run' }).created).toBe(true);
  const changed = recordArtifactVersion(db, { ...input, metadata: { x: 2, y: 2 } });
  expect(changed.created).toBe(true); expect(changed.version.id).not.toBe(oldId);
  const producer = { series_id: first.series.id, artifact_id: `artifact-blob:${first.version.content_hash}`, source_kind: 'managed' as const,
    content_hash: first.version.content_hash, custody_mode: 'managed', metadata: { producer: 'test' } };
  recordArtifactVersion(db, { ...input, custody_mode: 'managed' });
  const eventA = appendArtifactVersion(db, { ...producer, natural_key: 'event-a' });
  const eventB = appendArtifactVersion(db, { ...producer, natural_key: 'event-b' });
  expect(eventA.version.id).not.toBe(eventB.version.id);
  expect(appendArtifactVersion(db, { ...producer, natural_key: 'event-a' }).created).toBe(false);
  const copied = recordArtifactVersion(db, { ...input, custody_mode: 'managed' });
  expect(copied.created).toBe(false);
  git(a.root, 'commit', '--allow-empty', '-m', 'same bytes at another commit');
  expect(recordArtifactVersion(db, { ...input, custody_mode: 'managed' }).created).toBe(true);
});

it('rejects stale later batch members before writing earlier custody', () => {
  const a = path.join(dir, 'a.md'), b = path.join(dir, 'b.md');
  fs.writeFileSync(a, 'a'); fs.writeFileSync(b, 'b');
  const plans = ok(planArtifactVersionBatch(db, [a, b].map(path => ({ source_kind: 'local_only', path }))));
  fs.writeFileSync(b, 'changed');
  expect(commitArtifactVersionBatch(db, plans)).toMatchObject({ ok: false, error: { code: 'stale_plan' } });
  expect(db.prepare('SELECT COUNT(*) n FROM artifact').get()).toEqual({ n: 0 });
  expect(fs.existsSync(path.join(dir, 'cas'))).toBe(false);
});

it('pins a symbolic commit once even when the checkout and ref advance before commit', () => {
  const a = repo('pinned');
  const commit = git(a.root, 'rev-parse', 'HEAD');
  const plan = ok(planArtifactVersion(db, { source_kind: 'tracked_repo', path: 'report.md', cwd: a.root, commit: 'HEAD' }));
  fs.writeFileSync(a.file, 'new checkout bytes'); git(a.root, 'add', '.'); git(a.root, 'commit', '-m', 'advance');
  const result = ok(commitArtifactVersion(db, plan));
  expect(result.version.commit_sha).toBe(commit);
  expect(readArtifactBytesFull(db, result.version.id)).toMatchObject({ ok: true, bytes: Buffer.from('same bytes') });
});


it('keeps Git authority after equal-byte managed ingestion and retains abandoned commits through GC',()=>{
  const a=repo('retained','original');
  const first=recordArtifactVersion(db,{source_kind:'tracked_repo',path:a.file});
  const commit=first.version.commit_sha!;
  expect(checkArtifactMaterialization(db,`artifact-blob:${first.version.content_hash}`)).toMatchObject({materializable:false,recoverability:null});
  expect(first.version.artifact_id).toBe(first.version.id);
  const managed=recordArtifactVersion(db,{source_kind:'tracked_repo',path:a.file,custody_mode:'managed'});
  expect(db.prepare('SELECT custody_mode FROM artifact_version ORDER BY version_no').all()).toEqual([{custody_mode:'git'},{custody_mode:'managed'}]);
  expect(db.prepare('PRAGMA table_info(artifact_blob)').all().map((x:any)=>x.name)).not.toContain('custody_mode');
  git(a.root,'checkout','--orphan','replacement');
  fs.writeFileSync(a.file,'replacement');git(a.root,'add','.');git(a.root,'commit','-m','replacement');
  git(a.root,'branch','-D','main');git(a.root,'reflog','expire','--expire=now','--all');git(a.root,'gc','--prune=now');
  expect(git(a.root,'rev-parse',`refs/mandible/artifacts/${commit}`)).toBe(commit);
  expect(readArtifactBytesFull(db,first.version.id)).toMatchObject({ok:true,bytes:Buffer.from('original')});
  fs.rmSync(a.root,{recursive:true});
  expect(readArtifactBytesFull(db,first.version.id).ok).toBe(false);
  expect(readArtifactBytesFull(db,managed.version.id)).toMatchObject({ok:true,bytes:Buffer.from('original')});
});

it('rejects obsolete custody, uncommitted Git authority, and corrupt stored bytes',()=>{
  const a=repo('boundary');
  for(const custody_mode of ['copy','link','external']) expect(planArtifactVersion(db,{source_kind:'tracked_repo',path:a.file,custody_mode}).ok).toBe(false);
  fs.writeFileSync(a.file,'uncommitted');
  expect(planArtifactVersion(db,{source_kind:'tracked_repo',path:a.file,custody_mode:'git'}).ok).toBe(false);
  const v=recordArtifactVersion(db,{source_kind:'tracked_repo',path:a.file,custody_mode:'managed'});
  expect(()=>db.prepare("UPDATE artifact_version SET content_hash=? WHERE id=?").run('a'.repeat(64),v.version.id)).toThrow('immutable');
  const blob=db.prepare('SELECT storage_uri FROM artifact_blob WHERE content_hash=?').get(v.version.content_hash) as {storage_uri:string};
  fs.writeFileSync(new URL(blob.storage_uri),'tampered');
  expect(readArtifactBytesFull(db,v.version.id)).toMatchObject({ok:false,reason:expect.stringContaining('sha256')});
});

it('refuses an unexpected existing Git retention target without overwriting it',()=>{
  const a=repo('guarded');
  const saved=recordArtifactVersion(db,{source_kind:'tracked_repo',path:a.file});
  const ref=`refs/mandible/artifacts/${saved.version.commit_sha}`;
  git(a.root,'commit','--allow-empty','-m','other');
  const other=git(a.root,'rev-parse','HEAD');git(a.root,'update-ref',ref,other);
  expect(()=>retainArtifactCommit(db,{project:'guarded',commit:saved.version.commit_sha!,path:'report.md',sha256:saved.version.content_hash})).toThrow('unexpected commit');
  expect(git(a.root,'rev-parse',ref)).toBe(other);
});

it('preserves original input alias evidence and rejects conflicting project attribution', () => {
  const target = path.join(dir, 'target'); fs.mkdirSync(target);
  const file = path.join(target, 'report.md'); fs.writeFileSync(file, 'report');
  const alias = path.join(dir, 'alias'); fs.symlinkSync(target, alias);
  const project = insertRawLedgerProject(db, { name: 'alias-project' });
  insertRawLedgerCheckout(db, { projectId: project, name: 'alias-project', root: alias, conflict: 'replace' });
  const input = { source_kind: 'local_only' as const, path: path.join(alias, 'report.md'), custody_mode: 'managed' as const };
  const plan = ok(planArtifactVersion(db, input));
  expect(plan.required_project_ids).toContain(project);
  const other = insertRawLedgerProject(db, { name: 'target-project' });
  insertRawLedgerCheckout(db, { projectId: other, name: 'target-project', root: target, conflict: 'replace' });
  expect(planArtifactVersion(db, input)).toMatchObject({ ok: false, error: { code: 'invalid_source' } });
});
