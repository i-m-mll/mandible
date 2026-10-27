import { useAppHistory } from '../../ui/src/hooks/useAppHistory';
import { useCallback, useRef, useState } from 'preact/hooks';
import { AppShellProvider } from '../../ui/src/app-shell';
import { AuthQueueView, type AuthRequest } from '../../ui/src/views/auth';
import { parseRouteFromHash } from '../../ui/src/routing';
import { authBreakdownFixture } from './auth-breakdown-fixture';

export const navigationRequestId = 'file-navigation-request';
const report = authBreakdownFixture(40);
report.files.forEach((file, index) => { if (index % 2) file.language = 'JavaScript'; });
export const navigationDiff = report.files.map(file => {
  const old = file.old_path ?? file.new_path!;
  const next = file.new_path ?? file.old_path!;
  const metadata = file.old_path === null ? 'new file mode 100644\n'
    : file.new_path === null ? 'deleted file mode 100644\n'
      : file.change_kind === 'renamed' ? `rename from ${old}\nrename to ${next}\n`
        : file.change_kind === 'copied' ? `copy from ${old}\ncopy to ${next}\n` : '';
  return `diff --git a/${old} b/${next}\n${metadata}--- ${file.old_path === null ? '/dev/null' : `a/${old}`}\n+++ ${file.new_path === null ? '/dev/null' : `b/${next}`}\n@@ -1 +1,40 @@\n-old\n${Array.from({ length: 40 }, (_, index) => `+line ${index}`).join('\n')}`;
}).join('\n');

export const navigationRequest: AuthRequest = {
  id: navigationRequestId, type: 'merge', title: 'Review file navigation', status: 'pending', repo: 'mandible',
  head_branch: 'feature/navigation', base_branch: 'main', created_at: 1, updated_at: 1,
  commit_message: `Review the changed files.\n\n${'Description context.\n\n'.repeat(15)}`,
  diff_summary: navigationDiff, spec_content: '', output: '', change_report: report,
  actions: [{ id: 'navigation-action', auth_request_id: navigationRequestId, ordinal: 0, kind: 'comment_add', state: 'staged',
    target_issue_ref: 'review-reference', target_digest: null, payload: { body: 'Review action details' }, staged_at: 1,
    updated_at: 1, applied_at: null, outcome_detail: 'Expanded review action details' }],
  issue_references: ['review-reference'],
};

export function RoutedAuthReview({ requests = [navigationRequest], active = true, sidebarHidden = true }: { requests?: AuthRequest[]; active?: boolean; sidebarHidden?: boolean }) {
  const navigation = useAppHistory();
  const route = parseRouteFromHash(new URL(navigation.href).hash);
  const authRoute = useRef(route);
  if (route.tab === 'auth') authRoute.current = route;
  const [noticeHost, setNoticeHost] = useState<HTMLElement | null>(null);
  const registerMainNoticeHost = useCallback((host: HTMLElement) => {
    setNoticeHost(host);
    return () => setNoticeHost(current => current === host ? null : current);
  }, []);
  return <AppShellProvider value={{ active: true, noticeHost, registerMainNoticeHost, rightSidebar: null, registerRightSidebar: () => () => undefined,
    registerInitialRouteLoad: () => undefined, updateRightSidebar: () => undefined }}>
    <AuthQueueView queue={requests} historyQueue={[]} outputs={{}} initialRequestId={authRoute.current.params.request}
      reviewRouteParams={authRoute.current.params} reviewRouteActive={active} sidebarHidden={sidebarHidden} onApprove={() => undefined} onReject={() => undefined} onRetry={() => undefined} />
  </AppShellProvider>;
}
