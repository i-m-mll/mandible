import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, beforeEach, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { openDb, type Db } from '../src/db.js';
import { planArtifactVersion, commitArtifactVersion, recordArtifactVersion, associateProjectArtifact, getCanonicalArtifactVersion } from '../src/provider-artifacts.js';
import { getArtifactCurrentSource, planArtifactSourceMove, commitArtifactSourceMove, type ArtifactLifecycleResult } from '../src/artifact-source.js';
import { readArtifactBytesFull } from '../src/artifact-content.js';
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
  const legacy=new Database(':memory:');
  legacy.exec(`CREATE TABLE ledger_projects(id TEXT PRIMARY KEY,project_key TEXT,display_name TEXT);
    CREATE TABLE ledger_project_checkouts(project_id TEXT,work_repo_id TEXT,name TEXT);
    CREATE TABLE artifact(id TEXT PRIMARY KEY,identity_key TEXT,source_kind TEXT,source_project_id TEXT,source_repo_id TEXT,source_path TEXT,metadata_json TEXT DEFAULT '{}',updated_at INTEGER);
    CREATE INDEX idx_artifact_source_repo ON artifact(source_repo_id) WHERE source_repo_id IS NOT NULL;
    CREATE TABLE artifact_version(id TEXT PRIMARY KEY,artifact_id TEXT,source_kind TEXT,source_project_id TEXT,source_repo_id TEXT,repo_path TEXT,observed_path TEXT,created_at INTEGER DEFAULT 1);
    CREATE TABLE project_artifact_associations(id TEXT PRIMARY KEY,project_id TEXT,target_type TEXT,target_id TEXT,association_kind TEXT,role TEXT,status TEXT,source TEXT,created_at INTEGER,updated_at INTEGER);
    INSERT INTO ledger_projects VALUES ('p','repo','repo');
    INSERT INTO artifact VALUES ('one','one','tracked_repo',NULL,'repo','a','{}',1),('two','two','tracked_repo',NULL,'repo','a','{}',1),('mixed','mixed','mixed',NULL,'repo','c','{}',1);
    INSERT INTO artifact_version(id,artifact_id,source_kind,source_project_id,source_repo_id,repo_path,observed_path) VALUES ('v1','one','tracked_repo',NULL,'repo','a',NULL),('v2','two','tracked_repo',NULL,'repo','a',NULL),('v3','mixed','tracked_repo',NULL,'repo','b',NULL),('v4','mixed','tracked_repo',NULL,'repo','c',NULL);`);
  const ids=legacy.prepare('SELECT id FROM artifact_version ORDER BY id').all();
  legacy.transaction(()=>{for(const sql of [...ARTIFACT_SOURCE_SCHEMA_SQL,...ARTIFACT_SOURCE_BACKFILL_SQL])legacy.exec(sql);})();
  expect(legacy.prepare('SELECT id FROM artifact_version ORDER BY id').all()).toEqual(ids);
  expect(legacy.prepare('SELECT reconciliation_reason FROM artifact_source ORDER BY artifact_id').all()).toEqual([
    {reconciliation_reason:'historical_source_ambiguous'},{reconciliation_reason:'duplicate_current_source'},{reconciliation_reason:'duplicate_current_source'}]);
  expect(legacy.pragma('foreign_key_check')).toEqual([]);legacy.close();
});
