// @vitest-environment node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { beforeEach, afterEach, expect, it } from 'vitest';
import SqliteDatabase from '../src/sqlite.js';
import { migrate, type Db } from '../src/db.js';
import { createSpace } from '../src/ledger/spaces.js';
import { createSpaceBlock, listSpaceBlocks, updateSpaceBlock } from '../src/ledger/space-blocks.js';
import { LedgerStore } from '../src/ledger/store.js';
import { systemAction } from '../src/identity/resolver.js';
import { preparePublication as prepareResult, executePublication as executeResult, importManagedDocument as importResult, getPublication, type PublicationRunner } from '../src/spaces/publication.js';
import { preserveLegacyDocuments, listDocumentHistory } from '../src/spaces/history.js';
import { serializeSpaceDocument } from '../src/spaces/export.js';
import { recordArtifactVersion } from '../src/provider-artifacts.js';
import { documentArtifactImportEffects } from '../src/security/document-import-effects.js';

function unwrap<T>(result:import('../src/spaces/publication.js').PublicationResult<T>):T {
  if(!result.ok)throw new Error(result.error.message);return result.value;
}
const preparePublication=(...args:Parameters<typeof prepareResult>)=>unwrap(prepareResult(...args));
const executePublication=async(...args:Parameters<typeof executeResult>)=>unwrap(await executeResult(...args));
const importManagedDocument=(...args:Parameters<typeof importResult>)=>unwrap(importResult(...args));
let root:string,db:Db,space:string;
const git=(directory:string,...args:string[])=>execFileSync('git',args,{cwd:directory,encoding:'utf8',env:{...process.env,GIT_OPTIONAL_LOCKS:'0'}}).trim();
beforeEach(()=> {
  root=fs.mkdtempSync(path.join(os.tmpdir(),'mandible-publication-'));
  process.env.MANDIBLE_ARTIFACT_DIR=path.join(root,'artifacts');
  db=new SqliteDatabase(':memory:') as Db;migrate(db);
  db.prepare('INSERT INTO ledger_projects (id,project_key,display_name,remote_identity,created_at,updated_at) VALUES (?,?,?,?,?,?)').run('p','fixture','Fixture','local:fixture',1,1);
  const checkout=path.join(root,'repo');fs.mkdirSync(checkout);
  execFileSync('ssh-keygen',['-q','-t','ed25519','-N','','-f',path.join(root,'fixture-key')]);
  git(checkout,'init','-b','main');git(checkout,'config','user.name','Fixture');git(checkout,'config','user.email','fixture@example.test');git(checkout,'config','gpg.format','ssh');git(checkout,'config','user.signingkey',path.join(root,'fixture-key'));git(checkout,'config','commit.gpgsign','true');
  db.prepare('INSERT INTO ledger_project_checkouts (id,project_id,root,name,default_branch,created_at,updated_at) VALUES (?,?,?,?,?,?,?)').run('c','p',checkout,'fixture','main',1,1);
  new LedgerStore(db).createIssue({project_id:'p',title:'Publish',body:'',kind:'feature',attribution:systemAction(),aliases:[{alias_kind:'git_bug_short',alias:'abc1234',source:'git_bug',is_primary:true}]});
  const created=createSpace(db,{project_id:'p',title:'Document',default_renderer:'document'});space=created.id;
  createSpaceBlock(db,space,{block_type:'paragraph',markdown:'original'});
});
afterEach(()=>{db.close();delete process.env.MANDIBLE_ARTIFACT_DIR;fs.rmSync(root,{recursive:true,force:true});});

