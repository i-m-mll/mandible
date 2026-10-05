import { useQuery } from '@tanstack/preact-query';
import { queryClient } from '../../query/client';
import { browserResourceKeys } from '../../query/browserResources';
import { useEffect, useState } from 'preact/hooks';
import { DetailPaneShell } from '../../components/shared/DetailPaneShell';
import { DetailPaneHeader } from '../../components/shared/DetailPaneHeader';
import { DetailPaneNotice } from '../../components/shared/DetailPaneNotice';
import { getArtifactContent, getSpacePublications, prepareSpacePublication, submitSpacePublication, importSpaceDocument, importSpaceHistory,
  type SpacePublication, type SpaceDocumentHistory } from '../../api';
import { readExportDialogState, writeExportDialogState } from './exportDialogState';
import './SpaceExportDialog.css';

export function SpaceExportDialog({ spaceId,projectId,onClose,onImported }: {
  spaceId:string; projectId:string; onClose:()=>void; onImported?:()=>void;
}): JSX.Element {
  const [view,setView]=useState(()=>readExportDialogState(projectId,spaceId));
  const {issue,ref,title,gitPath,gitCommit}=view;
  const setIssue=(issue:string)=>setView(current=>({...current,issue}));
  const setRef=(ref:string)=>setView(current=>({...current,ref}));
  const setTitle=(title:string)=>setView(current=>({...current,title}));
  const setGitPath=(gitPath:string)=>setView(current=>({...current,gitPath}));
  const setGitCommit=(gitCommit:string)=>setView(current=>({...current,gitCommit}));
  const key=[...browserResourceKeys.spaceDocument(spaceId),'publications'];
  const query=useQuery({queryKey:key,queryFn:({signal})=>getSpacePublications(spaceId,signal),refetchOnWindowFocus:true},queryClient);
  const publications=query.data?.publications ?? [];
  const history=query.data?.history ?? [];
  const ready=Boolean(query.data);
  const destinations=query.data?.destinations ?? [];
  const setPublications=(update:(current:SpacePublication[])=>SpacePublication[])=> {
    queryClient.setQueryData<NonNullable<typeof query.data>>(key,current=>current ? {...current,publications:update(current.publications)}:current);
  };
  const selected=[...publications,...history].find(value=>value.id===view.selectedId) ?? null;
  const selectedArtifact=selected && 'artifact_ref' in selected ? selected.artifact_ref : null;
  const historicalContent=useQuery({queryKey:[...key,'history',selectedArtifact],enabled:Boolean(selectedArtifact && selected?.content===null),
    queryFn:({signal})=>getArtifactContent(selectedArtifact!,{signal})},queryClient);
  const setSelected=(selected:SpacePublication | SpaceDocumentHistory)=>setView(current=>({...current,selectedId:selected.id}));
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState<string | null>(null);
  useEffect(()=>writeExportDialogState(projectId,spaceId,view),[projectId,spaceId,view]);
  async function action(operation:()=>Promise<void>) {
    setBusy(true);setError(null);
    try {await operation();} catch(failure){setError(failure instanceof Error ? failure.message:String(failure));}
    finally {setBusy(false);}
  }
  return <section role="dialog" aria-modal="true" aria-label="Document publication" className="space-export-dialog">
    <DetailPaneShell
      header={<DetailPaneHeader variant="compact" title="Publish document" actions={<button onClick={onClose}>Close</button>}/>}
      notice={error || query.error ? <DetailPaneNotice severity="error">{error ?? query.error?.message}</DetailPaneNotice>:null}
      footer={{content:<>
        <a href={`/api/spaces/${encodeURIComponent(spaceId)}/document/download`} download>Download current document</a>
        <button disabled={busy || !ready || !view.path.trim() || !issue.trim() || (!projectId && !view.checkoutId)} onClick={()=>void action(async()=> {
          const publication=await prepareSpacePublication(spaceId,{path:view.path.trim(),issue:issue.trim(),message:view.message,repo_id:view.checkoutId || undefined});
          setPublications(current=>[publication,...current]);setSelected(publication);
        })}>Prepare snapshot</button>
      </>}}
    >
      <p>Editing continues in Spaces. A publication freezes the saved revision, then creates a signed proposal for protected delivery.</p>
      <label className="space-export-dialog__field">Destination checkout<select value={view.checkoutId} onChange={event=>setView(current=>({...current,checkoutId:event.currentTarget.value}))}>
        <option value="">{projectId ? 'Default project checkout':'Choose a checkout'}</option>
        {destinations.map(destination=><option key={destination.id} value={destination.id}>{destination.project_name} / {destination.name}</option>)}
      </select></label>
      <label className="space-export-dialog__field">Destination path<input value={view.path} placeholder="docs/document.md" onInput={event=>setView(current=>({...current,path:event.currentTarget.value}))}/></label>
      <label className="space-export-dialog__field">Issue<input value={issue} onInput={event=>setIssue(event.currentTarget.value)}/></label>
      <label className="space-export-dialog__field">Change message<input value={view.message} onInput={event=>setView(current=>({...current,message:event.currentTarget.value}))}/></label>
      {selected && <section aria-label="Selected immutable material">
        <h3>{'state' in selected ? `Publication: ${selected.state}`:selected.kind}</h3>
        {selected.content !== null ? <pre style={{whiteSpace:'pre-wrap'}}>{selected.content}</pre>
          : historicalContent.data?.preview ? <pre style={{whiteSpace:'pre-wrap'}}>{historicalContent.data.preview.raw_text ?? historicalContent.data.preview.text}</pre>
          : historicalContent.error || historicalContent.data?.status==='unavailable' || !selectedArtifact
            ? <DetailPaneNotice severity="error">{historicalContent.error?.message ?? historicalContent.data?.reason ?? 'Checkout unavailable; preservation details below.'}</DetailPaneNotice>:null}
        {selectedArtifact && <a href={`/api/artifacts/${encodeURIComponent(selectedArtifact)}/download`} download>Download exact historical material</a>}
        {'provenance_json' in selected && <details><summary>Preservation details</summary><pre>{selected.provenance_json}</pre></details>}
        {'state' in selected && selected.state !== 'submitted' && <button disabled={busy} onClick={()=>void action(async()=> {
          const result=await submitSpacePublication(spaceId,selected.id);
          setPublications(current=>current.map(value=>value.id===result.id ? result:value));setSelected(result);
        })}>Submit reviewed snapshot for approval</button>}
        {'state' in selected && selected.auth_request_id && <p>Submitted for approval. The Git version remains pinned after further edits.</p>}
        {'artifact_ref' in selected && (selected.artifact_ref || selected.content !== null) && <button disabled={busy} onClick={()=>void action(async()=> {
          await importSpaceHistory(spaceId,selected.id,`Imported ${selected.kind}`);onImported?.();
        })}>Import as separate managed copy</button>}
      </section>}
      <h3>Publications</h3>
      {ready && publications.length===0 && <p>No publication snapshots yet.</p>}
      {publications.map(value=><p key={value.id}><button onClick={()=>setSelected(value)}>{value.path} · {value.state}</button></p>)}
      {history.length>0 && <><h3>Preserved documents</h3><p>Managed, published, and checkout variants are separate. Existing checkout files remain in place.</p>
        {history.map(value=><p key={value.id}><button onClick={()=>setSelected(value)}>{value.kind}</button></p>)}
      </>}
      <h3>Import immutable material</h3>
      <label className="space-export-dialog__field">Git commit<input value={gitCommit} onInput={event=>setGitCommit(event.currentTarget.value)}/></label>
      <label className="space-export-dialog__field">Git path<input value={gitPath} onInput={event=>setGitPath(event.currentTarget.value)}/></label>
      <button disabled={busy || !projectId || !gitCommit.trim() || !gitPath.trim() || !title.trim()} onClick={()=>void action(async()=> {
        await importSpaceDocument({project:projectId,commit:gitCommit.trim(),path:gitPath.trim(),title:title.trim(),project_id:projectId});onImported?.();
      })}>Import Git version as separate managed copy</button>
      <label className="space-export-dialog__field">Artifact version reference<input value={ref} onInput={event=>setRef(event.currentTarget.value)}/></label>
      <label className="space-export-dialog__field">New document title<input value={title} onInput={event=>setTitle(event.currentTarget.value)}/></label>
      <button disabled={busy || !ref.trim() || !title.trim()} onClick={()=>void action(async()=> {
        await importSpaceDocument({ref:ref.trim(),title:title.trim(),project_id:projectId});onImported?.();
      })}>Import as separate managed copy</button>
    </DetailPaneShell>
  </section>;
}
export default SpaceExportDialog;
