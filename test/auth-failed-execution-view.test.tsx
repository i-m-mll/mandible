// @vitest-environment jsdom
/**
 * Issue cc8fe29 — the request view shows a failed execution as Failed with its
 * reason and a Retry action, and a request that succeeded on retry still lists
 * the failed execution before the successful one.
 */
import { establishTestClientAccess } from './helpers/local-client-access';
import { cleanup, render, screen, within } from './helpers/dom.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { __resetBrowserSessionForTests } from '../ui/src/client-auth-token';
import { AuthQueueView, type AuthRequest } from '../ui/src/views/auth';
import { authMainInstance, bindAuthUiOperations } from './helpers/auth-ui-fixture';

const REASON = 'signing failed: user presence not confirmed; no ref changed';
const failedAttempt = { revision: 5, occurred_at: 1_700_000_100_000, result: 'failed' as const, exit_code: 1, failure_reason: REASON };

const base: AuthRequest = {
  id: 'req-signing-0123456789',
  type: 'merge',
  title: 'Verify fresh health',
  repo: 'mandible',
  head_branch: 'feature/x',
  base_branch: 'main',
  commit_message: 'Merge feature/x',
  created_at: 1_700_000_000_000,
  updated_at: 1_700_000_100_000,
  output: 'Signed commit creation failed; no ref or worktree was changed.',
  diff_summary: '',
  actions: [],
};

function renderView(request: AuthRequest) {
  return render(
    <AuthQueueView
      instance={authMainInstance}
      queue={[request]}
      historyQueue={[]}
      outputs={{}}
      selectedAuthId={request.id}
      onSelectAuth={() => undefined}
      daemonReady={true}
      onApprove={() => undefined}
      onReject={() => undefined}
      onRetry={() => undefined}
      onDismiss={() => undefined}
    />,
  );
}

beforeEach(async () => {
  await establishTestClientAccess();
  bindAuthUiOperations();
  vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('offline'))));
  Element.prototype.scrollIntoView = vi.fn();
});

afterEach(() => {
  __resetBrowserSessionForTests();
  cleanup();
  vi.unstubAllGlobals();
});

describe('failed auth execution in the request view', () => {
  it('reads as Failed with its reason and offers Retry', async () => {
    renderView({ ...base, status: 'failed', exit_code: 1, failure_reason: REASON, execution_attempts: [failedAttempt] });

    await screen.findByText(REASON, { selector: '.auth-failure__summary' });
    expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy();
  });

  it('keeps the failed execution in the history of a request that succeeded on retry', async () => {
    renderView({
      ...base,
      status: 'completed',
      exit_code: 0,
      failure_reason: null,
      execution_attempts: [
        failedAttempt,
        { revision: 9, occurred_at: 1_700_000_200_000, result: 'succeeded', exit_code: 0, failure_reason: null },
      ],
    });

    const executions = await screen.findByRole('region', { name: 'Executions' });
    const items = within(executions).getAllByRole('listitem');
    expect(items).toHaveLength(2);
    expect(within(items[0]).getByText(REASON)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
  });
});
