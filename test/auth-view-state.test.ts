import { render, mainInstance } from './helpers/ui-workspace-fixture';

import { screen, fireEvent, waitFor, cleanup } from '@testing-library/preact';
import { beforeEach, describe, expect, it } from 'vitest';
import { h } from 'preact';
import { bindAuthUiOperations } from './helpers/auth-ui-fixture';

beforeEach(() => bindAuthUiOperations(mainInstance));
import { AuthQueueView } from '../ui/src/views/auth';

describe('AuthQueueView', () => {

  it('retains a finalized active-filter selection until another request is selected', async () => {
    const completed = {
      id: 'req-retained-final', title: 'Retained final request', type: 'merge', repo: 'mandible',
      base_branch: 'main', head_branch: 'feature/retained', status: 'pending',
      diff_summary: '', spec_content: '', output: '',
    };
    const pending = {
      id: 'req-next', title: 'Next request', type: 'merge', repo: 'mandible',
      base_branch: 'main', head_branch: 'feature/next', status: 'pending',
      diff_summary: '', spec_content: '', output: '',
    };
    const view = render(h(AuthQueueView, {
      queue: [completed, pending], outputs: {}, initialRequestId: completed.id,
      onApprove: () => undefined, onReject: () => undefined,
    }));
    await waitFor(() => expect(document.querySelector('[data-request-id="req-retained-final"]')?.getAttribute('aria-current')).toBe('true'));
    view.rerender(h(AuthQueueView, {
      queue: [{ ...completed, status: 'completed' }, pending], outputs: {}, initialRequestId: completed.id,
      onApprove: () => undefined, onReject: () => undefined,
    }));

    await waitFor(() => expect(document.querySelector('[data-request-id="req-retained-final"]')).toBeTruthy());
    expect(window.sessionStorage.getItem('mandible.auth.retained-finalized-selection')).toBe(completed.id);
    fireEvent.click(document.querySelector('[data-request-id="req-next"]') as Element);
    await waitFor(() => expect(document.querySelector('[data-request-id="req-retained-final"]')).toBeNull());
    expect(window.sessionStorage.getItem('mandible.auth.retained-finalized-selection')).toBeNull();
  });

  it('clears finalized retention when a new deep link selects another request', async () => {
    const finalized = { id: 'req-deep-final', title: 'Deep final', repo: 'mandible', status: 'pending' };
    const next = { id: 'req-deep-next', title: 'Deep next', repo: 'mandible', status: 'pending' };
    const view = render(h(AuthQueueView, {
      queue: [finalized, next], outputs: {}, initialRequestId: finalized.id,
      onApprove: () => undefined, onReject: () => undefined,
    }));
    view.rerender(h(AuthQueueView, {
      queue: [{ ...finalized, status: 'completed' }, next], outputs: {}, initialRequestId: finalized.id,
      onApprove: () => undefined, onReject: () => undefined,
    }));
    await waitFor(() => expect(window.sessionStorage.getItem('mandible.auth.retained-finalized-selection')).toBe(finalized.id));

    view.rerender(h(AuthQueueView, {
      queue: [{ ...finalized, status: 'completed' }, next], outputs: {}, initialRequestId: next.id,
      onApprove: () => undefined, onReject: () => undefined,
    }));

    await waitFor(() => expect(window.sessionStorage.getItem('mandible.auth.retained-finalized-selection')).toBeNull());
    expect(document.querySelector('[data-request-id="req-deep-next"]')?.getAttribute('aria-current')).toBe('true');
  });

  it('clears finalized retention on filter-driven selection without losing All-filter history', async () => {
    const finalized = { id: 'req-filter-final', title: 'Filter final', repo: 'mandible', status: 'pending' };
    const next = { id: 'req-filter-next', title: 'Filter next', repo: 'mandible', status: 'pending' };
    const view = render(h(AuthQueueView, {
      queue: [finalized, next], historyQueue: [], outputs: {}, initialRequestId: finalized.id,
      onApprove: () => undefined, onReject: () => undefined,
    }));
    view.rerender(h(AuthQueueView, {
      queue: [{ ...finalized, status: 'completed' }, next],
      historyQueue: [{ ...finalized, status: 'completed' }],
      outputs: {}, initialRequestId: finalized.id,
      onApprove: () => undefined, onReject: () => undefined,
    }));
    await waitFor(() => expect(window.sessionStorage.getItem('mandible.auth.retained-finalized-selection')).toBe(finalized.id));

    fireEvent.input(screen.getByLabelText('Search approval requests'), {
      target: { value: 'Filter next' },
    });
    await waitFor(() => expect(document.querySelector('[data-request-id="req-filter-next"]')?.getAttribute('aria-current')).toBe('true'));
    expect(window.sessionStorage.getItem('mandible.auth.retained-finalized-selection')).toBeNull();

    fireEvent.input(screen.getByLabelText('Search approval requests'), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'Advanced approval filters' }));
    fireEvent.click(screen.getByRole('button', { name: 'all' }));
    await waitFor(() => expect(document.querySelector('[data-request-id="req-filter-final"]')).toBeTruthy());
  });

  it('renders canonical commit messages through sanitized Markdown without an authorship badge', () => {
    render(
      h(AuthQueueView, {
        queue: [{
          id: 'req-canonical-markdown',
          title: 'Canonical Markdown auth',
          repo: 'mandible',
          base: 'main',
          head: 'feature/canonical-markdown',
          status: 'pending',
          commit_message: 'Ship **structured prose** with [artifact:bbbbbbbbbbbb].\n\n<script>window.compromised = true</script>',
          commit_message_digest: 'a'.repeat(64),
        }],
        outputs: {},
        selectedAuthId: 'req-canonical-markdown',
        onApprove: () => undefined,
        onReject: () => undefined,
      }),
    );

    expect(screen.getByText('structured prose').tagName).toBe('STRONG');
    expect(document.querySelector('[data-resource-ref="artifact:bbbbbbbbbbbb"]')).toBeTruthy();
    expect(document.querySelector('script')).toBeNull();
    expect((window as { compromised?: boolean }).compromised).toBeUndefined();
  });

  it('shows a spec stored by an older request as sanitized read-only Markdown', () => {
    const multilineSpec = [
      '# Intent',
      '',
      'Keep **review prose** readable.',
      '',
      '## Scope',
      '',
      '- Preserve paragraphs and lists.',
      '- Reuse the Auth Markdown renderer.',
      '',
      '```text',
      'bun run typecheck',
      '```',
      '',
      '<img src=x onerror="window.compromised = true">',
    ].join('\n');
    render(
      h(AuthQueueView, {
        queue: [{
          id: 'req-multiline-spec',
          title: 'Multiline specification',
          repo: 'mandible',
          base: 'main',
          head: 'feature/multiline-spec',
          status: 'pending',
          spec_content: multilineSpec,
        }],
        outputs: {},
        selectedAuthId: 'req-multiline-spec',
        onApprove: () => undefined,
        onReject: () => undefined,
      }),
    );

    fireEvent.click(screen.getByRole('button', { name: /Specification/ }));
    expect(screen.getByRole('heading', { name: 'Intent' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Scope' })).toBeTruthy();
    expect(screen.getByText('review prose').tagName).toBe('STRONG');
    const image = document.querySelector('img[src="x"]');
    expect(image).toBeTruthy();
    expect(image?.hasAttribute('onerror')).toBe(false);

    cleanup();
    render(
      h(AuthQueueView, {
        queue: [{
          id: 'req-legacy-spec',
          title: 'Legacy specification',
          repo: 'mandible',
          status: 'pending',
          spec_content: 'Intent: keep this exact one-line specification.',
        }],
        outputs: {},
        selectedAuthId: 'req-legacy-spec',
        onApprove: () => undefined,
        onReject: () => undefined,
      }),
    );
    fireEvent.click(screen.getByRole('button', { name: /Specification/ }));
    expect(screen.getByText('Intent: keep this exact one-line specification.')).toBeTruthy();
    expect(screen.queryByRole('heading', { name: /keep this exact/ })).toBeNull();
  });
});

