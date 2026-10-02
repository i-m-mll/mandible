// @vitest-environment node
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const api = path.resolve('cli/api.sh');

describe('unmarked local human CLI', () => {
  it('uses the registered origin and CSRF for writes without a token', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mandible-cli-os-user-'));
    try {
      const bin = path.join(root, 'bin'); fs.mkdirSync(bin);
      const log = path.join(root, 'curl.log');
      const keychainLog = path.join(root, 'keychain.log');
      const curl = path.join(bin, 'curl');
      fs.writeFileSync(curl, `#!/bin/bash
printf '%s\\n' "$@" >> "$CURL_LOG"
out=''
while (( $# )); do
  if [[ "$1" == '-o' ]]; then out="$2"; shift 2; else shift; fi
done
if [[ "$(tail -n 1 "$CURL_LOG")" == */api/client-auth/whoami ]]; then
  printf '%s' '{"authenticated":true,"session":{"csrf_token":"local-csrf"}}' > "$out"
else
  printf '%s' '{"ok":true}' > "$out"
fi
printf 200
`); fs.chmodSync(curl, 0o755);
      const env = { ...process.env, HOME: root, PATH: `${bin}:${process.env.PATH}`,
        CURL_LOG: log, MANDIBLE_BASE: 'https://app.mandible.localhost:19420', MANDIBLE_TRANSPORT: 'http',
        MANDIBLE_NO_KEYCHAIN_TOKEN: '1', MANDIBLE_TOKEN: '',
        CODEX_THREAD_ID: '', CODEX_SESSION_ID: '', CLAUDE_CODE_SESSION_ID: '',
        CLAUDE_SESSION_ID: '', GEMINI_SESSION_ID: '', MANDIBLE_SESSION_ID: '',
        MANDIBLE_MANAGED_CLIENT: '', MANDIBLE_PROVIDER: '',
      };
      const result = spawnSync('bash', ['-c', 'source "$API_HELPER"; api_keychain_operator_token() { printf called >> "$KEYCHAIN_LOG"; printf revoked-token; }; api_http_exchange POST /api/issues/test-write "{}" "$OUTPUT"'], {
        env: { ...env, API_HELPER: api, OUTPUT: path.join(root, 'response'), KEYCHAIN_LOG: keychainLog }, encoding: 'utf8',
      });
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toBe('200');
      const args = fs.readFileSync(log, 'utf8');
      expect(args).toContain('/api/client-auth/whoami');
      expect(args).toContain('Origin: https://app.mandible.localhost:19420');
      expect(args).toContain('Sec-Fetch-Site: same-origin');
      expect(args).toContain('X-Mandible-CSRF: local-csrf');
      expect(args).not.toContain('Authorization: Bearer');
      expect(fs.existsSync(keychainLog)).toBe(false);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
});
