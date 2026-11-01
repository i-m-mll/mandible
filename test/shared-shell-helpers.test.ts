import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { expect, it } from 'vitest';
import { testRuntimeRoot } from './helpers/runtime-isolation.js';
import { authCliRepo } from './helpers/prepared-git-fixture.js';

it.each(['bash', 'zsh'])('%s preserves PATH and returns ledger and CSRF results from shared helpers', shell => {
  const root = fs.mkdtempSync(path.join(testRuntimeRoot, 'shared-shell-'));
  authCliRepo.copyInto(root);
  try {
    const result = spawnSync(shell, ['-c', `
      source "$MANDIBLE_CLI_DIR/ledger-client.sh"
      source "$MANDIBLE_CLI_DIR/auth-status.sh"
      original_path="$PATH"
      mandible_issue_file_write --cwd "$FIXTURE" alpha beta || exit 10
      refs=$(mandible_issue_file_read "$FIXTURE") || exit 11
      [[ "$refs" == $'alpha\\nbeta' && "$PATH" == "$original_path" ]] || exit 12
      api_send_capture() { printf '%s' '{"ref":"fixture"}' > "$4"; printf '%s' "$FIXTURE_HTTP_STATUS"; }
      FIXTURE_HTTP_STATUS=200
      body=$(mandible_ledger_request GET /fixture) || exit 13
      [[ "$body" == '{"ref":"fixture"}' ]] || exit 14
      FIXTURE_HTTP_STATUS=403
      if mandible_ledger_request GET /fixture '' 1; then exit 15; fi
      FIXTURE_HTTP_STATUS=503
      mandible_ledger_request GET /fixture '' 1 || exit 16
      curl() {
        while [[ "$#" -gt 0 ]]; do
          if [[ "$1" == -o ]]; then shift; printf '%s' '{"session":{"csrf_token":"fixture-token"}}' > "$1"; fi
          shift
        done
        printf 200
      }
      token=$(api_local_operator_csrf) || exit 17
      [[ "$token" == fixture-token && "$PATH" == "$original_path" ]] || exit 18
      mandible_auth_report fixture '{"status":"completed","exit_code":0}' || exit 19
    `], { cwd: root, env: { ...process.env, FIXTURE: root, MANDIBLE_CLI_DIR: path.join(process.cwd(), 'cli') }, encoding: 'utf8', timeout: 15_000 });
    expect(result.status, result.stdout + result.stderr).toBe(0);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
