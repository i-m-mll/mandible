// @vitest-environment node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { LocalSessionAuthority, type InstanceRegistration } from '../src/client-auth/session-authority.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
const production: InstanceRegistration = {
  instance_id: 'production', installation_id: 'install-test', role: 'main',
  public_origin: 'https://app.mandible.localhost:19420', backend_origin: 'http://127.0.0.1:29420',
  backend_generation: 'main-1', effect_ceiling: ['ledger:read', 'ledger:write'], writable_roots: [],
};
const preview: InstanceRegistration = {
  ...production, instance_id: 'preview-test', role: 'preview',
  public_origin: 'https://preview-test.mandible.localhost:19421',
  backend_origin: 'http://127.0.0.1:29421', backend_generation: 'preview-1',
  effect_ceiling: ['ledger:read'],
};
function authority() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mandible-preview-authority-')); roots.push(root);
  const dir = path.join(root, 'local-sessions');
  const auth = new LocalSessionAuthority(dir, 'install-test', { initialize: true });
  auth.registerInstance(production); auth.registerInstance(preview);
  return { auth, dir };
}

describe('installation preview context', () => {
  it('keeps registration identity stable while a backend generation changes', () => {
    const { auth } = authority();
    auth.registerInstance({ ...preview, backend_generation: 'preview-2' });
    expect(auth.instance('preview-test')?.backend_generation).toBe('preview-2');
    expect(() => auth.registerInstance({ ...preview, public_origin: 'https://other.mandible.localhost:19421' }))
      .toThrow('Conflicting registration');
    auth.close();
  });

  it('signs a bounded preview context and rejects changed generation or audience', async () => {
    const { auth, dir } = authority();
    const context = {
      family_id: 'os-user:install-test', root_family_id: 'os-user:install-test',
      user_id: 'human', slug: 'operator', audience: 'production',
      effect_ceiling: production.effect_ceiling, csrf_token: 'csrf', expires_at: Date.now(),
      evidence: { method: 'local_os_user', credential_id: null, authenticated_at: Date.now() },
    };
    const compact = await auth.signPreviewContext(context, 'preview-test');
    const key = auth.verificationKeyPem();
    expect(await LocalSessionAuthority.verifyPreviewContext(compact, key, preview)).toMatchObject({
      user_id: 'human', audience: 'preview-test', effect_ceiling: ['ledger:read'], csrf_token: 'csrf',
    });
    expect(await LocalSessionAuthority.verifyPreviewContext(compact, key, { ...preview, backend_generation: 'new' })).toBeNull();
    expect(await LocalSessionAuthority.verifyPreviewContext(compact, key, production)).toBeNull();
    expect(fs.existsSync(path.join(dir, 'context-signing-key.pem'))).toBe(true);
    auth.close();
  });
});
