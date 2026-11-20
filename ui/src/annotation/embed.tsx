import { render } from 'preact';
import embedStyles from 'mandible-embed-styles';
import { AgentationHost } from './AgentationHost';
import { connectToBridge } from './embedClient';
import { InterfaceNotesMenu, type InterfaceNotesMenuPorts } from './InterfaceNotesMenu';
import { configureInterfaceNotes, startInterfaceNotes } from './interfaceNotesStore';

/**
 * The interface-notes embed: the module script another app's dev page loads from
 * Mandible's origin. It mounts the Agentation toolbar and the Send menu for the
 * page's app once the bridge names it, and nothing on a page whose origin serves
 * no registered project.
 */

const HOST_ELEMENT = 'mandible-interface-notes';

function Notice({ children }: { children: string }): JSX.Element {
  return <div className="interface-notes-menu__error" role="alert">{children}</div>;
}

async function mount(): Promise<void> {
  if (window.top !== window || document.querySelector(HOST_ELEMENT)) return;
  const connection = await connectToBridge(new URL(import.meta.url).origin);
  if (!connection) return;
  const { identity, transport } = connection;
  configureInterfaceNotes({
    app: identity.app,
    transport,
    revision: () => null,
    migrateLegacyCache: false,
    storageScope: `:${identity.app}`,
  });

  const host = document.createElement(HOST_ELEMENT);
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
  document.body.appendChild(host);

  const ports: InterfaceNotesMenuPorts = { transport, receivingProject: identity.project.key, Notice };
  render(<><AgentationHost appName={identity.project.name} /><InterfaceNotesMenu ports={ports} /></>, root);
  startInterfaceNotes();
}

if (document.body) void mount();
else document.addEventListener('DOMContentLoaded', () => void mount(), { once: true });
