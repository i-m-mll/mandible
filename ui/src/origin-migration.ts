import { exportLegacyBrowserState } from '../../src/client-auth/legacy-browser-state';
import { PRODUCTION_ORIGIN } from '../../src/canonical-origin';

const button = document.getElementById('move') as HTMLButtonElement;
const result = document.getElementById('result')!;

function moveSavedWorkspace(): void {
  button.disabled = true;
  button.hidden = true;
  result.textContent = 'Moving your saved workspace…';
  try {
    if (window.location.origin !== 'https://app.mandible.localhost:19420') {
      throw new Error('This page is outside the registered old Mandible address.');
    }
    const state = exportLegacyBrowserState(window.localStorage);
    const form = document.createElement('form');
    form.method = 'post';
    form.action = `${PRODUCTION_ORIGIN}/api/client-auth/recovery/start`;
    for (const [name, value] of [
      ['return_path', `${window.location.pathname}${window.location.search}${window.location.hash}`],
      ['browser_state', JSON.stringify(state)],
    ] as const) {
      const field = document.createElement('input');
      field.type = 'hidden';
      field.name = name;
      field.value = name === 'return_path' && value.startsWith('/origin-migration') ? '/' : value;
      form.append(field);
    }
    document.body.append(form);
    form.submit();
  } catch (error) {
    result.textContent = error instanceof Error ? error.message : String(error);
    button.disabled = false;
    button.hidden = false;
  }
}

button.addEventListener('click', moveSavedWorkspace);
moveSavedWorkspace();
