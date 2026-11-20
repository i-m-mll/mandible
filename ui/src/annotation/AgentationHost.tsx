import { Agentation } from 'agentation';
import { openInterfaceNotesMenuFromSend } from './InterfaceNotesMenu';
import { recordAdd, recordClear, recordDelete, recordUpdate, useInterfaceNotes } from './interfaceNotesStore';

/** The toolbar for this page's notes; `appName` is the name Agentation shows and copies. */
export function AgentationHost({ appName }: { appName: string }): JSX.Element | null {
  const { ready, epoch } = useInterfaceNotes();
  if (!ready) return null;
  return (
    <Agentation
      key={epoch}
      appName={appName}
      onAnnotationAdd={recordAdd}
      onAnnotationUpdate={recordUpdate}
      onAnnotationDelete={recordDelete}
      onAnnotationsClear={recordClear}
      onSubmit={openInterfaceNotesMenuFromSend}
    />
  );
}
