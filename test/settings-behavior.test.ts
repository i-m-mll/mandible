// @vitest-environment jsdom
import { beforeEach } from 'vitest';
import { bindTestInstanceCatalog } from './helpers/instance-operation-fixtures';
import { changeSelect, render, previewInstance, mainInstance, preferenceWritablePreviewInstance } from './helpers/ui-workspace-fixture';
import { screen, fireEvent, waitFor, within } from './helpers/dom.js';
import { describe, expect, it, vi } from 'vitest';
import { h } from 'preact';

import { SettingsView } from '../ui/src/views/settings';
import { AgentIntegrations, IntegrationIntroduction } from '../ui/src/components/AgentIntegrations';
import { DEFAULT_CHILD_RETENTION_SETTINGS } from '../src/conversations/retention-contract';

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  for (const instance of [mainInstance, previewInstance, preferenceWritablePreviewInstance]) bindTestInstanceCatalog(instance);
});

describe('SettingsView', () => {

  it('represents the installed integration state and dismisses optional setup after a saved choice', async () => {
    let integration = { id: 'cli', label: 'Command shortcut', destination: '/tmp/profile/bin/mandible', status: 'absent', detail: '' };
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'PUT') integration = { ...integration, status: 'installed' };
      return Response.json({ available: true, command: '/Applications/Mandible.app/Contents/Resources/bin/mandible', skill: 'generic skill', items: [integration] });
    });
    vi.stubGlobal('fetch', fetchMock);
    const onSave = vi.fn(async () => undefined);
    const content = (settings: Record<string, string>) => h('div', {}, [
      h(IntegrationIntroduction, { settings, onSave }), h(AgentIntegrations, { instance: mainInstance }),
    ]);
    const view = render(content({}));
    fireEvent.click(await screen.findByRole('button', { name: 'Install' }));
    expect(await screen.findByRole('button', { name: 'Remove' })).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledWith('/api/settings/integrations', expect.objectContaining({ method: 'PUT', body: JSON.stringify({ id: 'cli', action: 'install' }) }));
    fireEvent.click(screen.getByRole('button', { name: 'Skip optional integrations' }));
    await waitFor(() => expect(onSave).toHaveBeenCalledWith('integrations.setup', 'skipped'));
    view.rerender(content({ 'integrations.setup': 'skipped' }));
    expect(screen.queryByRole('region', { name: 'Welcome to Mandible' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Remove' })).toBeTruthy();
  });

  it('exposes and saves every app theme mode through the labelled Appearance select', async () => {
    const onSave = vi.fn(async () => undefined);

    render(h(SettingsView, { instance: mainInstance, settings: { app_theme: 'system' }, onSave }));

    const themeSelect = screen.getByRole('combobox', { name: 'App theme' });
    const themeDescriptionId = themeSelect.getAttribute('aria-describedby');
    expect(themeDescriptionId).toBeTruthy();
    expect(document.getElementById(themeDescriptionId!)).toBeTruthy();

    for (const mode of ['light', 'dark', 'system']) {
      changeSelect(themeSelect, mode);
      await waitFor(() => expect(onSave).toHaveBeenLastCalledWith('app_theme', mode));
    }

    const lightTerminal = screen.getByRole('combobox', { name: 'Light-mode terminal' });
    const darkTerminal = screen.getByRole('combobox', { name: 'Dark-mode terminal' });
    changeSelect(lightTerminal, 'solarized');
    await waitFor(() => expect(onSave).toHaveBeenLastCalledWith('terminal_theme_light', 'solarized'));
    changeSelect(darkTerminal, 'one');
    await waitFor(() => expect(onSave).toHaveBeenLastCalledWith('terminal_theme_dark', 'one'));
  });

  it('disables App theme without saving when operational mutations are rejected', () => {
    const onSave = vi.fn(async () => undefined);

    render(h(SettingsView, {
      settings: { app_theme: 'system' },
      onSave,
      instance: previewInstance,
    }));

    const themeSelect = screen.getByRole('combobox', { name: 'App theme' });
    expect((themeSelect as HTMLSelectElement).disabled).toBe(true);
    expect((screen.getByRole('combobox', { name: 'Light-mode terminal' }) as HTMLSelectElement).disabled)
      .toBe(true);
    expect((screen.getByRole('combobox', { name: 'Dark-mode terminal' }) as HTMLSelectElement).disabled)
      .toBe(true);
    changeSelect(themeSelect, 'dark');
    expect(onSave).not.toHaveBeenCalled();
  });

  it('skips unavailable automatic reads while keeping copied Settings preferences editable', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/settings/child-retention') return Response.json(DEFAULT_CHILD_RETENTION_SETTINGS);
      if (url === '/api/settings/instructions-delivery') {
        return new Response(JSON.stringify({ targets: [], postExport: '', configuredTargets: false }), {
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url === '/api/projects') {
        return new Response(JSON.stringify({ projects: [] }), { headers: { 'content-type': 'application/json' } });
      }
      if (url === '/api/users/operator/signing-key') {
        return new Response(JSON.stringify({
          audit: { status: 'unconfigured', configured: false, fingerprint: null, operator_slug: 'operator', reason: null, hint: null },
          credentials: [], git_config_read: true,
        }), { headers: { 'content-type': 'application/json' } });
      }
      return new Response('{}', { headers: { 'content-type': 'application/json' } });
    });
    vi.stubGlobal('fetch', fetchMock);
    const onSave = vi.fn(async () => undefined);
    const onTypographySave = vi.fn(async () => undefined);

    render(h(SettingsView, {
      settings: { app_theme: 'system' },
      onSave,
      onTypographySave,
      instance: preferenceWritablePreviewInstance,
    }));

    const forbiddenReads = [
      '/api/backup/status',
      '/api/runtime/status',
      '/api/auth/hooks',
      '/api/auth/clearances/signing',
    ];
    const requestedUrls = fetchMock.mock.calls.map(([input]) => String(input));
    expect(requestedUrls.filter((url) => forbiddenReads.includes(url))).toEqual([]);

    const theme = screen.getByRole('combobox', { name: 'App theme' }) as HTMLSelectElement;
    const font = screen.getByRole('combobox', { name: 'UI font' }) as HTMLSelectElement;
    expect(theme.disabled).toBe(false);
    expect(font.disabled).toBe(false);
    changeSelect(theme, 'dark');
    await waitFor(() => expect(onSave).toHaveBeenCalledWith('app_theme', 'dark'));
    changeSelect(font, 'space-grotesk');
    await waitFor(() => expect(onTypographySave).toHaveBeenCalledWith('ui_font_face', 'space-grotesk'));

    const chatLimit = screen.getByRole('spinbutton', { name: 'Chats per group' }) as HTMLInputElement;
    expect(chatLimit.value).toBe('5');
    fireEvent.input(chatLimit, { target: { value: '6' } });
    await waitFor(() => expect(onSave).toHaveBeenCalledWith('conversations.sidebar_group_limit', '6'));
  });

  it('saves preview instruction settings locally without offering file cleanup', async () => {
    const onSave = vi.fn(async () => undefined);
    const targets = [
      { path: '/tmp/old-codex.md', mode: 'managed-block' },
      { path: '/tmp/old-claude.md', mode: 'managed-block' },
    ];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === '/api/settings/child-retention') return Response.json(DEFAULT_CHILD_RETENTION_SETTINGS);
      if (url === '/api/settings/instructions-delivery' && init?.method !== 'PUT') {
        return new Response(JSON.stringify({
          targets,
          postExport: 'bin/compile-agent-instructions',
          configuredTargets: true,
          preview_only: true,
          export: { ok: false, stdout: '', stderr: 'not run in preview' },
        }), { headers: { 'content-type': 'application/json' } });
      }
      if (url === '/api/settings/instructions-delivery' && init?.method === 'PUT') {
        const body = JSON.parse(String(init.body)) as { targets: typeof targets; cleanupRemovedTargets: boolean };
        return new Response(JSON.stringify({
          targets: body.targets,
          postExport: 'bin/compile-agent-instructions',
          configuredTargets: true,
          preview_only: true,
          configuration_saved: true,
          export: { ok: false, stdout: '', stderr: 'not installed in preview' },
          cleanup: [],
        }), { headers: { 'content-type': 'application/json' } });
      }
      if (url === '/api/projects') {
        return new Response(JSON.stringify({ projects: [] }), { headers: { 'content-type': 'application/json' } });
      }
      if (url === '/api/users/operator/signing-key') {
        return new Response(JSON.stringify({
          audit: { status: 'unconfigured', configured: false, fingerprint: null, operator_slug: 'operator', reason: null, hint: null },
          credentials: [], git_config_read: true,
        }), { headers: { 'content-type': 'application/json' } });
      }
      return new Response('{}', { headers: { 'content-type': 'application/json' } });
    });
    vi.stubGlobal('fetch', fetchMock);

    render(h(SettingsView, {
      settings: {},
      onSave,
      instance: preferenceWritablePreviewInstance,
    }));

    expect(await screen.findByDisplayValue('/tmp/old-codex.md')).toBeTruthy();
    const targetRow = screen.getByLabelText('Instruction target /tmp/old-codex.md').closest('.settings-view__instruction-target') as HTMLElement;
    fireEvent.click(within(targetRow).getByRole('button', { name: 'Remove instruction target /tmp/old-codex.md' }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      '/api/settings/instructions-delivery',
      expect.objectContaining({
        method: 'PUT',
        body: JSON.stringify({ targets: [targets[1]], cleanupRemovedTargets: false }),
      }),
    ));
    expect(screen.queryByRole('dialog', { name: 'Clean previous instruction target?' })).toBeNull();
    await waitFor(() => expect(onSave).toHaveBeenCalledWith('instructions.targets', JSON.stringify([targets[1]])));
    fireEvent.click(screen.getByRole('button', { name: 'Remove instruction target /tmp/old-claude.md' }));
    await waitFor(() => expect(onSave).toHaveBeenCalledWith('instructions.targets', '[]'));
    expect(screen.queryByRole('dialog', { name: 'Clean previous instruction target?' })).toBeNull();

  });
});

