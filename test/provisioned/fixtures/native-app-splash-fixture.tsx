import { render } from 'preact';
import { QueryClientProvider } from '@tanstack/preact-query';
import { App } from '../../../ui/src/app';
import { adoptAgentSessionFragment } from '../../../ui/src/agent-page-binding';
import { queryClient } from '../../../ui/src/query/client';
import { installNativeDragDiagnostics } from './native-drag-diagnostics';
import '../../../ui/src/style.css';

const reason = new URLSearchParams(location.search).get('reason') === 'rebuilding' ? 'rebuilding' : 'starting';
const transport = window.fetch.bind(window);
window.fetch = async (input, init) => {
  const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
  if (method !== 'GET' && method !== 'HEAD') return new Response('Controlled readiness proof is read-only', { status: 503 });
  const response = await transport(input, init);
  const path = new URL(input instanceof Request ? input.url : String(input), location.href).pathname;
  if (path !== '/api/health' || !response.ok) return response;
  const health = await response.json();
  return new Response(JSON.stringify({ ...health, ready: false, warm: false, rebuilding: reason === 'rebuilding' }), {
    status: response.status, headers: response.headers,
  });
};
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
const restore = document.createElement('a');
restore.href = '/' + (location.hash || '#/overview'); restore.textContent = 'Return to Mandible';
restore.style.cssText = 'position:fixed;bottom:16px;right:16px;z-index:1000';
document.body.append(restore);
