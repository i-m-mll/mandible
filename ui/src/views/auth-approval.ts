import type { SigningRefusalCode } from '../../../src/operator-signing/authority';
import type { ApprovalTier } from '../api';

export type ApprovalRefusal = {
  title: string;
  /** Null when the daemon's own message is the explanation. */
  body: string | null;
  severity: 'info' | 'warning' | 'error';
  /** No usable approval key: the operator enrolls in Settings → Approvals. */
  setUp: boolean;
};

const NOT_SET_UP: ApprovalRefusal = {
  title: 'Touch ID is not set up',
  body: 'Protected merges are signed with Touch ID. Enroll in Settings, then approve again.',
  severity: 'warning',
  setUp: true,
};

const REFUSALS: Record<SigningRefusalCode, ApprovalRefusal> = {
  cancelled: {
    title: 'Approval cancelled',
    body: 'Nothing was signed or changed. The request is still pending.',
    severity: 'info',
    setUp: false,
  },
  biometry_unavailable: {
    title: 'Touch ID unavailable',
    body: 'Touch ID cannot be used right now, for example with the lid closed and no Touch ID keyboard. There is no password approval; approve again once Touch ID is available.',
    severity: 'warning',
    setUp: false,
  },
  biometry_locked_out: {
    title: 'Touch ID locked',
    body: 'macOS locked Touch ID after too many failed matches. Unlock the Mac with your account password to re-enable it, then approve again.',
    severity: 'warning',
    setUp: false,
  },
  no_interactive_session: {
    title: 'No login session',
    body: 'The approval helper cannot show the Touch ID sheet without a logged-in macOS session. Log in to this Mac, then approve again.',
    severity: 'warning',
    setUp: false,
  },
  key_invalidated: NOT_SET_UP,
  key_missing: NOT_SET_UP,
  approval_key_required: NOT_SET_UP,
  operator_required: {
    title: 'No operator',
    body: 'Configure the local operator before approving a protected merge.',
    severity: 'error',
    setUp: false,
  },
  bootstrap_confirmation_required: {
    title: 'Approval key failed',
    body: 'The approval key failed for a reason the helper could not classify. Enroll again in Settings.',
    severity: 'error',
    setUp: true,
  },
  untrusted_signature: {
    title: 'Signature rejected',
    body: 'The signature did not verify against the enrolled approval key, so nothing was approved. If you did not expect a Touch ID sheet, report it.',
    severity: 'error',
    setUp: false,
  },
  signing_in_progress: {
    title: 'Another approval is waiting',
    body: 'A Touch ID sheet for another signed action is already open. One click opens one sheet: finish or cancel that one, then approve again.',
    severity: 'warning',
    setUp: false,
  },
  signing_failed: {
    title: 'Signing failed',
    body: null,
    severity: 'error',
    setUp: false,
  },
  stale: {
    title: 'Request changed',
    body: 'The request changed while it was being signed. Nothing was approved; review it and approve again.',
    severity: 'warning',
    setUp: false,
  },
};

const PREFIX = 'operator_signature_';

/** The Settings section where Touch ID is enrolled. */
export const APPROVAL_SETTINGS_SECTION = 'settings-approvals';

/** The state an approval ended in, from the code the daemon gives a refused signature. */
export function approvalRefusal(code: string | null): ApprovalRefusal | null {
  if (!code?.startsWith(PREFIX)) return null;
  return REFUSALS[code.slice(PREFIX.length) as SigningRefusalCode] ?? null;
}

export function approveTitle(tier: ApprovalTier): string {
  return tier === 'signed'
    ? 'Signs the merge commit with your approval key. macOS shows a Touch ID sheet right after this click and at no other time; cancel any sheet you did not expect.'
    : 'One click, recorded as an interface action. It is not operator-verified, because any process running as you can perform it.';
}