it('freezes saved revision, retains failed proposal, refuses changed destination, and imports separately',async()=> {
  const repo=path.join(root,'repo');fs.writeFileSync(path.join(repo,'doc.md'),'destination');
  const publication=preparePublication(db,{spaceId:space,path:'doc.md',issue:'abc1234'});
  const originalBlock=listSpaceBlocks(db,space)[0];updateSpaceBlock(db,space,originalBlock.id,{markdown:'edited later'});
  expect(getPublication(db,space,publication.id).content).toContain('original');
  expect(serializeSpaceDocument(db,space)).toContain('edited later');
  expect(documentArtifactImportEffects(db, publication.snapshot_ref)).toEqual(['ledger:read', 'ledger:write']);
  expect(documentArtifactImportEffects(db, 'artifact-version:missing')).toContain('files:production');
  const copy=importManagedDocument(db,{ref:publication.snapshot_ref,title:'Copy',projectId:'p'});
  expect(copy.id).not.toBe(space);expect(listSpaceBlocks(db,copy.id)[0].markdown).toBe('original');
  updateSpaceBlock(db,copy.id,listSpaceBlocks(db,copy.id)[0].id,{markdown:'copy edit'});
  expect(getPublication(db,space,publication.id).content).toContain('original');
  const worktree=path.join(root,'proposal');fs.mkdirSync(worktree);fs.writeFileSync(path.join(worktree,'doc.md'),'destination');
  let commits=0;
  const runner:PublicationRunner={createWorktree:()=>worktree,commit:()=>{commits++;throw new Error('signing unavailable');},submit:()=>{throw new Error('must not submit');}};
  await expect(executePublication(db,space,publication.id,runner)).rejects.toThrow('signing unavailable');
  expect(fs.readFileSync(path.join(repo,'doc.md'),'utf8')).toBe('destination');
  expect(fs.readFileSync(path.join(worktree,'doc.md'),'utf8')).toBe(publication.content);
  expect(getPublication(db,space,publication.id).snapshot_ref).toBe(publication.snapshot_ref);
  fs.writeFileSync(path.join(repo,'doc.md'),'external edit');
  await expect(executePublication(db,space,publication.id,runner)).rejects.toThrow('Destination changed');
  expect(commits).toBe(1);expect(listSpaceBlocks(db,space)[0].markdown).toBe('edited later');
});

it('publishes the frozen bytes once, and later editing leaves Git publication pinned',async()=> {
  const repo=path.join(root,'repo');fs.writeFileSync(path.join(repo,'seed'),'seed');git(repo,'add','seed');git(repo,'commit','-m','Seed');
  const publication=preparePublication(db,{spaceId:space,path:'doc.md',issue:'abc1234'});
  updateSpaceBlock(db,space,listSpaceBlocks(db,space)[0].id,{markdown:'later'});
  let submissions=0;
  const runner:PublicationRunner={createWorktree:()=>repo,commit:(directory,value)=> {
    git(directory,'add',value.path);git(directory,'commit','-m','Fixture publication');return git(directory,'rev-parse','HEAD');
  },submit:()=>{submissions++;return 'fixture-auth';}};
  const published=await executePublication(db,space,publication.id,runner);
  expect(published.state).toBe('submitted');expect(published.version_ref).toBeTruthy();
  expect(git(repo,'show',`${published.commit_sha}:doc.md`)).toContain('original');
  expect(serializeSpaceDocument(db,space)).toContain('later');
  await executePublication(db,space,publication.id,runner);expect(submissions).toBe(1);
  expect(documentArtifactImportEffects(db, published.version_ref)).toContain('files:production');
  const imported=importManagedDocument(db,{ref:published.version_ref!,title:'Git import',projectId:'p'});
  expect(listSpaceBlocks(db,imported.id)[0].markdown).toBe('original');
});

it('preserves every legacy variant without touching checkout bytes and is restart-safe',()=> {
  const repo=path.join(root,'repo');
  fs.writeFileSync(path.join(repo,'doc.md'),'published');git(repo,'add','doc.md');git(repo,'commit','-m','Published');const commit=git(repo,'rev-parse','HEAD');
  const snapshot=recordArtifactVersion(db,{source_kind:'managed',series_key:'legacy',content:'pre-export',custody_mode:'managed'});
  const legacy=path.join(repo,'.git','mandible-docs-worktrees','docs_spaces');fs.mkdirSync(legacy,{recursive:true});fs.writeFileSync(path.join(legacy,'doc.md'),'unique dirty bytes');fs.writeFileSync(path.join(legacy,'ignored'),'ignored unique');
  db.prepare(`INSERT INTO space_exports (id,space_id,repo_id,branch,path,authority,status,last_export_blob_id,pre_export_snapshot_blob_id,last_export_commit,created_at,updated_at)
    VALUES (?,?,?,?,?,'repo','conflict',?,?,?,?,?)`).run('legacy',space,'c','docs/spaces','doc.md',snapshot.artifact_blob.id,snapshot.artifact_blob.id,commit,1,1);
  preserveLegacyDocuments(db);const history=listDocumentHistory(db,space);
  expect(history.find(value=>value.kind==='managed-before-migration')?.content).toContain('original');
  expect(history.find(value=>value.kind==='published-git')?.content).toBe('published');
  expect(history.find(value=>value.kind==='checkout-file')?.content).toBe('unique dirty bytes');
  expect(history.filter(value=>value.artifact_ref)).toHaveLength(2);
  preserveLegacyDocuments(db);expect(listDocumentHistory(db,space)).toEqual(history);
  expect(fs.readFileSync(path.join(legacy,'ignored'),'utf8')).toBe('ignored unique');
  expect(db.prepare('SELECT authority,status FROM space_exports').get()).toEqual({authority:'repo',status:'conflict'});
  expect(()=>db.prepare('UPDATE space_document_history SET content=?').run('overwrite')).toThrow('immutable');
});

