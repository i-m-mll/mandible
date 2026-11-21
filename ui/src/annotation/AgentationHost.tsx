import { Agentation } from 'agentation';
import { openInterfaceNotesMenuFromSend } from './InterfaceNotesMenu';
import { recordAdd, recordClear, recordDelete, recordUpdate, useInterfaceNotes } from './interfaceNotesStore';

/**
 * The toolbar for this page's notes; `appName` is the name Agentation shows and copies.
 * Given a `portalContainer`, the toolbar is a top-layer popover inside it.
 */
export function AgentationHost({ appName, portalContainer }: { appName: string; portalContainer?: HTMLElement }): JSX.Element | null {
  const { ready, epoch } = useInterfaceNotes();
  if (!ready) return null;
  return (
    <Agentation
      key={epoch}
      appName={appName}
      portalContainer={portalContainer}
      onAnnotationAdd={recordAdd}
      onAnnotationUpdate={recordUpdate}
      onAnnotationDelete={recordDelete}
      onAnnotationsClear={recordClear}
      onSubmit={openInterfaceNotesMenuFromSend}
    />
  );
}
