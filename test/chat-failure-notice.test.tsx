import { cleanup, fireEvent, screen } from './helpers/dom.js';
import { render } from './helpers/notice-test-render';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ChatFailureNotice, chatControlFailureNotice, chatSubmissionFailureNotice } from '../ui/src/chat/ChatFailureNotice.js';
import { ApiError } from '../ui/src/api.js';

afterEach(cleanup);

describe('Chat provider failure notice', () => {

  it('never offers retry when delivery is uncertain', () => {
    const model = chatControlFailureNotice({ kind: 'delivery-uncertain', delivery_id: 'delivery-1' });
    render(<ChatFailureNotice failure={model} onRetry={vi.fn()} />);

    screen.getByRole('alert');
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
  });

  it('explains preview send denial without exposing the raw policy code', () => {
    const dismiss = vi.fn();
    const model = chatSubmissionFailureNotice(new ApiError('effect_forbidden', 403, 'effect_forbidden'));
    render(<ChatFailureNotice failure={model} onDismiss={dismiss} />);

    const alert = screen.getByRole('alert');
    expect(alert.textContent).not.toContain('effect_forbidden');
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss error' }));
    expect(dismiss).toHaveBeenCalledOnce();
  });
});
