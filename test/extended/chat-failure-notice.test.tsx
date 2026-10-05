import { cleanup, fireEvent, screen } from '@testing-library/preact';
import { render } from './notice-test-render';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  ChatFailureNotice,
  chatControlFailureNotice,
  chatSubmissionFailureNotice,
  chatSpawnFailureNotice,
} from '../../ui/src/chat/ChatFailureNotice.js';
import { ApiError } from '../../ui/src/api.js';

afterEach(cleanup);

describe('Chat provider failure notice', () => {
  it('shows one accessible bounded notice with folded provenance and retry', () => {
    const retry = vi.fn();
    const model = chatSpawnFailureNotice({
      code: 'provider_startup_timeout',
      message: 'Provider output '.repeat(40),
      retryable: true,
      phase: 'readiness',
      provenance: {
        backend_type: 'acp',
        provider: 'codex',
        implementation: {
          kind: 'package',
          name: '@agentclientprotocol/codex-acp',
          version: '1.0.2',
          entrypoint: 'dist/index.js',
          launcher: 'node',
        },
      },
    });

    render(<ChatFailureNotice failure={model} onRetry={retry} />);

    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain('The provider took too long to start.');
    expect(model.detail.length).toBeLessThanOrEqual(280);
    const folded = screen.getByText('Provider diagnostics').closest('details');
    expect(folded?.open).toBe(false);
    expect(folded?.textContent).toContain('@agentclientprotocol/codex-acp');
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(retry).toHaveBeenCalledOnce();
  });

  it('never offers retry when delivery is uncertain', () => {
    const model = chatControlFailureNotice({ kind: 'delivery-uncertain', delivery_id: 'delivery-1' });
    render(<ChatFailureNotice failure={model} onRetry={vi.fn()} />);

    expect(screen.getByRole('alert').textContent).toContain('avoid a duplicate message');
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
  });

  it('explains preview send denial without exposing the raw policy code', () => {
    const dismiss = vi.fn();
    const model = chatSubmissionFailureNotice(new ApiError('effect_forbidden', 403, 'effect_forbidden'));
    render(<ChatFailureNotice failure={model} onDismiss={dismiss} />);

    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain('cannot send messages to agents');
    expect(alert.textContent).not.toContain('effect_forbidden');
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss error' }));
    expect(dismiss).toHaveBeenCalledOnce();
  });
});
