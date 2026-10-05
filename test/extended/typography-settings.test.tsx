import { readFileSync } from 'node:fs';
import { act, render, screen, fireEvent, waitFor, within } from '@testing-library/preact';
import { h } from 'preact';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { SettingsView } from '../../ui/src/views/settings';
import {
  DEFAULT_TYPOGRAPHY_SETTINGS,
  normalizeTypographySetting,
  reconcileTypographySettings,
  withTypographySetting,
} from '../../ui/src/typography-settings';

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

  it('exposes accessible bounded controls and resets each setting', async () => {
    const onTypographySave = vi.fn(async () => undefined);
    render(h(SettingsView, {
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

    const uiFaceReset = screen.getByLabelText('UI font').closest('.settings-view__select-row')!
      .querySelector<HTMLButtonElement>('button')!;
    const detailSizeReset = screen.getByLabelText('Detail content size').closest('.settings-view__text-row')!
      .querySelector<HTMLButtonElement>('button')!;
    await waitFor(() => expect(uiFaceReset.disabled).toBe(false));
    fireEvent.click(uiFaceReset);
    await waitFor(() => expect(onTypographySave).toHaveBeenCalledWith('ui_font_face', 'system-ui'));
    await waitFor(() => expect(detailSizeReset.disabled).toBe(false));
    fireEvent.click(detailSizeReset);
    await waitFor(() => {
      expect(onTypographySave).toHaveBeenCalledWith('ui_font_face', 'system-ui');
      expect(onTypographySave).toHaveBeenCalledWith('detail_font_size', '12');
    });
  });

});
