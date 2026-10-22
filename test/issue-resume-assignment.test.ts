import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { openDb, setDb, type Db } from '../../src/db.js';
import { addProject, addOrUpdateCheckout } from '../../src/ledger/project-registry.js';
import { registerIssueRoutes } from '../../src/routes/issues.js';
import { setupOperator } from '../../src/users/store.js';
import { authenticatedTestRouter } from '../helpers/authenticated-router.js';
let db:Db,root:string;
beforeEach(()=>{root=mkdtempSync(join(tmpdir(),'mandible-resume-proof-'));db=openDb(':memory:');setDb(db);const project=addProject(db,{project_key:'mandible',display_name:'Mandible'});addOrUpdateCheckout(db,project.id,{root,work_repo_id:'mandible',name:'Mandible'});});
afterEach(()=>{db.close();rmSync(root,{recursive:true,force:true});});
async function setup() {
 const router=authenticatedTestRouter(setupOperator(db,{display_name:'Operator'}));
 let checkout:string|null=root;
 const scanner={getRepos:()=>[{id:'mandible',root,name:'Mandible'}],getRepoById:()=>({id:'mandible',root,name:'Mandible'}),getBranches:()=>checkout?[{branch:'feature/exact',worktree_path:checkout}]:[]};
 const control={getSnapshot:vi.fn(()=>({ok:true,value:{revision:0,ownership:{kind:'none',generation:0}}})),resume:vi.fn(async()=>({ok:true,value:{ownership:{kind:'mandible',generation:1}}})),stop:vi.fn(async()=>({ok:true,value:undefined})),ownsController:vi.fn(async()=>true)};
 registerIssueRoutes(router,scanner as never,{conversationControl:control as never,sessionAliasResolver:()=>({provider:'codex',provider_session_id:'native'}) as never});
 const created=await router.invoke({method:'POST',url:'/api/issues/mandible',body:{title:'Exact resume',body:'Resume existing assignment',project:'mandible',kind:'maintenance'}});
 expect(created.status).toBe(200);const issue=(created.body as {id:string}).id;
 db.prepare("INSERT INTO work_units (id,issue_id,ledger_issue_id,repo_id,branch,state,assigned_session_id,provider,custody_generation,created_at) VALUES ('unit',?,?,'mandible','feature/exact','committed','assigned','codex',2,1)").run(issue,issue);
 db.prepare(`INSERT INTO conversations (id,source,source_path,source_hash,source_mtime,title,started_at,block_count,session_id,cwd,created_at,updated_at) VALUES ('chat','codex','/tmp/history','hash',1,'Existing','2026-01-01',0,'native',?,'2026-01-01','2026-01-01')`).run(root);
 const send=(body:unknown)=>router.invoke({method:'POST',url:`/api/issues/mandible/${issue}/spawn`,body});
 return {send,control,missingCheckout(){checkout=null;}};
}
it('requires an exact current assignment and preserves the provider, checkout, and custody',async()=>{
 const {send,control}=await setup();
 expect((await send({})).status).toBe(400);
 expect((await send({work_unit_id:'unit',expected_custody_generation:1})).status).toBe(409);
 const before=db.prepare("SELECT * FROM work_units WHERE id='unit'").get();
 const resumed=await send({work_unit_id:'unit',expected_custody_generation:2});
 expect(resumed.status).toBe(200);expect(resumed.body).toMatchObject({conversation_id:'chat',work_unit_id:'unit',cwd:root,custody_generation:2});
 expect(control.resume).toHaveBeenCalledWith({conversation_id:'chat',expected_revision:0,expected_generation:0,cwd:root});
 expect(db.prepare("SELECT * FROM work_units WHERE id='unit'").get()).toEqual(before);
});
it('refuses a missing checkout and stops only its acquired controller when assignment drifts',async()=>{
 const first=await setup();first.missingCheckout();
 expect((await first.send({work_unit_id:'unit',expected_custody_generation:2})).body).toMatchObject({error:'assigned_checkout_unavailable'});
 expect(first.control.resume).not.toHaveBeenCalled();
});
it('checks assignment again after asynchronous native acquisition',async()=>{
 const {send,control}=await setup();
 control.resume.mockImplementationOnce(async()=>{db.prepare("UPDATE work_units SET custody_generation=3 WHERE id='unit'").run();return {ok:true,value:{ownership:{kind:'mandible',generation:1}}};});
 const response=await send({work_unit_id:'unit',expected_custody_generation:2});
 expect(response.status).toBe(409);expect(response.body).toMatchObject({error:'assignment_changed_during_resume'});expect(control.stop).toHaveBeenCalledWith('chat',1);
});
