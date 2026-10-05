import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import SqliteDatabase from "../src/sqlite.ts";
import { MIGRATIONS } from '../dist/db-migrations.js';
import { evaluateProjectAccess } from '../dist/permissions/store.js';
import { artifactAccessProjectIds } from '../dist/permissions/resources.js';

// Input must be a separately captured SQLite backup, never the live database.
const input = path.resolve(process.argv[2] ?? '');
const output = process.argv[3] && path.resolve(process.argv[3]);
if (!output || input === output || fs.existsSync(output)) throw new Error('Usage: bun scripts/prove-artifact-source-migration.mjs <isolated-backup.db> <new-output.db>');
fs.copyFileSync(input, output, fs.constants.COPYFILE_EXCL);
const db = new SqliteDatabase(output);
db.pragma('foreign_keys=ON');
assert.equal(db.prepare("SELECT value FROM meta WHERE key='schema_version'").get().value, '183');
const hash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const sets = () => ({
  artifacts: db.prepare('SELECT id,identity_key,latest_version_id,version_count FROM artifact ORDER BY id').all(),
  versions: db.prepare('SELECT id,artifact_id,version_no,blob_id,source_kind,content_hash,source_repo_id,repo_path,commit_sha,observed_path,source_locator_json,custody_mode,label,note,metadata_json,created_at FROM artifact_version ORDER BY id').all(),
  blobs: db.prepare('SELECT * FROM artifact_blob ORDER BY id').all(),
  associations: db.prepare('SELECT * FROM project_artifact_associations ORDER BY id').all(),
  references: db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND (name LIKE 'briefing%' OR name IN ('artifact_links','artifact_aliases','artifact_drafts')) ORDER BY name").all()
    .map(({name}) => ({name,rows:db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all()})),
});
const oldAccess = id => db.prepare(`SELECT DISTINCT project_id FROM (
 SELECT source_project_id project_id FROM artifact WHERE id=? AND source_project_id IS NOT NULL UNION
 SELECT source_project_id FROM artifact_version WHERE id=? AND source_project_id IS NOT NULL UNION
 SELECT source_project_id FROM artifact_version WHERE artifact_id=? AND source_project_id IS NOT NULL UNION
 SELECT project_id FROM project_artifact_associations WHERE target_id=? AND status='active' UNION
 SELECT a.source_project_id FROM artifact_version v JOIN artifact a ON a.id=v.artifact_id WHERE v.id=? AND a.source_project_id IS NOT NULL UNION
 SELECT pa.project_id FROM project_artifact_associations pa JOIN artifact_version v ON v.id=pa.target_id WHERE pa.target_type='artifact_version' AND v.artifact_id=? AND pa.status='active'
) ORDER BY project_id`).all(id,id,id,id,id,id).map(row=>row.project_id);
const before = sets();
const ids = [...before.artifacts,...before.versions].map(row=>row.id);
const access = new Map(ids.map(id=>[id,oldAccess(id)]));
const fkBefore = db.pragma('foreign_key_check');
const started = performance.now();
// This proof is specifically the v183-to-v184 source migration, not custody recovery.
const sourceMigration=MIGRATIONS.find(migration=>migration.version===184);
assert(sourceMigration);
db.transaction(()=>{
  for(const statement of sourceMigration.statements) db.exec(statement);
  db.prepare("UPDATE meta SET value='184' WHERE key='schema_version'").run();
})();
const migrationMs = performance.now()-started;
const after = sets();
for (const field of ['artifacts','versions','blobs','references']) assert.deepEqual(after[field],before[field]);
for (const row of before.associations) assert.deepEqual(after.associations.find(next=>next.id===row.id),row);
const identities = [null,...db.prepare("SELECT id user_id,slug FROM users WHERE status='active'").all()];
const decision = (projects,identity,role) => projects.length===0 ? true : projects.length>1 ? false
  : evaluateProjectAccess(db,{identity,project_id:projects[0],required_role:role}).allowed;
const decisions = {compared:0,identical:0,tightened:0,widened:0};
const changed = [];
for (const id of ids) {
  const previous = access.get(id), next = artifactAccessProjectIds(db,id);
  assert(previous.every(project=>next.includes(project)), `Access constraint removed for ${id}`);
  if (JSON.stringify(previous)!==JSON.stringify(next)) changed.push({id,previous,next});
  for (const identity of identities) for (const role of ['read','write']) {
    const was=decision(previous,identity,role), now=decision(next,identity,role);decisions.compared++;
    if (was===now) decisions.identical++; else if(was) decisions.tightened++; else decisions.widened++;
  }
}
assert.equal(decisions.widened,0);
const foreignKeys=db.pragma('foreign_key_check');assert.deepEqual(foreignKeys,fkBefore);
const integrity=db.pragma('integrity_check');assert.deepEqual(integrity,[{integrity_check:'ok'}]);
assert.equal(db.prepare("SELECT COUNT(*) n FROM artifact_source WHERE reconciliation_reason='migration_pending'").get().n,0);
const report = {
  schema:184,migration_ms:migrationMs,
  inventory:db.prepare('SELECT source_kind,COUNT(*) artifacts,SUM(version_count) versions FROM artifact GROUP BY source_kind').all(),
  preserved:Object.fromEntries(['artifacts','versions','blobs','references'].map(field=>[field,{sha256:hash(before[field]),rows:before[field].length}])),
  associations:{before:before.associations.length,after:after.associations.length,original_rows_unchanged:true},
  effective_access_decisions:decisions,
  access:{compared:ids.length,unchanged:ids.length-changed.length,tightened:changed.length,widened:0,changes:changed},
  source_states:db.prepare('SELECT a.source_kind,s.reconciliation_reason,COUNT(*) n FROM artifact_source s JOIN artifact a ON a.id=s.artifact_id GROUP BY a.source_kind,s.reconciliation_reason').all(),
  foreign_keys:foreignKeys,integrity,
};
fs.writeFileSync(`${output}.proof.json`,JSON.stringify(report,null,2));
console.log(JSON.stringify({...report,access:{...report.access,changes:undefined}},null,2));
db.close();
