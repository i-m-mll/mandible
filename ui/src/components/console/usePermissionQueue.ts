import { useEffect, useState } from 'preact/hooks';
import type { ConsolePermissionRequest } from '../../api';
import { getConsolePermissions, respondToConsolePermission } from '../../api';

export function usePermissionQueue({
  backendType,
  sessionId,
}: {
  backendType: string;
  sessionId: string;
}): {
  request: ConsolePermissionRequest | null;
  busy: boolean;
  handlePermissionResponse: (
    requestId: string,
    decision: 'deny' | 'allow' | 'allow_always' | 'reject_once' | 'reject_always',
  ) => Promise<void>;
} {
  const [permissionQueue, setPermissionQueue] = useState<ConsolePermissionRequest[]>([]);
  const [permissionBusy, setPermissionBusy] = useState(false);
  const supportsPermissions = backendType === 'sdk' || backendType === 'acp' || backendType === 'pty';

  useEffect(() => {
    if (!supportsPermissions) {
      setPermissionQueue([]);
      return;
    }

    let cancelled = false;
    getConsolePermissions(sessionId)
      .then((requests) => {
        if (!cancelled) {
          setPermissionQueue(requests);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setPermissionQueue([]);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [supportsPermissions, sessionId]);

  useEffect(() => {
    if (!supportsPermissions) {
      return undefined;
    }

    const handlePermissionRequest = (event: Event) => {
      const detail = (event as CustomEvent<{
        console_session_id: string;
        request: ConsolePermissionRequest;
      }>).detail;
      if (!detail || detail.console_session_id !== sessionId || !detail.request) {
        return;
      }
      setPermissionQueue((prev) => {
        if (prev.some((request) => request.id === detail.request.id)) {
          return prev;
        }
        return [...prev, detail.request];
      });
    };

    const handlePermissionCleared = (event: Event) => {
      const detail = (event as CustomEvent<{
        console_session_id: string;
        request_id: string;
      }>).detail;
      if (!detail || detail.console_session_id !== sessionId) {
        return;
      }
      setPermissionQueue((prev) => prev.filter((request) => request.id !== detail.request_id));
    };

    window.addEventListener('console:permission:request', handlePermissionRequest);
    window.addEventListener('console:permission:cleared', handlePermissionCleared);
    return () => {
      window.removeEventListener('console:permission:request', handlePermissionRequest);
      window.removeEventListener('console:permission:cleared', handlePermissionCleared);
    };
  }, [supportsPermissions, sessionId]);

  const handlePermissionResponse = async (
    requestId: string,
    decision: 'deny' | 'allow' | 'allow_always' | 'reject_once' | 'reject_always',
  ) => {
    setPermissionBusy(true);
    try {
      await respondToConsolePermission(sessionId, requestId, decision);
      setPermissionQueue((prev) => prev.filter((request) => request.id !== requestId));
    } finally {
      setPermissionBusy(false);
    }
  };

  return {
    request: supportsPermissions && !permissionBusy ? permissionQueue[0] ?? null : null,
    busy: permissionBusy,
    handlePermissionResponse,
  };
}
