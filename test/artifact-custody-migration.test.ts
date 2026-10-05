import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import SqliteDatabase from "../src/sqlite.ts";
import { expect, it } from 'vitest';
import { CURRENT_SCHEMA_VERSION, MIGRATIONS, migrate } from '../src/db-migrations.js';
import { readArtifactBytesFull } from '../src/artifact-content.js';

it('recovers populated v184 custody before installing v185 and preserves exact version identity',()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'mandible-custody-migration-'));
  const oldRoot=process.env.MANDIBLE_ARTIFACT_DIR;
  process.env.MANDIBLE_ARTIFACT_DIR=path.join(root,'cas');
  const db=new SqliteDatabase(path.join(root,'ledger.db'));
  try {
    db.exec(fs.readFileSync('test/fixtures/schema-v158.sql','utf8'));
    db.function('mandible_sha256',{deterministic:true},(value:unknown)=>createHash('sha256').update(String(value)).digest('hex'));
    for(const migration of MIGRATIONS.filter(m=>m.version>158 && m.version<=184)) {
      db.transaction(()=>{for(const statement of migration.statements) db.exec(statement);})();
    }
    db.prepare("UPDATE meta SET value='184' WHERE key='schema_version'").run();
    const repo=path.join(root,'repo');fs.mkdirSync(repo);
    const git=(...args:string[])=>execFileSync('git',['-C',repo,...args],{encoding:'utf8'}).trim();
    git('init','-b','main');git('config','user.name','Test');git('config','user.email','test@example.invalid');git('config','commit.gpgsign','false');
    fs.writeFileSync(path.join(repo,'report.md'),'committed bytes');fs.writeFileSync(path.join(repo,'collision.md'),'collision bytes');git('add','.');git('commit','-m','report');
    const commit=git('rev-parse','HEAD');
    db.prepare("INSERT INTO ledger_projects(id,project_key,display_name,created_at,updated_at) VALUES('prj_fixture','fixture','fixture',1,1)").run();
    db.prepare("INSERT INTO ledger_project_checkouts(id,project_id,root,name,work_repo_id,created_at,updated_at) VALUES('checkout_fixture','prj_fixture',?,'fixture','fixture',1,1)").run(repo);
    for(const [name,body] of [['git','committed bytes'],['managed','stored bytes'],['collision-a','collision bytes'],['collision-b','collision bytes']]) {
      const hash=createHash('sha256').update(body).digest('hex');
      const file=path.join(root,name);fs.writeFileSync(file,body);
      const blob=`artifact-blob:${hash}`, artifact=`artifact:${name}`, version=`artifact-version:${name}`;
      db.prepare('INSERT OR IGNORE INTO artifact_blob(id,content_hash,storage_uri,custody_mode,availability,created_at) VALUES(?,?,?,?,?,1)').run(blob,hash,name==='managed'?`file://${file}`:null,name!=='managed'?'link':'copy','present');
      db.prepare("INSERT INTO artifact(id,identity_key,source_kind,latest_version_id,version_count,created_at,updated_at) VALUES(?,?,'managed',?,1,1,1)").run(artifact,name,version);
      db.prepare(`INSERT INTO artifact_version(id,artifact_id,version_no,blob_id,source_kind,content_hash,source_project_id,source_repo_id,repo_path,commit_sha,custody_mode,created_at)
        VALUES(?,?,1,?,?,?,?,?,?,?,?,1)`).run(version,artifact,blob,name!=='managed'?'tracked_repo':'managed',hash,'prj_fixture','fixture',name==='git'?'report.md':name.startsWith('collision')?'collision.md':null,name!=='managed'?commit:null,name!=='managed'?'link':'copy');
    }
    db.exec("INSERT INTO artifact_source SELECT id,NULL,1,'historical_source_ambiguous',1 FROM artifact");
    const metadata=JSON.stringify({title:'keep',custom:{caption:'keep'},provenance:{author:'keep',artifact_recovery:{original:{repo_locator:{path:'old'}}}},nested:{custody:{mode:'external'},description:'keep'},repo_locator:{path:'old'},git:{commit:'old'}});
    for(const table of ['artifact','artifact_blob','artifact_version']) db.prepare(`UPDATE ${table} SET metadata_json=?`).run(metadata);
    migrate(db);
    for(const table of ['artifact','artifact_blob','artifact_version']) {
      const rows=db.prepare(`SELECT metadata_json FROM ${table}`).all() as {metadata_json:string}[];
      for(const row of rows) expect(JSON.parse(row.metadata_json)).toEqual({title:'keep',custom:{caption:'keep'},provenance:{author:'keep'},nested:{description:'keep'}});
    }
    expect(db.prepare("SELECT value FROM meta WHERE key='schema_version'").get()).toEqual({value:String(CURRENT_SCHEMA_VERSION)});
    expect(db.prepare('SELECT id,custody_mode,source_project_id FROM artifact_version ORDER BY id').all()).toEqual([
      {id:'artifact-version:collision-a',custody_mode:'git',source_project_id:'prj_fixture'},
      {id:'artifact-version:collision-b',custody_mode:'git',source_project_id:'prj_fixture'},
      {id:'artifact-version:git',custody_mode:'git',source_project_id:'prj_fixture'},
      {id:'artifact-version:managed',custody_mode:'managed',source_project_id:null},
    ]);
    fs.unlinkSync(path.join(root,'managed'));fs.writeFileSync(path.join(repo,'report.md'),'changed');
    expect(readArtifactBytesFull(db,'artifact-version:git')).toMatchObject({ok:true,bytes:Buffer.from('committed bytes')});
    expect(readArtifactBytesFull(db,'artifact-version:managed')).toMatchObject({ok:true,bytes:Buffer.from('stored bytes')});
    expect(git('rev-parse',`refs/mandible/artifacts/${commit}`)).toBe(commit);
    expect(db.prepare("SELECT project_id FROM project_artifact_associations WHERE target_id='artifact-version:managed' AND role='historical-source-access'").get()).toEqual({project_id:'prj_fixture'});
    expect(db.prepare('SELECT COUNT(*) n FROM artifact_source WHERE reconciliation_reason IS NOT NULL').get()).toEqual({n:0});
    expect(db.prepare('SELECT COUNT(*) n FROM artifact_source_move').get()).toEqual({n:4});
    const receipts=fs.readdirSync(path.join(root,'repairs/artifact-recovery')).filter(name=>name.endsWith('.receipt.json'));
    const receipt=JSON.parse(fs.readFileSync(path.join(root,'repairs/artifact-recovery',receipts[0]),'utf8'));
    expect(receipt.artifacts.every((row:any)=>row.metadata_json===metadata)).toBe(true);
    expect(receipt.sources).toHaveLength(4);
    const sources=JSON.parse(fs.readFileSync(path.join(root,'repairs/artifact-recovery',receipts[0]+'.sources.json'),'utf8'));
    expect(sources.decisions.filter((row:any)=>row.basis==='collision-managed')).toHaveLength(2);
    for (const id of ['artifact:collision-a','artifact:collision-b']) {
      expect(JSON.parse((db.prepare('SELECT source_json FROM artifact_source WHERE artifact_id=?').get(id) as any).source_json)).toEqual({kind:'managed',key:id});
    }
    expect(db.pragma('foreign_key_check')).toEqual([]);
    expect(()=>migrate(db)).not.toThrow();
  } finally {
    db.close();fs.rmSync(root,{recursive:true,force:true});
    if(oldRoot===undefined) delete process.env.MANDIBLE_ARTIFACT_DIR;else process.env.MANDIBLE_ARTIFACT_DIR=oldRoot;
  }
});
