import { useAppHistory } from '../../ui/src/hooks/useAppHistory';
import { useCallback, useMemo, useRef, useState } from 'preact/hooks';
import { AppShellProvider } from '../../ui/src/app-shell';
import { AuthQueueView, type AuthRequest } from '../../ui/src/views/auth';
import { entityRouteKey, rememberEntityRoute } from '../../ui/src/query/entityRoute';
import { queryClient } from '../../ui/src/query/client';
import { routeFromUrl, shortRouteId } from '../../ui/src/routing';
import { authBreakdownFixture } from './auth-breakdown-fixture';

export const navigationRequestId = 'file-navigation-request';
const report = authBreakdownFixture(40);
report.files.forEach((file, index) => { if (index % 2) file.language = 'JavaScript'; });
export const navigationRequest: AuthRequest = {
  id: navigationRequestId, type: 'merge', title: 'Review file navigation', status: 'pending', repo: 'mandible',
  head_branch: 'feature/navigation', base_branch: 'main', created_at: 1, updated_at: 1,
  commit_message: `Review the changed files.\n\n${'Description context.\n\n'.repeat(15)}`,
  diff_summary: '', spec_content: '', output: '', change_report: report,
  actions: [{ id: 'navigation-action', auth_request_id: navigationRequestId, ordinal: 0, kind: 'comment_add', state: 'staged',
    target_issue_ref: 'review-reference', target_digest: null, payload: { body: 'Review action details' }, staged_at: 1,
    updated_at: 1, applied_at: null, outcome_detail: 'Expanded review action details' }],
  issue_references: ['review-reference'],
};

export function RoutedAuthReview({ requests = [navigationRequest], history = [], active = true, sidebarHidden = true, instance, onRefresh, onApprove }: {
  requests?: AuthRequest[]; history?: AuthRequest[]; active?: boolean; sidebarHidden?: boolean;
  instance?: import('../../src/types').InstanceInfo;
  onRefresh?: (signal: AbortSignal) => Promise<void>;
  onApprove?: (id: string, proof?: import('../../ui/src/api').ShownAuthApproval) => void | Promise<void>;
}) {
  // Stands in for the resolver: every request the fixture serves opens by its entity path.
  useMemo(() => {
    for (const request of [...requests, ...history]) {
      const ref = shortRouteId(request.id);
      if (!queryClient.getQueryData(entityRouteKey('auth', ref))) rememberEntityRoute('auth', ref, { id: request.id });
    }
  }, [requests, history]);
  const navigation = useAppHistory();
  const route = routeFromUrl(new URL(navigation.href));
  const authRoute = useRef(route);
  if (route.tab === 'auth') authRoute.current = route;
  const [noticeHost, setNoticeHost] = useState<HTMLElement | null>(null);
  const registerMainNoticeHost = useCallback((host: HTMLElement) => {
    setNoticeHost(host);
    return () => setNoticeHost(current => current === host ? null : current);
  }, []);
  return <AppShellProvider value={{ active: true, noticeHost, registerMainNoticeHost, rightSidebar: null, registerRightSidebar: () => () => undefined,
    registerInitialRouteLoad: () => undefined, updateRightSidebar: () => undefined }}>
    <AuthQueueView queue={requests} historyQueue={history} instance={instance} onRefreshAuthProjection={onRefresh} outputs={{}} entityRef={authRoute.current.entity?.ref ?? null}
      reviewRouteParams={authRoute.current.params} reviewRouteActive={active} sidebarHidden={sidebarHidden}
      onApprove={onApprove ?? (() => undefined)} onReject={() => undefined} onRetry={() => undefined} />
  </AppShellProvider>;
}
