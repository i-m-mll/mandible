import { cleanup, render, screen } from '@testing-library/preact';
import { afterEach, describe, expect, it } from 'vitest';

import {
  AttributionIdentity,
  evidenceBadgeFor,
} from '../ui/src/components/shared/DetailHeaderIdentity';
import type { AttributionReadProjection } from '../ui/src/api';

afterEach(cleanup);

function attribution(method: string | null): AttributionReadProjection {
  return {
    user: { id: 'u1', display_name: 'Author', kind: 'agent' },
    evidence_method: method,
    evidence_id: method ? 'ev1' : null,
    credential: null,
  };
}

describe('evidenceBadgeFor mapping', () => {
  it('marks a bearer token and a credential signature as verified', () => {
    expect(evidenceBadgeFor('api_token')).toMatchObject({
      strength: 'verified',
      label: 'verified',
      title: 'Verified by API token',
    });
    expect(evidenceBadgeFor('credential_signature')).toMatchObject({
      strength: 'verified',
      label: 'verified',
    });
  });

  it('marks a session claim as claimed and unverified', () => {
    expect(evidenceBadgeFor('session_claim')).toMatchObject({
      strength: 'claimed',
      label: 'claimed',
      title: 'Claimed from session binding, not verified',
    });
  });

  it('renders no badge for the system user, unattributed rows, or unenumerated methods', () => {
    expect(evidenceBadgeFor('system_internal')).toBeNull();
    expect(evidenceBadgeFor('local_default')).toBeNull();
    expect(evidenceBadgeFor(null)).toBeNull();
    expect(evidenceBadgeFor(undefined)).toBeNull();
  });
});

describe('AttributionIdentity evidence badge rendering', () => {
  it('renders a verified badge with a plain-language tooltip', () => {
    render(<AttributionIdentity display="Author" attribution={attribution('api_token')} />);
    const badge = screen.getByText('verified');
    expect(badge.className).toContain('attribution-identity__evidence--verified');
    expect(badge.getAttribute('title')).toBe('Verified by API token');
  });

  it('renders a claimed badge visually distinct from verified', () => {
    render(<AttributionIdentity display="Author" attribution={attribution('session_claim')} />);
    const badge = screen.getByText('claimed');
    expect(badge.className).toContain('attribution-identity__evidence--claimed');
    expect(badge.getAttribute('title')).toContain('not verified');
    expect(screen.queryByText('verified')).toBeNull();
  });

  it('renders no evidence badge for the system-internal daemon user', () => {
    render(<AttributionIdentity display="Mandible" attribution={attribution('system_internal')} />);
    expect(screen.queryByText('verified')).toBeNull();
    expect(screen.queryByText('claimed')).toBeNull();
  });

  it('renders an unattributed author as a plain string with no badge or trigger', () => {
    render(<AttributionIdentity display="Imported Author (verbatim)" attribution={null} />);
    const name = screen.getByText('Imported Author (verbatim)');
    expect(name.tagName).toBe('SPAN');
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.queryByText('verified')).toBeNull();
    expect(screen.queryByText('claimed')).toBeNull();
  });

  it('labels known agents but never speculates that an operator is human', () => {
    const verified = attribution('api_token');
    render(<AttributionIdentity display="Operator" attribution={verified} />);
    expect(screen.queryByText('human')).toBeNull();
    cleanup();
    render(<AttributionIdentity
      display="Worker"
      attribution={{ ...verified, user: { ...verified.user!, kind: 'agent' } }}
    />);
    expect(screen.getByText('agent')).toBeTruthy();
  });
});
