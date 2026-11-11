import { Agentation } from 'agentation';
import { openInterfaceNotesMenuFromSend } from './InterfaceNotesMenu';
import { recordAdd, recordClear, recordDelete, recordUpdate, useInterfaceNotes } from './interfaceNotesStore';

export function AgentationHost(): JSX.Element | null {
  const { ready, epoch } = useInterfaceNotes();
  if (!ready) return null;
  return (
    <Agentation
      key={epoch}
      appName="Mandible"
      onAnnotationAdd={recordAdd}
      onAnnotationUpdate={recordUpdate}
      onAnnotationDelete={recordDelete}
      onAnnotationsClear={recordClear}
      onSubmit={openInterfaceNotesMenuFromSend}
    />
  );
}
