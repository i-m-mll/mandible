import { render } from 'preact';
import { INTERFACE_NOTES_EMBED } from '../../../src/interface-notes/contract';
import embedStyles from 'mandible-embed-styles';
import { AgentationHost } from './AgentationHost';
import { connectToBridge } from './embedClient';
import { InterfaceNotesMenu, type InterfaceNotesMenuPorts } from './InterfaceNotesMenu';
import { configureInterfaceNotes, startInterfaceNotes } from './interfaceNotesStore';
import { keepOnTop, useTopLayerContainer } from './topLayer';

/**
 * The interface-notes embed: the module script another app's dev page loads from
 * Mandible's origin. It mounts the Agentation toolbar and the Send menu for the
 * page's app once the bridge names it, and nothing on a page whose origin serves
 * no registered project. Both stay above everything the host page draws (`topLayer.ts`).
 */

const HOST_ELEMENT = 'mandible-interface-notes';

function Notice({ children }: { children: string }): JSX.Element {
  return <div className="interface-notes-menu__error" role="alert">{children}</div>;
}

function EmbedToolbar({ appName }: { appName: string }): JSX.Element | null {
  return <AgentationHost appName={appName} portalContainer={useTopLayerContainer()} />;
}

async function mount(): Promise<void> {
  if (window.top !== window || document.querySelector(HOST_ELEMENT)) return;
  const daemonOrigin = new URL(import.meta.url).origin;
  const connection = await connectToBridge(daemonOrigin);
  if (!connection) return;
  if (connection.kind === 'pending') {
    showGrantLink(daemonOrigin);
    return;
  }
  const { identity, transport } = connection;
  configureInterfaceNotes({
    app: identity.app,
    origin: window.location.origin,
    transport,
    revision: () => null,
    migrateLegacyCache: false,
    storageScope: `:${identity.app}`,
  });

  const root = createHost();
  const ports: InterfaceNotesMenuPorts = { transport, receivingProject: identity.project.key, Notice };
  render(<><EmbedToolbar appName={identity.project.name} /><InterfaceNotesMenu ports={ports} /></>, root);
  startInterfaceNotes();
}

/**
 * On an origin the operator has not allowed, one small link to Mandible's grant view,
 * opened as its own top-level page; nothing is granted from this page.
 */
function showGrantLink(daemonOrigin: string): void {
  const root = createHost();
  const url = new URL(INTERFACE_NOTES_EMBED.grantView, daemonOrigin);
  url.searchParams.set('section', 'settings-issues');
  url.searchParams.set('embed_origin', window.location.origin);
  render(
    <a className="interface-notes-grant-link" href={url.href} target="_blank" rel="noopener noreferrer"
      title="This page asked to show Mandible's interface-notes toolbar. Allow it in Mandible's Settings.">
      Allow Mandible notes
    </a>,
    root,
  );
}

function createHost(): ShadowRoot {
  const host = document.createElement(HOST_ELEMENT);
  // Everything in this shadow root (the Send menu, the grant link) is the toolbar's own interface. Agentation tests
  // some events and hit points against the element it sees, which outside the shadow root is this host, so the
  // marker is on the host as well as on the menu.
  host.setAttribute('data-feedback-toolbar', '');
  // Agentation names React components only on a page where it finds a React fiber on
  // the body, the root or one of the body's children (`isReactPage`). Rendered by
  // React it supplies one itself; rendered by Preact it does not, and a React 18
  // createRoot app has only `__reactContainer$` on its root. This key is what it looks for.
  (host as unknown as Record<string, unknown>)['__reactProps$mandibleInterfaceNotes'] = {};
  const light = window.matchMedia('(prefers-color-scheme: light)');
  const theme = () => host.setAttribute('data-theme', light.matches ? 'light' : 'dark');
  theme();
  light.addEventListener('change', theme);
  const root = host.attachShadow({ mode: 'open' });
  const style = document.createElement('style');
  style.textContent = embedStyles;
  root.appendChild(style);
  keepOnTop(host);
  return root;
}

if (document.body) void mount();
else document.addEventListener('DOMContentLoaded', () => void mount(), { once: true });
