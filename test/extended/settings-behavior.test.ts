import { screen, fireEvent, waitFor, cleanup, within } from '@testing-library/preact';
import { describe, expect, it, vi } from 'vitest';
import { h } from 'preact';
import { App } from '../../ui/src/app';
import { SettingsView } from '../../ui/src/views/settings';
import { changeSelect, render, previewInstance, mainInstance, preferenceWritablePreviewInstance } from '../helpers/ui-workspace-fixture';

describe('SettingsView', () => {
  it('offers only the native setup handoff from the browser', () => {
    render(h(SettingsView, { instance: mainInstance, settings: {}, onSave: async () => undefined }));
    const action = screen.getByRole('link', { name: 'Open macOS setup' });
    expect(action.getAttribute('href')).toBe('mandible://connections/setup');
    const handoff = action.closest('section');
    expect(handoff).not.toBeNull();
    expect(within(handoff!).queryByRole('button')).toBeNull();
  });

  it('exposes and saves every app theme mode through the labelled Appearance select', async () => {
    const onSave = vi.fn(async () => undefined);

    render(h(SettingsView, { instance: mainInstance, settings: { app_theme: 'system' }, onSave }));

    const themeSelect = screen.getByRole('combobox', { name: 'App theme' });
    expect(themeSelect.getAttribute('aria-describedby')).toBe('settings-app-theme-description');
    expect(within(themeSelect).getAllByRole('option').map((option) => option.textContent)).toEqual([
      'System',
      'Dark',
      'Light',
    ]);

    for (const mode of ['light', 'dark', 'system']) {
      changeSelect(themeSelect, mode);
      await waitFor(() => expect(onSave).toHaveBeenLastCalledWith('app_theme', mode));
    }

    const lightTerminal = screen.getByRole('combobox', { name: 'Light-mode terminal' });
    const darkTerminal = screen.getByRole('combobox', { name: 'Dark-mode terminal' });
    expect(within(lightTerminal).getAllByRole('option').map((option) => option.textContent)).toEqual([
      'Mandible', 'GitHub', 'Solarized', 'One', 'High contrast',
    ]);
    expect(within(darkTerminal).getAllByRole('option').map((option) => option.textContent)).toEqual([
      'Mandible', 'GitHub', 'Solarized', 'One', 'High contrast',
    ]);
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
    await waitFor(() => expect(screen.getByText('Saved in this preview copy. Target files were not changed and the post-export hook was not run.')).toBeTruthy());
    await waitFor(() => expect(onSave).toHaveBeenCalledWith('instructions.targets', JSON.stringify([targets[1]])));
  });

  it('shows project restriction state and existing grants', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === '/api/projects') {
        return new Response(JSON.stringify({
          projects: [{ id: 'p1', project_key: 'mandible', display_name: 'Mandible' }],
        }), { headers: { 'content-type': 'application/json' } });
      }
      if (url === '/api/projects/mandible/access' && init?.method !== 'PATCH') {
        return new Response(JSON.stringify({
          project_id: 'p1',
          restricted: true,
          grants: [{
            id: 'g1', subject_type: 'group', subject_id: 'agents',
            resource_type: 'project', resource_id: 'p1', permission: 'write',
          }],
        }), { headers: { 'content-type': 'application/json' } });
      }
      if (url === '/api/settings/instructions-delivery') {
        return new Response(JSON.stringify({ targets: [], postExport: '', configuredTargets: false }), {
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response('{}', { status: 404, headers: { 'content-type': 'application/json' } });
    }));

    render(h(SettingsView, { instance: mainInstance, settings: {}, onSave: async () => undefined }));

    expect(await screen.findByTestId('project-permissions-settings')).toBeTruthy();
    expect(await screen.findByText('group:agents — write')).toBeTruthy();
    expect(screen.getByLabelText('Toggle project restriction').getAttribute('aria-checked')).toBe('true');
  });

  it('does not show deprecated Reaper controls', () => {
    render(
      h(SettingsView, {
        settings: {
          reaper_enabled: 'true',
          reaper_claude_idle_minutes: '30',
          reaper_codex_idle_minutes: '45',
        },
        onSave: async () => undefined,
      }),
    );

    expect(screen.queryByText('Reaper')).toBeNull();
    expect(screen.queryByText('Claude idle threshold')).toBeNull();
    expect(screen.queryByText('Codex idle threshold')).toBeNull();
  });

  it('offers independent approval-view and finalized-selection preferences', async () => {
    const onSave = vi.fn(async () => undefined);
    render(h(SettingsView, { settings: {}, onSave }));

    const consoleToggle = screen.getByRole('switch', { name: 'Toggle Show approval console automatically' });
    const overviewToggle = screen.getByRole('switch', { name: 'Toggle Return to overview after approval' });
    const retainToggle = screen.getByRole('switch', { name: 'Toggle Keep the finalized request selected' });
    expect([consoleToggle, overviewToggle, retainToggle].map((toggle) => toggle.getAttribute('aria-checked'))).toEqual(['true', 'true', 'true']);

    fireEvent.click(retainToggle);
    await waitFor(() => expect(onSave).toHaveBeenCalledWith('auth.retain_finalized_selection', 'false'));
  });

  it('saves instruction delivery targets and post-export hook settings', async () => {
    const onSave = vi.fn(async () => undefined);
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === '/api/settings/instructions-delivery' && (!init || init.method === undefined || init.method === 'GET')) {
        return new Response(JSON.stringify({
          targets: [
            { path: '/Users/mll/.claude/CLAUDE.md', mode: 'managed-block' },
            { path: '/Users/mll/.codex/AGENTS.md', mode: 'managed-block' },
          ],
          postExport: '',
          configuredTargets: false,
          export: { ok: true, stdout: '', stderr: '' },
          cleanup: [],
        }), { headers: { 'content-type': 'application/json' } });
      }
      if (url === '/api/settings/instructions-delivery' && init?.method === 'PUT') {
        const body = JSON.parse(String(init.body)) as {
          targets?: Array<{ path: string; mode: string }>;
          postExport?: string;
          resetToDefaults?: boolean;
        };
        const targets = body.resetToDefaults
          ? [
            { path: '/Users/mll/.claude/CLAUDE.md', mode: 'managed-block' },
            { path: '/Users/mll/.codex/AGENTS.md', mode: 'managed-block' },
          ]
          : body.targets ?? [
            { path: '/Users/mll/.claude/CLAUDE.md', mode: 'managed-block' },
            { path: '/Users/mll/.codex/AGENTS.md', mode: 'managed-block' },
          ];
        return new Response(JSON.stringify({
          targets,
          postExport: body.postExport ?? '',
          configuredTargets: true,
          export: { ok: true, stdout: 'Installed', stderr: '' },
          cleanup: [],
        }), { headers: { 'content-type': 'application/json' } });
      }
      return new Response('{}', { status: 404, headers: { 'content-type': 'application/json' } });
    });
    vi.stubGlobal('fetch', fetchMock);

    render(
      h(SettingsView, {
        instance: mainInstance,
        settings: {},
        onSave,
      }),
    );

    expect(screen.getByRole('heading', { name: 'Instruction Delivery' })).toBeTruthy();
    expect(await screen.findByDisplayValue('/Users/mll/.claude/CLAUDE.md')).toBeTruthy();
    expect(screen.getByDisplayValue('/Users/mll/.codex/AGENTS.md')).toBeTruthy();
    expect(screen.queryByPlaceholderText('/path/to/50-mandible.generated.md')).toBeNull();
    expect(screen.queryByPlaceholderText('bin/compile-agent-instructions')).toBeNull();

    fireEvent.input(screen.getByLabelText('New instruction target path'), {
      target: { value: '/tmp/50-mandible.generated.md' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Add instruction target' }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      '/api/settings/instructions-delivery',
      expect.objectContaining({
        method: 'PUT',
        body: JSON.stringify({
          targets: [
            { path: '/Users/mll/.claude/CLAUDE.md', mode: 'managed-block' },
            { path: '/Users/mll/.codex/AGENTS.md', mode: 'managed-block' },
            { path: '/tmp/50-mandible.generated.md', mode: 'managed-block' },
          ],
          cleanupRemovedTargets: false,
        }),
      }),
    ));
    await waitFor(() => expect(onSave).toHaveBeenCalledWith('instructions.targets', expect.any(String)));

    fireEvent.input(screen.getByLabelText('Instructions post-export hook'), {
      target: { value: 'bin/compile-agent-instructions' },
    });

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      '/api/settings/instructions-delivery',
      expect.objectContaining({
        method: 'PUT',
        body: JSON.stringify({ postExport: 'bin/compile-agent-instructions' }),
      }),
    ));
    await waitFor(() => expect(onSave).toHaveBeenCalledWith('instructions.post_export', 'bin/compile-agent-instructions'));
  });
});

