import { cleanup, fireEvent, render, screen } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  usePersistedViewState,
  type PersistedViewStateNormalizer,
} from '../../ui/src/hooks/usePersistedViewState';

type ViewState = {
  count: number;
  label: string;
};

const DEFAULTS: ViewState = { count: 1, label: 'default' };

const normalizeViewState: PersistedViewStateNormalizer<ViewState> = (value, defaults) => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { ...defaults };
  }
  const record = value as Record<string, unknown>;
  return {
    count: typeof record.count === 'number' && Number.isFinite(record.count)
      ? record.count
      : defaults.count,
    label: typeof record.label === 'string' ? record.label : defaults.label,
  };
};

function installStorage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  const storage: Storage = {
    get length() {
      return values.size;
    },
    clear: vi.fn(() => values.clear()),
    getItem: vi.fn((key: string) => values.get(key) ?? null),
    key: vi.fn((index: number) => Array.from(values.keys())[index] ?? null),
    removeItem: vi.fn((key: string) => {
      values.delete(key);
    }),
    setItem: vi.fn((key: string, value: string) => {
      values.set(key, value);
    }),
  };
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    value: storage,
  });
  return { storage, values };
}

function Probe({ storageKey }: { storageKey: string }) {
  const [state, setState] = usePersistedViewState(
    storageKey,
    normalizeViewState,
    DEFAULTS,
  );
  return (
    <div>
      <output aria-label="state">{JSON.stringify(state)}</output>
      <button type="button" onClick={() => setState((current) => ({
        ...current,
        count: current.count + 1,
      }))}>
        Increment
      </button>
      <button type="button" onClick={() => setState((current) => ({ ...current }))}>
        Clone
      </button>
    </div>
  );
}

beforeEach(() => {
  installStorage();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('usePersistedViewState', () => {
  it('reads and normalizes stored state once without rewriting on mount', () => {
    const { storage } = installStorage({
      'view:a': JSON.stringify({ count: 7, label: 42, ignored: true }),
    });

    const { rerender } = render(<Probe storageKey="view:a" />);
    expect(screen.getByLabelText('state').textContent).toBe(
      JSON.stringify({ count: 7, label: 'default' }),
    );
    expect(storage.getItem).toHaveBeenCalledTimes(1);
    expect(storage.setItem).not.toHaveBeenCalled();

    rerender(<Probe storageKey="view:a" />);
    expect(storage.getItem).toHaveBeenCalledTimes(1);
    expect(storage.setItem).not.toHaveBeenCalled();
  });

  it('falls back to normalized defaults for missing or malformed storage', () => {
    const { rerender } = render(<Probe storageKey="missing" />);
    expect(screen.getByLabelText('state').textContent).toBe(JSON.stringify(DEFAULTS));

    installStorage({ malformed: '{not json' });
    rerender(<Probe storageKey="malformed" />);
    expect(screen.getByLabelText('state').textContent).toBe(JSON.stringify(DEFAULTS));
  });

  it('writes changed state but skips structurally unchanged updates', () => {
    const { storage, values } = installStorage();
    render(<Probe storageKey="view:a" />);

    fireEvent.click(screen.getByRole('button', { name: 'Increment' }));
    expect(values.get('view:a')).toBe(JSON.stringify({ count: 2, label: 'default' }));
    expect(storage.setItem).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('button', { name: 'Clone' }));
    expect(storage.setItem).toHaveBeenCalledTimes(1);
  });

  it('loads a changed key without leaking or persisting the previous key state', () => {
    const { storage, values } = installStorage({
      'view:a': JSON.stringify({ count: 3, label: 'a' }),
      'view:b': JSON.stringify({ count: 8, label: 'b' }),
    });
    const { rerender } = render(<Probe storageKey="view:a" />);

    rerender(<Probe storageKey="view:b" />);
    expect(screen.getByLabelText('state').textContent).toBe(
      JSON.stringify({ count: 8, label: 'b' }),
    );
    expect(storage.getItem).toHaveBeenCalledTimes(2);
    expect(storage.setItem).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Increment' }));
    expect(values.get('view:a')).toBe(JSON.stringify({ count: 3, label: 'a' }));
    expect(values.get('view:b')).toBe(JSON.stringify({ count: 9, label: 'b' }));
  });

  it('disables persistence for an empty key and isolates transitions to real keys', () => {
    const { storage } = installStorage({
      'view:a': JSON.stringify({ count: 6, label: 'stored' }),
    });
    const { rerender } = render(<Probe storageKey="" />);

    expect(screen.getByLabelText('state').textContent).toBe(JSON.stringify(DEFAULTS));
    expect(storage.getItem).not.toHaveBeenCalled();
    expect(storage.setItem).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Increment' }));
    expect(screen.getByLabelText('state').textContent).toBe(
      JSON.stringify({ count: 2, label: 'default' }),
    );
    expect(storage.setItem).not.toHaveBeenCalled();

    rerender(<Probe storageKey="view:a" />);
    expect(screen.getByLabelText('state').textContent).toBe(
      JSON.stringify({ count: 6, label: 'stored' }),
    );
    expect(storage.getItem).toHaveBeenCalledTimes(1);
    expect(storage.setItem).not.toHaveBeenCalled();

    rerender(<Probe storageKey="" />);
    expect(screen.getByLabelText('state').textContent).toBe(JSON.stringify(DEFAULTS));
    expect(storage.getItem).toHaveBeenCalledTimes(1);
    expect(storage.setItem).not.toHaveBeenCalled();
  });

  it('survives storage read and write failures', () => {
    const { storage } = installStorage();
    vi.mocked(storage.getItem).mockImplementation(() => {
      throw new Error('storage denied');
    });
    vi.mocked(storage.setItem).mockImplementation(() => {
      throw new Error('quota exceeded');
    });

    expect(() => render(<Probe storageKey="view:a" />)).not.toThrow();
    expect(screen.getByLabelText('state').textContent).toBe(JSON.stringify(DEFAULTS));
    expect(() => fireEvent.click(screen.getByRole('button', { name: 'Increment' }))).not.toThrow();
    expect(screen.getByLabelText('state').textContent).toBe(
      JSON.stringify({ count: 2, label: 'default' }),
    );
  });

  it('falls back when the normalizer rejects stored input', () => {
    const rejectingNormalizer: PersistedViewStateNormalizer<ViewState> = (value, defaults) => {
      if (value === defaults) return { ...defaults };
      throw new Error('invalid stored shape');
    };
    installStorage({ 'view:a': JSON.stringify({ count: 'wrong' }) });

    function RejectingProbe() {
      const [state] = usePersistedViewState('view:a', rejectingNormalizer, DEFAULTS);
      return <output aria-label="rejecting-state">{JSON.stringify(state)}</output>;
    }

    expect(() => render(<RejectingProbe />)).not.toThrow();
    expect(screen.getByLabelText('rejecting-state').textContent).toBe(JSON.stringify(DEFAULTS));
  });
});
