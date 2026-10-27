import { render } from 'preact';
import { QueryClientProvider } from '@tanstack/preact-query';
import { App } from '../../../ui/src/app';
import { adoptAgentSessionFragment } from '../../../ui/src/agent-page-binding';
import { queryClient } from '../../../ui/src/query/client';
import { installNativeDragDiagnostics } from './native-drag-diagnostics';
import { controlledReadinessFetch } from './native-app-splash-transport';
import { appendNativeSplashReturnLink } from './native-app-splash-return';
import '../../../ui/src/style.css';

const reason = new URLSearchParams(location.search).get('reason') === 'rebuilding' ? 'rebuilding' : 'starting';
const transport = window.fetch.bind(window);
window.fetch = controlledReadinessFetch(transport, new URL(location.href), reason);
// This fixture holds only client readiness. It neither restarts nor changes the owned daemon.
class FixtureEvents {
  readyState = 1;
  addEventListener(): void {}
  removeEventListener(): void {}
  close(): void {}
}
window.EventSource = FixtureEvents as unknown as typeof EventSource;
if ('__TAURI__' in window || '__TAURI_INTERNALS__' in window) document.body.classList.add('tauri-window');
installNativeDragDiagnostics();
adoptAgentSessionFragment();
render(<QueryClientProvider client={queryClient}><App /></QueryClientProvider>, document.getElementById('proof-root')!);
appendNativeSplashReturnLink();
