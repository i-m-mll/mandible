import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { saveSpaceDocument } from '../../api';
import { DocumentDraftControl, type DocumentRevision } from '../../components/markdown/draft';
import { browserResourceKeys } from '../../query/browserResources';
import { queryClient } from '../../query/client';
import type { SpaceDocumentRecovery } from './document-recovery';

const SAVE_DELAY = 650;

const errorMessage = (error: unknown) => error instanceof Error ? error.message : String(error);

export function useSpaceDocumentDraft(spaceId: string, saved: DocumentRevision, recovery: SpaceDocumentRecovery | null,
  writable: boolean, fetchImpl?: typeof fetch) {
  const [control] = useState(() => new DocumentDraftControl(saved, recovery?.draft));
  const [saveError, setSaveError] = useState<string | null>(null);
  const [recoveryError, setRecoveryError] = useState<string | null>(null);
  const [, setRevision] = useState(0);
  const mounted = useRef(false);
  useLayoutEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  const refresh = useCallback(() => {
    if (mounted.current) setRevision(value => value + 1);
  }, []);

  const persist = useCallback((acknowledged = false) => {
    try {
      if (control.dirty) recovery?.persist({ source: control.source, base: control.base });
      else recovery?.clearDraft(acknowledged);
      if (mounted.current) setRecoveryError(null);
    } catch (error) {
      if (mounted.current) setRecoveryError(errorMessage(error));
    }
  }, [control, recovery]);

  useLayoutEffect(() => {
    control.observe(saved);
    if (!control.pending && !control.dirty && recovery?.draft?.source === saved.source) persist(true);
    refresh();
  }, [control, persist, recovery, refresh, saved]);

  const onChange = useCallback((value: string) => {
    control.source = value;
    setSaveError(null);
    persist();
    refresh();
  }, [control, persist, refresh]);

  const acknowledge = useCallback((document: DocumentRevision) => {
    queryClient.setQueryData<DocumentRevision>(browserResourceKeys.spaceDocument(spaceId), previous =>
      previous && previous.generation > document.generation ? previous : document);
    void queryClient.invalidateQueries({ queryKey: browserResourceKeys.spaceDocumentNotes(spaceId) });
  }, [spaceId]);

  const save = useCallback(async () => {
    if (!writable && control.dirty) return null;
    const pending = control.pending ?? control.save(async draft => {
      const result = await saveSpaceDocument(spaceId, draft.source, draft.base.generation, fetchImpl);
      acknowledge(result.document);
      return result;
    });
    refresh();
    try {
      const next = await pending;
      if (mounted.current) {
        persist(next !== null);
        setSaveError(null);
      }
      return next;
    } catch (error) {
      if (mounted.current) setSaveError(errorMessage(error));
      return null;
    } finally {
      refresh();
    }
  }, [acknowledge, control, fetchImpl, persist, refresh, spaceId, writable]);

  const { base, source, latest, dirty, conflict, pending } = control;
  useEffect(() => {
    if (!writable || !dirty || conflict || pending || saveError) return;
    const timer = setTimeout(() => void save(), SAVE_DELAY);
    return () => clearTimeout(timer);
  }, [base.generation, source, writable, dirty, conflict, pending, saveError, save]);

  const saveCurrent = useCallback(async (source: string) => {
    const previous = control.pending;
    if (previous && !await save()) return null;
    if (!mounted.current || control.source !== source) return null;
    const document = await save();
    return document?.source === source && control.source === source && document.generation === control.latest.generation
      ? document : null;
  }, [control, save]);

  const acceptRemote = () => {
    control.acceptRemote();
    persist(true);
    refresh();
  };

  const applyReviewedDraft = (reviewedGeneration: number) => {
    if (reviewedGeneration !== control.latest.generation) return;
    control.base = control.latest;
    persist();
    refresh();
    void save();
  };

  const currentSource = useCallback(() => control.source, [control]);

  return { source, base, latest, dirty, conflict, pending, saveError, recoveryError, currentSource,
    onChange, save, saveCurrent, acceptRemote, applyReviewedDraft };
}
