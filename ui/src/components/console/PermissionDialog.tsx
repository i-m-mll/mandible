import type { JSX } from 'preact/jsx-runtime';
import { useEffect, useMemo, useState } from 'preact/hooks';
import type {
  ConsolePermissionDecision,
  ConsolePermissionRequest,
} from '../../api';

type PermissionDialogProps = {
  request: ConsolePermissionRequest | null;
  onRespond: (id: string, decision: ConsolePermissionDecision) => void;
};

function formatToolInput(input: unknown): string {
  if (typeof input === 'string') {
    return input;
  }
  try {
    return JSON.stringify(input, null, 2);
  } catch {
    return String(input ?? '');
  }
}

export function PermissionDialog({
  request,
  onRespond,
}: PermissionDialogProps): JSX.Element | null {
  const [expanded, setExpanded] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    setExpanded(false);
  }, [request?.id]);

  useEffect(() => {
    if (!request) {
      return undefined;
    }
    const interval = window.setInterval(() => {
      setNow(Date.now());
    }, 1000);
    return () => window.clearInterval(interval);
  }, [request]);

  useEffect(() => {
    if (!request) {
      return undefined;
    }
    const optionDecisions = (request.options ?? []).map((option) => option.decision ?? `option:${option.key}`);
    const onKeyDown = (event: KeyboardEvent) => {
      const option = request.options?.find((item) => item.key === event.key);
      if (option) {
        event.preventDefault();
        onRespond(request.id, option.decision ?? `option:${option.key}`);
        return;
      }
      if (optionDecisions.length > 0) {
        return;
      }
      if (event.shiftKey && event.key === 'A') {
        event.preventDefault();
        onRespond(request.id, 'allow_always');
        return;
      }
      if (event.key === 'Enter' || event.key.toLowerCase() === 'a') {
        event.preventDefault();
        onRespond(request.id, 'allow');
        return;
      }
      if (event.key === 'Escape' || event.key.toLowerCase() === 'd') {
        event.preventDefault();
        onRespond(request.id, 'deny');
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onRespond, request]);

  const formattedInput = useMemo(() => {
    if (!request) {
      return '';
    }
    return formatToolInput(request.tool_input);
  }, [request]);

  if (!request) {
    return null;
  }

  const remainingSeconds = Math.max(
    0,
    Math.ceil((request.expires_at - now) / 1000),
  );
  const preview = formattedInput.length > 500
    ? `${formattedInput.slice(0, 500)}…`
    : formattedInput;
  const toolName = request.display_name || request.tool_name;

  return (
    <div className="permission-dialog-overlay">
      <div className="permission-dialog" role="dialog" aria-modal="true" aria-labelledby="permission-dialog-title">
        <div className="permission-dialog__header">
          <div>
            <div className="permission-dialog__eyebrow">Permission required</div>
            <h3 id="permission-dialog-title">{request.title || toolName}</h3>
          </div>
          <div className="permission-dialog__countdown">
            {remainingSeconds}s
          </div>
        </div>

        <div className="permission-dialog__meta">
          <span className="permission-dialog__chip">{toolName}</span>
          {request.agent_id && (
            <span className="permission-dialog__chip">Agent {request.agent_id}</span>
          )}
          {request.blocked_path && (
            <span className="permission-dialog__chip">{request.blocked_path}</span>
          )}
        </div>

        {request.description && (
          <p className="permission-dialog__description">{request.description}</p>
        )}
        {request.decision_reason && (
          <p className="permission-dialog__reason">{request.decision_reason}</p>
        )}

        <div className="permission-dialog__section">
          <div className="permission-dialog__section-title">Tool input</div>
          <pre className="permission-dialog__input">
            {expanded ? formattedInput : preview}
          </pre>
          {formattedInput.length > 500 && (
            <button
              type="button"
              className="permission-dialog__toggle"
              onClick={() => setExpanded((value) => !value)}
            >
              {expanded ? 'Show less' : 'Expand'}
            </button>
          )}
        </div>

        {request.options && request.options.length > 0 ? (
          <div className="permission-dialog__actions">
            {request.options.map((option) => (
              <button
                key={option.key}
                type="button"
                className="permission-dialog__button permission-dialog__button--allow"
                onClick={() => onRespond(request.id, option.decision ?? `option:${option.key}`)}
              >
                {option.key}. {option.label}
              </button>
            ))}
          </div>
        ) : (
          <div className="permission-dialog__actions">
            <button
              type="button"
              className="permission-dialog__button permission-dialog__button--deny"
              onClick={() => onRespond(request.id, 'deny')}
            >
              Deny
            </button>
            <button
              type="button"
              className="permission-dialog__button permission-dialog__button--allow"
              onClick={() => onRespond(request.id, 'allow')}
            >
              Allow
            </button>
            <button
              type="button"
              className="permission-dialog__button permission-dialog__button--always"
              onClick={() => onRespond(request.id, 'allow_always')}
            >
              Always Allow
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
