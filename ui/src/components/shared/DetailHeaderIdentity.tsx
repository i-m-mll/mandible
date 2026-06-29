import type { ComponentChildren } from 'preact';
import { useState } from 'preact/hooks';

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
      {contextLabel && <span className={contextClassName}>{contextLabel}</span>}
      <code className={shortIdClassName}>{shortId}</code>
      <CopyRefButton value={copyValue} label={copyLabel ?? `Copy ${copyValue}`} />
      {children}
    </div>
  );
}

function CopyRefButton({ value, label }: { value: string; label: string }): JSX.Element {
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
      title={copied ? 'Copied' : label}
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
