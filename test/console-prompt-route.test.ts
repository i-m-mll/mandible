import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { openDb, setDb, type Db } from '../../src/db.js';
import { registerConsoleRoutes } from '../../src/routes/console.js';
import { authenticatedTestRouter } from '../helpers/authenticated-router.js';
import { setupOperator, createUser } from '../../src/users/store.js';
let db:Db;
beforeEach(()=>{db=openDb(':memory:');setDb(db);});
afterEach(()=>db.close());
function routes(kind:'operator'|'agent'='operator') {
 const operator=setupOperator(db,{display_name:'Operator'});
 const agent=createUser(db,{slug:'terminal-agent',kind:'agent',display_name:'Agent'});
 const router=authenticatedTestRouter(kind==='operator'?operator:agent);
 const terminal={meta:{id:'terminal',backend_type:'pty',channel_enabled:false,is_operator:true,status:'running'}};
 const history={meta:{id:'history',backend_type:'sdk',channel_enabled:true,is_operator:false,status:'stopped',provider_session_id:'native'}};
 const manager={get:vi.fn((id:string)=>id==='terminal'?terminal:id==='history'?history:undefined),isCredentialBearing:(id:string)=>id==='terminal',write:vi.fn(),start:vi.fn(),stop:vi.fn(),delete:vi.fn(),create:vi.fn(()=>({id:'new-terminal'}))};
 registerConsoleRoutes(router,manager as never);
 return {router,manager};
}
it('writes explicit input only to the real operator terminal',async()=>{
 const {router,manager}=routes();
 const response=await router.invoke({method:'POST',url:'/api/console/sessions/terminal/prompt',body:{prompt:'echo ready'}});
 expect(response.status).toBe(202);expect(manager.write).toHaveBeenCalledWith('terminal','echo ready\r');
});
it('keeps physical operator terminal input protected from agents',async()=>{
 const {router,manager}=routes('agent');
 const response=await router.invoke({method:'POST',url:'/api/console/sessions/terminal/prompt',body:{prompt:'echo ready'}});
 expect(response.status).toBe(403);expect(manager.write).not.toHaveBeenCalled();
});
it('preserves historical managed sessions and refuses alternate managed mutations',async()=>{
 const {router,manager}=routes();
 for(const [method,url,body] of [['POST','/api/console/sessions/history/prompt',{prompt:'hello'}],['POST','/api/console/sessions/history/start',{}],['DELETE','/api/console/sessions/history',{}]] as const){
  const response=await router.invoke({method,url,body});expect(response.status).toBe(410);expect(response.body).toMatchObject({error:'conversation_control_required'});
 }
 expect(manager.write).not.toHaveBeenCalled();expect(manager.start).not.toHaveBeenCalled();expect(manager.delete).not.toHaveBeenCalled();
});
it('creates genuine terminal records and rejects managed provider creation',async()=>{
 const {router,manager}=routes();
 const managed=await router.invoke({method:'POST',url:'/api/console/sessions',body:{command:'claude',backend_type:'sdk'}});
 expect(managed.status).toBe(422);expect(manager.create).not.toHaveBeenCalled();
 const shell=await router.invoke({method:'POST',url:'/api/console/sessions',body:{command:'/bin/sh',backend_type:'pty'}});
 expect(shell.status).toBe(201);expect(manager.create).toHaveBeenCalledWith(expect.objectContaining({command:'/bin/sh',backend_type:'pty',transport_lane:'pty'}));
});
