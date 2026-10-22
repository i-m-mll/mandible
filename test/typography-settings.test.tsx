import { establishTestClientAccess } from './helpers/local-client-access';
import { MAIN_CLI_INSTANCE_RESPONSE } from './helpers/cli-instance-response';
import { bindTestInstanceCatalog } from './helpers/instance-operation-fixtures';

import { act, render, screen, fireEvent, waitFor, within } from '@testing-library/preact';
import { h } from 'preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SettingsView } from '../ui/src/views/settings';
import {
  DEFAULT_TYPOGRAPHY_SETTINGS,
  normalizeTypographySetting,
  reconcileTypographySettings,
  withTypographySetting,
} from '../ui/src/typography-settings';

beforeEach(async () => {
  await establishTestClientAccess();
  bindTestInstanceCatalog(MAIN_CLI_INSTANCE_RESPONSE.instance);
});

afterEach(() => {
  document.head.querySelector('[data-typography-test]')?.remove();
});

describe('typed typography settings', () => {
  it('normalizes bounded sizes and independent face choices', () => {
    let settings = withTypographySetting(DEFAULT_TYPOGRAPHY_SETTINGS, 'ui_font_face', 'space-grotesk');
    settings = withTypographySetting(settings, 'detail_font_face', 'system-ui');
    expect(settings).toMatchObject({ uiFontFace: 'space-grotesk', detailFontFace: 'system-ui' });
    settings = withTypographySetting(settings, 'ui_font_face', 'system-ui');
    settings = withTypographySetting(settings, 'detail_font_face', 'space-grotesk');
    expect(settings).toMatchObject({ uiFontFace: 'system-ui', detailFontFace: 'space-grotesk' });
    expect(normalizeTypographySetting('ui_font_size', '9')).toBe('14');
    expect(normalizeTypographySetting('detail_font_size', '21')).toBe('12');
  });

  it('reconciles each setting independently and rejects stale responses', () => {
    const revisions = { ui_font_face: 4, ui_font_size: 1, detail_font_face: 2, detail_font_size: 3 };
    const result = reconcileTypographySettings(DEFAULT_TYPOGRAPHY_SETTINGS, revisions, [
      { version: 1, key: 'ui_font_face', value: 'space-grotesk', revision: 3 },
      { version: 1, key: 'detail_font_face', value: 'space-grotesk', revision: 5 },
      { version: 1, key: 'ui_font_size', value: '16', revision: 2 },
    ]);
    expect(result.settings).toMatchObject({
      uiFontFace: 'system-ui', detailFontFace: 'space-grotesk', uiFontSize: 16, detailFontSize: 12,
    });
    expect(result.revisions).toMatchObject({ ui_font_face: 4, detail_font_face: 5, ui_font_size: 2 });
  });

  it('exposes accessible bounded controls and autosaves default values', async () => {
    const onTypographySave = vi.fn(async () => undefined);
    render(h(SettingsView, {
      instance: MAIN_CLI_INSTANCE_RESPONSE.instance,
      settings: {},
      onSave: async () => undefined,
      typography: {
        uiFontFace: 'space-grotesk', uiFontSize: 16,
        detailFontFace: 'space-grotesk', detailFontSize: 15,
      },
      onTypographySave,
    }));

    expect(within(screen.getByLabelText('UI font')).getAllByRole('option').map((node) => node.textContent))
      .toEqual(['System UI', 'Space Grotesk']);
    const uiSize = screen.getByLabelText('UI size');
    expect(uiSize.getAttribute('min')).toBe('10');
    expect(uiSize.getAttribute('max')).toBe('20');
    const detailFace = screen.getByLabelText('Detail content font') as HTMLSelectElement;
    act(() => {
      detailFace.value = 'system-ui';
      detailFace.dispatchEvent(new Event('input', { bubbles: true }));
      detailFace.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await waitFor(() => expect(onTypographySave).toHaveBeenCalledWith('detail_font_face', 'system-ui'));

    await waitFor(() => expect(detailFace.disabled).toBe(false));
    const uiFace = screen.getByLabelText('UI font') as HTMLSelectElement;
    act(() => {
      uiFace.value = 'system-ui';
      uiFace.dispatchEvent(new Event('input', { bubbles: true }));
      uiFace.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await waitFor(() => expect(onTypographySave).toHaveBeenCalledWith('ui_font_face', 'system-ui'));
    await waitFor(() => expect(uiFace.disabled).toBe(false));
    const detailSize = screen.getByLabelText('Detail content size') as HTMLInputElement;
    act(() => {
      detailSize.value = '12';
      detailSize.dispatchEvent(new Event('input', { bubbles: true }));
      detailSize.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await waitFor(() => {
      expect(onTypographySave).toHaveBeenCalledWith('ui_font_face', 'system-ui');
      expect(onTypographySave).toHaveBeenCalledWith('detail_font_size', '12');
    });
  });

});
