import { establishTestClientAccess } from './helpers/local-client-access';
import { MAIN_CLI_INSTANCE_RESPONSE } from './helpers/cli-instance-response';
import { bindTestInstanceCatalog } from './helpers/instance-operation-fixtures';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_TYPOGRAPHY_SETTINGS, reconcileTypographySettings } from '../ui/src/typography-settings';

beforeEach(async () => {
  await establishTestClientAccess();
  bindTestInstanceCatalog(MAIN_CLI_INSTANCE_RESPONSE.instance);
});

describe('typed typography settings', () => {

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

});
