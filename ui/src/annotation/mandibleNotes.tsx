import { INTERFACE_NOTE_CHANGED_EVENT, MANDIBLE_INTERFACE_NOTES_APP } from '../../../src/interface-notes/contract';
import type { InterfaceNoteChangedPayload } from '../../../src/interface-notes/contract';
import { getLedgerIssueInitialDetailByIssueId } from '../api';
import { servedBackendGeneration } from '../boot-instance';
import { DetailPaneNotice } from '../components/shared/DetailPaneNotice';
import { acquireSharedSse } from '../sse-shared';
import { chatDestination } from './chatDestination';
import { apiTransport } from './interfaceNotesApi';
import type { InterfaceNotesMenuPorts } from './InterfaceNotesMenu';
import { configureInterfaceNotes } from './interfaceNotesStore';
import type { InterfaceNotesTransport } from './notesTransport';

/** Mandible's own interface as an interface-notes host: its API, its event stream, Chat and the loaded issue. */

const subscribe: InterfaceNotesTransport['subscribe'] = ({ changed, reconnected }) => {
  const events = acquireSharedSse();
  events.on(INTERFACE_NOTE_CHANGED_EVENT, (event) => changed(event.data as InterfaceNoteChangedPayload));
  events.onState((state, meta) => {
    if (state === 'open' && meta.reconnected) reconnected();
  });
  events.connect();
  return () => events.close();
};

const transport = apiTransport({ app: MANDIBLE_INTERFACE_NOTES_APP, subscribe });

configureInterfaceNotes({
  app: MANDIBLE_INTERFACE_NOTES_APP,
  origin: null,
  transport,
  revision: servedBackendGeneration,
  migrateLegacyCache: true,
  storageScope: '',
});

function MenuNotice({ children }: { children: string }): JSX.Element | null {
  return <DetailPaneNotice severity="error" density="compact">{children}</DetailPaneNotice>;
}

export function mandibleNotesMenuPorts(receivingProject: string | null): InterfaceNotesMenuPorts {
  return {
    transport,
    receivingProject,
    Notice: MenuNotice,
    chat: chatDestination,
    issueTitle: async (issueRef) => {
      const detail = await getLedgerIssueInitialDetailByIssueId(issueRef);
      return { id: detail.display_id, title: detail.title };
    },
  };
}
