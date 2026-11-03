import path from 'node:path';
import { createHash } from 'node:crypto';
import * as z from 'zod';
import type { Db } from '../db.js';
import { createCanonicalProjectResolver, type ConversationSidebarProject, type ConversationSidebarRow } from '../conversations/sidebar-projection.js';
import { conversationSidebarCandidates } from '../ledger-reads/conversations.js';
import { mutateLedgerRecord } from './mutation-history.js';
import { resolveProjectRef } from './project-registry.js';

export type HistoricalRootEvidence = {kind:'attestation';reference:string} | {kind:'relocation';checkout_id:string;new_root:string};
export const HistoricalRootRequestSchema=z.object({root:z.string().trim().min(1),evidence:z.string().trim().min(1),apply:z.boolean().optional()}).strict();
export type HistoricalRootRequest=z.infer<typeof HistoricalRootRequestSchema>;

/** Only conversation association consumes these records; active checkout authority is unchanged. */
export function recordHistoricalProjectRoot(db:Db,input:{project_id:string;root:string;evidence:HistoricalRootEvidence},now=Date.now()):void {
  const key=createHash('sha256').update(JSON.stringify([input.project_id,input.root])).digest('hex');
  mutateLedgerRecord(db,{entity_type:'historical_project_root',entity_id:key,project_id:input.project_id,
    snapshot:()=>db.prepare('SELECT * FROM ledger_project_historical_roots WHERE project_id=? AND root=?').get(input.project_id,input.root) ?? null,
  },()=>db.prepare('INSERT INTO ledger_project_historical_roots(project_id,root,evidence_json,recorded_at) VALUES (?,?,?,?) ON CONFLICT(project_id,root) DO NOTHING')
    .run(input.project_id,input.root,JSON.stringify(input.evidence),now));
}

function projectionCounts(rows:readonly ConversationSidebarRow[],before:ConversationSidebarProject[],after:ConversationSidebarProject[],projectId:string) {
  const prior=createCanonicalProjectResolver(before),next=createCanonicalProjectResolver(after);
  let beforeCount=0,afterCount=0,changed=0,newlyAssociated=0,unresolved=0;
  for(const row of rows) {
    const from=prior(row)?.id ?? null,to=next(row)?.id ?? null;
    beforeCount+=Number(from===projectId);afterCount+=Number(to===projectId);
    changed+=Number(from!==to);newlyAssociated+=Number(from!==projectId && to===projectId);
    unresolved+=Number(from!==null && to===null);
  }
  return {before:beforeCount,after:afterCount,changed,newly_associated:newlyAssociated,newly_unresolved:unresolved};
}

export function backfillHistoricalProjectRoot(db:Db,projectRef:string,input:HistoricalRootRequest) {
  const resolved=resolveProjectRef(db,projectRef);
  if(!resolved.ok) return {ok:false as const,error:{code:resolved.reason==='ambiguous' ? 'ambiguous_project' : 'not_found',message:'A unique canonical project is required.'}};
  if(!path.isAbsolute(input.root) || path.normalize(input.root)===path.parse(input.root).root) return {ok:false as const,error:{code:'invalid_root',message:'An absolute historical checkout directory is required.'}};
  if(!input.evidence.trim()) return {ok:false as const,error:{code:'invalid_evidence',message:'Historical root evidence is required.'}};
  const project=resolved.project,root=path.resolve(input.root);
  const run=db.transaction(()=>{
    const all=conversationSidebarCandidates(db,{query:{}});
    const sidebar=conversationSidebarCandidates(db,{query:{exclude_subagents:'true',min_blocks:'1'}});
    if(!all.ok || !sidebar.ok) throw new Error('Default conversation projection is invalid.');
    const projects=all.projects;
    const after=projects.map(candidate=>candidate.id===project.id ? {...candidate,historical_roots:[...new Set([...(candidate.historical_roots ?? []),root])]} : candidate);
    const existing=db.prepare('SELECT evidence_json,recorded_at FROM ledger_project_historical_roots WHERE project_id=? AND root=?').get(project.id,root) as {evidence_json:string;recorded_at:number}|undefined;
    const evidence:HistoricalRootEvidence=existing ? JSON.parse(existing.evidence_json) : {kind:'attestation',reference:input.evidence.trim()};
    const report={project_id:project.id,root,existing:Boolean(existing),applied:input.apply===true,evidence,
      active_conversations:projectionCounts(all.rows,projects,after,project.id),
      sidebar_conversations:projectionCounts(sidebar.rows,projects,after,project.id)};
    if(input.apply) recordHistoricalProjectRoot(db,{project_id:project.id,root,evidence});
    return {ok:true as const,value:report};
  });
  return input.apply ? run.immediate() : run.deferred();
}
