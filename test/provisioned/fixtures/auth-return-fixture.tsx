import { render } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { approveAuthRequest, bindOperationCatalog, getAuthRequestDetail } from '../../../ui/src/api';
import type { AuthRequest } from '../../../ui/src/views/auth';
import type { InstanceInfo } from '../../../src/types';
import { RoutedAuthReview } from '../../helpers/auth-navigation-fixture';
import { AppHoverTips } from '../../../ui/src/components/shared/AppHoverTips';

const requestId = location.pathname.split('/').at(-1)!;
const fixture = new URLSearchParams(location.search);
document.documentElement.dataset.theme = fixture.get('theme') === 'light' ? 'light' : 'dark';

function PrivateReview() {
  const [instance, setInstance] = useState<InstanceInfo>();
  const [request, setRequest] = useState<AuthRequest>();
  const [error, setError] = useState<string>();
  const acceptanceDelay = Number(fixture.get('acceptance'));
  const [acceptancePassed, setAcceptancePassed] = useState(false);
  useEffect(() => {
    if (!request || acceptanceDelay <= 0) return;
    const timer = window.setTimeout(() => setAcceptancePassed(true), acceptanceDelay);
    return () => clearTimeout(timer);
  }, [Boolean(request), acceptanceDelay]);
  const refresh = async () => {
    const detail = await getAuthRequestDetail(requestId);
    if (!detail) throw new Error('The fixture request is unavailable.');
    setRequest(detail as AuthRequest);
  };
  useEffect(() => {
    void (async () => {
      const info = await fetch('/api/instance').then(response => response.json());
      if (!bindOperationCatalog(info.instance, info.operations)) throw new Error('Invalid fixture operation catalog.');
      setInstance(info.instance);
      await refresh();
    })().catch((failure: Error) => setError(failure.message));
  }, []);
  if (error) return <p role="alert">{error}</p>;
  if (!request || !instance) return null;
  const projected = acceptanceDelay > 0 ? {
    ...request,
    candidate_acceptance: {
      state: acceptancePassed ? 'passed' as const : 'running' as const,
      reason: null, started_at: 1, finished_at: acceptancePassed ? 2 : null, warnings: [], phases: [],
    },
  } : request;
  const returned = request.status === 'returned';
  return <>
    <RoutedAuthReview requests={returned ? [] : [projected]} history={returned ? [projected] : []}
      sidebarHidden={fixture.get('sidebar') !== 'visible'} instance={instance} onRefresh={refresh} onApprove={async (id, proof) => {
        await approveAuthRequest(id, proof?.revision ?? request.lifecycle_revision ?? null, proof?.review);
        await refresh();
      }} />
    <AppHoverTips />
  </>;
}

render(<PrivateReview />, document.getElementById('root')!);
