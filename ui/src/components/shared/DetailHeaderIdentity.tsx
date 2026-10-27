import type { ComponentChildren } from 'preact';
import { useState } from 'preact/hooks';
import { useIsFrameHeader } from './FrameHeader';
import { appTip } from './AppHoverTips';
import type { AttributionReadProjection, ReadUserIdentity } from '../../api';

export type DetailHeaderIdentityProps = {
  contextLabel?: string | null;
  shortId: string;
  copyValue: string;
  copyLabel?: string;
  className?: string;
  contextClassName?: string;
  shortIdClassName?: string;
  children?: ComponentChildren;
};

export function DetailHeaderIdentity({
  contextLabel,
  shortId,
  copyValue,
  copyLabel,
  className = 'detail-header-identity',
  contextClassName,
  shortIdClassName,
  children,
}: DetailHeaderIdentityProps): JSX.Element {
  return (
    <div className={className}>
      {contextLabel && <><span className={contextClassName}>{contextLabel}</span>{' '}</>}
      <code className={shortIdClassName}>{shortId}</code>
      <CopyRefButton value={copyValue} label={copyLabel ?? `Copy ${copyValue}`} />
      {children}
    </div>
  );
}

export type EvidenceStrength = 'verified' | 'claimed';

export type EvidenceBadge = {
  strength: EvidenceStrength;
  label: string;
  title: string;
};

/**
 * Map a stored attribution evidence_method to the small inline badge shown next
 * to an attributed author. Verified methods (a bearer token or a credential
 * signature) read as trustworthy identity; a session_claim is an unverified
 * ambient claim and reads as such. system_internal (the daemon system user) and
 * NULL/unattributed rows return null: the system user is already conveyed by its
 * kind badge, and an unattributed row must never grow a false identity affordance.
 */
export function evidenceBadgeFor(
  method: string | null | undefined,
): EvidenceBadge | null {
  switch (method) {
    case 'api_token':
      return { strength: 'verified', label: 'verified', title: 'Verified by API token' };
    case 'credential_signature':
      return {
        strength: 'verified',
        label: 'verified',
        title: 'Verified by credential signature',
      };
    case 'session_claim':
      return {
        strength: 'claimed',
        label: 'claimed',
        title: 'Claimed from session binding, not verified',
      };
    default:
      return null;
  }
}

export function AttributionIdentity({
  display,
  user,
  attribution,
  source,
  className = '',
}: {
  display: string;
  user?: ReadUserIdentity | null;
  attribution?: AttributionReadProjection | null;
  source?: string | null;
  className?: string;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const resolvedUser = attribution?.user ?? user ?? null;
  const evidenceBadge = evidenceBadgeFor(attribution?.evidence_method);
  const hasProvenance = Boolean(
    resolvedUser || attribution?.evidence_method || attribution?.credential || source,
  );
  if (!hasProvenance) return <span className={className || undefined}>{display}</span>;

  return (
    <span className={`attribution-identity${className ? ` ${className}` : ''}`}>
      <button
        type="button"
        className="attribution-identity__trigger"
        aria-label={`Show attribution for ${display}`}
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <span className="attribution-identity__name">{display}</span>
        {resolvedUser?.kind === 'agent' && (
          <span className={`attribution-identity__kind attribution-identity__kind--${resolvedUser.kind}`}>
            {resolvedUser.kind}
          </span>
        )}
        {evidenceBadge && (
          <span
            className={`attribution-identity__evidence attribution-identity__evidence--${evidenceBadge.strength}`}
            title={evidenceBadge.title}
            aria-label={evidenceBadge.title}
          >
            {evidenceBadge.label}
          </span>
        )}
      </button>
      {open && (
        <dl className="attribution-identity__popover">
          {resolvedUser && <IdentityRow label="User" value={resolvedUser.display_name} />}
          {resolvedUser && <IdentityRow label="Kind" value={resolvedUser.kind} />}
          {attribution?.evidence_method && (
            <IdentityRow label="Evidence" value={attribution.evidence_method.replace(/_/g, ' ')} />
          )}
          {source && <IdentityRow label="Source" value={source.replace(/_/g, ' ')} />}
          {attribution?.credential && (
            <IdentityRow
              label="Credential"
              value={attribution.credential.label || attribution.credential.type}
            />
          )}
        </dl>
      )}
    </span>
  );
}

function IdentityRow({ label, value }: { label: string; value: string }): JSX.Element {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

export function CopyRefButton({ value, label }: { value: string; label: string }): JSX.Element {
  const frameHeader = useIsFrameHeader();
  const [copied, setCopied] = useState(false);
  const effectiveLabel = copied ? 'Copied reference' : label;

  const handleCopy = async () => {
    try {
      await copyText(value);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    } catch {
      setCopied(false);
    }
  };

  return (
    <button
      type="button"
      className="ledger-copy-ref-button"
      {...(frameHeader ? appTip(copied ? 'Copied' : label) : { title: copied ? 'Copied' : label })}
      aria-label={effectiveLabel}
      onClick={() => void handleCopy()}
    >
      {copied ? <CheckIcon /> : <CopyIcon />}
    </button>
  );
}

async function copyText(value: string): Promise<void> {
  if (!value) throw new Error('copy failed');
  if (copyTextWithSelection(value)) return;

  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(value);
    return;
  }

  throw new Error('copy failed');
}

function copyTextWithSelection(value: string): boolean {
  if (typeof document === 'undefined') return false;
  const selection = window.getSelection?.();
  const previousRanges: Range[] = [];
  if (selection) {
    for (let index = 0; index < selection.rangeCount; index += 1) {
      previousRanges.push(selection.getRangeAt(index).cloneRange());
    }
  }

  const textarea = document.createElement('textarea');
  textarea.value = value;
  textarea.setAttribute('readonly', '');
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  document.body.appendChild(textarea);
  textarea.select();
  let copied = false;
  try {
    copied = document.execCommand?.('copy') ?? false;
  } catch {
    copied = false;
  } finally {
    document.body.removeChild(textarea);
    if (selection) {
      selection.removeAllRanges();
      previousRanges.forEach((range) => selection.addRange(range));
    }
  }
  return copied;
}

function CopyIcon(): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <rect x="9" y="9" width="10" height="10" rx="2" />
      <path d="M5 15V7a2 2 0 0 1 2-2h8" />
    </svg>
  );
}

function CheckIcon(): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M20 6L9 17l-5-5" />
    </svg>
  );
}
