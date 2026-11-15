import type { SigningRefusalCode } from '../../../src/operator-signing/authority';
import type { ApprovalTier } from '../api';

export type ApprovalRefusal = {
  title: string;
  body: string;
  severity: 'info' | 'warning' | 'error';
  /** The approval key cannot be used again; the operator enrolls a new one in Settings. */
  reenroll: boolean;
};

const REFUSALS: Record<SigningRefusalCode, ApprovalRefusal> = {
  cancelled: {
    title: 'Approval cancelled',
    body: 'Nothing was signed or changed. The request is still pending.',
    severity: 'info',
    reenroll: false,
  },
  biometry_unavailable: {
    title: 'Touch ID unavailable',
    body: 'Touch ID cannot be used right now, for example with the lid closed and no Touch ID keyboard. There is no password approval; approve again once Touch ID is available.',
    severity: 'warning',
    reenroll: false,
  },
  biometry_locked_out: {
    title: 'Touch ID locked',
    body: 'macOS locked Touch ID after too many failed matches. Unlock the Mac with your account password to re-enable it, then approve again.',
    severity: 'warning',
    reenroll: false,
  },
  no_interactive_session: {
    title: 'No login session',
    body: 'The approval helper cannot show the Touch ID sheet without a logged-in macOS session. Log in to this Mac, then approve again.',
    severity: 'warning',
    reenroll: false,
  },
  key_invalidated: {
    title: 'Approval key needs re-enrollment',
    body: 'The enrolled fingerprints changed, so the Secure Enclave will not use this approval key again. Enroll a new key in Settings; the replacement is recorded as a bootstrap enrollment.',
    severity: 'error',
    reenroll: true,
  },
  key_missing: {
    title: 'Approval key needs re-enrollment',
    body: 'The approval key file is missing. Enroll a new key in Settings; the replacement is recorded as a bootstrap enrollment.',
    severity: 'error',
    reenroll: true,
  },
  approval_key_required: {
    title: 'No approval key',
    body: 'Enroll an approval key in Settings before approving a protected merge.',
    severity: 'error',
    reenroll: true,
  },
  operator_required: {
    title: 'No operator',
    body: 'Configure the local operator before approving a protected merge.',
    severity: 'error',
    reenroll: false,
  },
  bootstrap_confirmation_required: {
    title: 'Approval key failed',
    body: 'The approval key failed for a reason the helper could not classify. Replace it in Settings.',
    severity: 'error',
    reenroll: true,
  },
  untrusted_signature: {
    title: 'Signature rejected',
    body: 'The signature did not verify against the enrolled approval key, so nothing was approved. If you did not expect a Touch ID sheet, report it.',
    severity: 'error',
    reenroll: false,
  },
  signing_failed: {
    title: 'Signing failed',
    body: 'The approval helper could not sign. Nothing was approved.',
    severity: 'error',
    reenroll: false,
  },
  stale: {
    title: 'Request changed',
    body: 'The request changed while it was being signed. Nothing was approved; review it and approve again.',
    severity: 'warning',
    reenroll: false,
  },
};

const PREFIX = 'operator_signature_';

/** The state an approval ended in, from the code the daemon gives a refused signature. */
export function approvalRefusal(code: string | null): ApprovalRefusal | null {
  if (!code?.startsWith(PREFIX)) return null;
  return REFUSALS[code.slice(PREFIX.length) as SigningRefusalCode] ?? null;
}

export function approveLabel(tier: ApprovalTier): string {
  return tier === 'signed' ? 'Approve with Touch ID' : 'Approve as courtesy';
}

export function approveTitle(tier: ApprovalTier): string {
  return tier === 'signed'
    ? 'Signs the merge commit with your approval key. macOS shows a Touch ID sheet right after this click and at no other time; cancel any sheet you did not expect.'
    : 'Courtesy approval: one click, recorded as an interface action. It is not operator-verified, because any process running as you can perform it.';
}