it('migration separates clean, managed-only, Git-only, divergent and unreachable legacy documents',()=> {
  const repo=path.join(root,'repo');fs.writeFileSync(path.join(repo,'doc.md'),'published');git(repo,'add','doc.md');git(repo,'commit','-m','Published');const commit=git(repo,'rev-parse','HEAD');
  const fixtures=['clean','managed-only','git-only','both','unreachable'] as const;
  const snapshots=new Map<string,string>();
  for (const kind of fixtures) {
    const document=createSpace(db,{project_id:'p',title:kind,default_renderer:'document'});
    createSpaceBlock(db,document.id,{block_type:'paragraph',markdown:kind==='managed-only' || kind==='both' ? 'managed change':'published',metadata:{fixture:kind}});
    const branch=`docs/${kind}`,directory=path.join(repo,'.git','mandible-docs-worktrees',`docs_${kind}`);
    if(kind!=='unreachable') {fs.mkdirSync(directory,{recursive:true});fs.writeFileSync(path.join(directory,'doc.md'),kind==='git-only'||kind==='both' ? 'Git change':'published');fs.writeFileSync(path.join(directory,'unique-ignored'),'retained');}
    db.prepare(`INSERT INTO space_exports (id,space_id,repo_id,branch,path,authority,status,last_export_commit,created_at,updated_at) VALUES (?,?,?,?,?,'repo','conflict',?,?,?)`).run(kind,document.id,'c',branch,'doc.md',commit,1,1);
    snapshots.set(document.id,serializeSpaceDocument(db,document.id));
  }
  for(const trigger of ['space_publication_snapshot_immutable','space_document_history_immutable'])db.exec(`DROP TRIGGER ${trigger}`);
  db.exec('DROP TABLE space_publications');db.exec('DROP TABLE space_document_history');
  db.prepare("UPDATE meta SET value='189' WHERE key='schema_version'").run();
  migrate(db);
  for(const [id,content] of snapshots) {
    const history=listDocumentHistory(db,id);
    expect(history.find(value=>value.kind==='managed-before-migration')?.content).toBe(content);
    expect(history.find(value=>value.kind==='published-git')?.content).toBe('published');
    expect(serializeSpaceDocument(db,id)).toBe(content);
    const kind=(db.prepare('SELECT title FROM spaces WHERE id=?').get(id) as {title:string}).title;
    const working=history.find(value=>value.kind==='checkout-file');
    expect(working?.content).toBe(kind==='unreachable' ? null:kind==='git-only'||kind==='both' ? 'Git change':'published');
    if(kind!=='unreachable')expect(fs.readFileSync(path.join(repo,'.git','mandible-docs-worktrees',`docs_${kind}`,'unique-ignored'),'utf8')).toBe('retained');
  }
  const before=db.prepare('SELECT * FROM space_document_history ORDER BY id').all();migrate(db);
  expect(db.prepare('SELECT * FROM space_document_history ORDER BY id').all()).toEqual(before);
  expect(listDocumentHistory(db,space)).toEqual([]);
});

it('publication import retains embedded snapshots and metadata independently of the source',()=> {
  const embedded=createSpaceBlock(db,space,{block_type:'artifact_embed',markdown:'embed fallback',item_snapshot:{title:'Frozen attachment',ref_type:'artifact',ref_id:'historical'},metadata:{view:{zoom:2}}});
  const publication=preparePublication(db,{spaceId:space,path:'doc.md',issue:'abc1234'});
  updateSpaceBlock(db,space,embedded.id,{item_snapshot:{title:'Changed source'}});
  const imported=importManagedDocument(db,{ref:publication.snapshot_ref,title:'Snapshot import',projectId:'p'});
  const copied=listSpaceBlocks(db,imported.id).find(block=>block.block_type==='artifact_embed');
  expect(copied?.item_snapshot?.title).toBe('Frozen attachment');expect(copied?.metadata.view).toEqual({zoom:2});
});
