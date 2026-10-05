import { useEffect, useState } from 'preact/hooks';
import { DetailPaneShell } from '../../components/shared/DetailPaneShell';
import { DetailPaneHeader } from '../../components/shared/DetailPaneHeader';
import { DetailPaneNotice } from '../../components/shared/DetailPaneNotice';
import { getSpacePublications, prepareSpacePublication, submitSpacePublication, importSpaceDocument,
  type SpacePublication, type SpaceDocumentHistory } from '../../api';
import { readExportDialogState, writeExportDialogState } from './exportDialogState';
import './SpaceExportDialog.css';

export function SpaceExportDialog({ spaceId,projectId,onClose,onImported }: {
  spaceId:string; projectId:string; onClose:()=>void; onImported?:()=>void;
}): JSX.Element {
  const [view,setView]=useState(()=>readExportDialogState(projectId,spaceId));
  const [issue,setIssue]=useState('');
  const [ref,setRef]=useState('');
  const [title,setTitle]=useState('Imported document');
  const [publications,setPublications]=useState<SpacePublication[]>([]);
  const [history,setHistory]=useState<SpaceDocumentHistory[]>([]);
  const [selected,setSelected]=useState<SpacePublication | SpaceDocumentHistory | null>(null);
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState<string | null>(null);
  const [ready,setReady]=useState(false);
  useEffect(()=>writeExportDialogState(projectId,spaceId,view),[projectId,spaceId,view]);
  useEffect(()=> {
    let active=true;
    getSpacePublications(spaceId).then(result=> {
      if(active) { setPublications(result.publications);setHistory(result.history);setReady(true); }
    }).catch(failure=>{if(active)setError(String(failure));});
    return ()=>{active=false;};
  },[spaceId]);
  async function action(operation:()=>Promise<void>) {
    setBusy(true);setError(null);
    try {await operation();} catch(failure){setError(failure instanceof Error ? failure.message:String(failure));}
    finally {setBusy(false);}
  }
  return <section role="dialog" aria-modal="true" aria-label="Document publication" className="space-export-dialog">
    <DetailPaneShell
      header={<DetailPaneHeader variant="compact" title="Publish document" actions={<button onClick={onClose}>Close</button>}/>}
      notice={error ? <DetailPaneNotice severity="error">{error}</DetailPaneNotice>:null}
      footer={{content:<>
        <a href={`/api/spaces/${encodeURIComponent(spaceId)}/document/download`} download>Download current document</a>
        <button disabled={busy || !ready || !view.path.trim() || !issue.trim()} onClick={()=>void action(async()=> {
          const publication=await prepareSpacePublication(spaceId,{path:view.path.trim(),issue:issue.trim(),message:view.message});
          setPublications(current=>[publication,...current]);setSelected(publication);
        })}>Prepare snapshot</button>
      </>}}
    >
      <p>Editing continues in Spaces. A publication freezes the saved revision, then creates a signed proposal for protected delivery.</p>
      <label className="space-export-dialog__field">Destination path<input value={view.path} placeholder="docs/document.md" onInput={event=>setView(current=>({...current,path:event.currentTarget.value}))}/></label>
      <label className="space-export-dialog__field">Issue<input value={issue} onInput={event=>setIssue(event.currentTarget.value)}/></label>
      <label className="space-export-dialog__field">Change message<input value={view.message} onInput={event=>setView(current=>({...current,message:event.currentTarget.value}))}/></label>
      {selected && <section aria-label="Selected immutable material">
        <h3>{'state' in selected ? `Publication: ${selected.state}`:selected.kind}</h3>
        {selected.content !== null ? <pre style={{whiteSpace:'pre-wrap'}}>{selected.content}</pre>:<p>Exact historical material: {selected.artifact_ref ?? 'Unavailable checkout; preservation details below.'}</p>}
        {'provenance_json' in selected && <details><summary>Preservation details</summary><pre>{selected.provenance_json}</pre></details>}
        {'state' in selected && selected.state !== 'submitted' && <button disabled={busy} onClick={()=>void action(async()=> {
          const result=await submitSpacePublication(spaceId,selected.id);
          setPublications(current=>current.map(value=>value.id===result.id ? result:value));setSelected(result);
        })}>Submit reviewed snapshot for approval</button>}
        {'state' in selected && selected.auth_request_id && <p>Submitted for approval. The Git version remains pinned after further edits.</p>}
        {'artifact_ref' in selected && selected.artifact_ref && <button disabled={busy} onClick={()=>void action(async()=> {
          await importSpaceDocument({ref:selected.artifact_ref!,project_id:projectId,title:`Imported ${selected.kind}`});onImported?.();
        })}>Import as separate managed copy</button>}
      </section>}
      <h3>Publications</h3>
      {ready && publications.length===0 && <p>No publication snapshots yet.</p>}
      {publications.map(value=><p key={value.id}><button onClick={()=>setSelected(value)}>{value.path} · {value.state}</button></p>)}
      {history.length>0 && <><h3>Preserved documents</h3><p>Managed, published, and checkout variants are separate. Existing checkout files remain in place.</p>
        {history.map(value=><p key={value.id}><button onClick={()=>setSelected(value)}>{value.kind}</button></p>)}
      </>}
      <h3>Import immutable material</h3>
      <label className="space-export-dialog__field">Artifact version reference<input value={ref} onInput={event=>setRef(event.currentTarget.value)}/></label>
      <label className="space-export-dialog__field">New document title<input value={title} onInput={event=>setTitle(event.currentTarget.value)}/></label>
      <button disabled={busy || !ref.trim() || !title.trim()} onClick={()=>void action(async()=> {
        await importSpaceDocument({ref:ref.trim(),title:title.trim(),project_id:projectId});onImported?.();
      })}>Import as separate managed copy</button>
    </DetailPaneShell>
  </section>;
}
export default SpaceExportDialog;
