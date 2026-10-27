import { Icon } from '../icons/Icon';
import type { JSX } from 'preact/jsx-runtime';
import type {
  ConsoleBackendType,
  ConsolePermissionDecision,
  ConsolePermissionRequest,
} from '../../api';

export type PermissionAction = {
  key: string;
  label: string;
  decision: ConsolePermissionDecision;
  tone: 'allow' | 'deny' | 'always';
};

export function permissionMatchedText(request: ConsolePermissionRequest): string {
  if (request.blocked_path) {
    return request.blocked_path;
  }
  const input = request.tool_input;
  if (typeof input === 'string') {
    return input;
  }
  if (input && typeof input === 'object' && !Array.isArray(input)) {
    const record = input as Record<string, unknown>;
    for (const key of ['command', 'file_path', 'path', 'url', 'uri', 'query']) {
      const value = record[key];
      if (typeof value === 'string' && value.trim()) {
        return value;
      }
    }
  }
  try {
    return JSON.stringify(input, null, 2);
  } catch {
    return String(input ?? '');
  }
}

function actionTone(decision: ConsolePermissionDecision, label: string): PermissionAction['tone'] {
  const normalized = `${decision} ${label}`.toLowerCase();
  if (normalized.includes('always')) {
    return 'always';
  }
  if (normalized.includes('deny') || normalized.includes('reject')) {
    return 'deny';
  }
  return 'allow';
}

export function permissionActionsForRequest(
  request: ConsolePermissionRequest,
  backendType: ConsoleBackendType,
): PermissionAction[] {
  if (request.options && request.options.length > 0) {
    return request.options.map((option) => {
      const decision = option.decision ?? `option:${option.key}`;
      return {
        key: option.key,
        label: option.label,
        decision,
        tone: actionTone(decision, option.label),
      };
    });
  }

  const actions: PermissionAction[] = [
    { key: 'allow', label: 'Allow once', decision: 'allow', tone: 'allow' },
    { key: 'allow_always', label: 'Always allow', decision: 'allow_always', tone: 'always' },
    { key: 'deny', label: 'Deny', decision: backendType === 'acp' ? 'reject_once' : 'deny', tone: 'deny' },
  ];

  if (backendType === 'acp') {
    actions.push({
      key: 'reject_always',
      label: 'Always deny',
      decision: 'reject_always',
      tone: 'deny',
    });
  }

  return actions;
}

export function PermissionApprovalCard({
  request,
  backendType,
  onRespond,
  variant = 'inline',
}: {
  request: ConsolePermissionRequest;
  backendType: ConsoleBackendType;
  onRespond: (id: string, decision: ConsolePermissionDecision) => void | Promise<void>;
  variant?: 'inline' | 'sticky';
}): JSX.Element {
  const toolName = request.display_name || request.tool_name;
  const matched = permissionMatchedText(request);
  const actions = permissionActionsForRequest(request, backendType);

  return (
    <section className={`permission-card permission-card--${variant}`} aria-label="Permission request">
      <div className="permission-card__header">
        <span className="permission-card__icon" aria-hidden="true"><Icon name="permission" /></span>
        <div className="permission-card__titles">
          <div className="permission-card__eyebrow">Approval required</div>
          <div className="permission-card__title">{request.title || toolName}</div>
        </div>
        <span className="permission-card__tool">{toolName}</span>
      </div>
      {request.description && (
        <div className="permission-card__description">{request.description}</div>
      )}
      <div className="permission-card__matched" title={matched}>
        {matched}
      </div>
      {request.decision_reason && (
        <div className="permission-card__reason">{request.decision_reason}</div>
      )}
      <div className="permission-card__actions">
        {actions.map((action) => (
          <button
            key={action.key}
            type="button"
            className={`permission-card__button permission-card__button--${action.tone}`}
            onClick={() => { void onRespond(request.id, action.decision); }}
          >
            {action.label}
          </button>
        ))}
      </div>
    </section>
  );
}
