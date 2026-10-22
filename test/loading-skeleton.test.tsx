import { cleanup, render, screen } from '@testing-library/preact';
import { afterEach, describe, expect, it } from 'vitest';

import { LoadingSkeleton } from '../ui/src/components/LoadingSkeleton';

afterEach(cleanup);

describe('LoadingSkeleton', () => {
  it('announces loading without exposing decorative placeholders', () => {
    const { container } = render(<LoadingSkeleton variant="canvas" label="Loading graph" />);
    expect(screen.getByRole('status', { name: 'Loading graph' })).toBeTruthy();
    expect(container.querySelector('.loading-skeleton__surface')?.getAttribute('aria-hidden')).toBe('true');
    expect(container.querySelector('.loading-skeleton--canvas')).toBeTruthy();
  });
});
