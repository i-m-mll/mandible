import { render } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { bindOperationCatalog, getAuthRequestDetail } from '../../../ui/src/api';
import type { AuthRequest } from '../../../ui/src/views/auth';
import type { InstanceInfo } from '../../../src/types';
import { RoutedAuthReview } from '../../helpers/auth-navigation-fixture';

const requestId = location.pathname.split('/').at(-1)!;

function PrivateReview() {
  const [instance, setInstance] = useState<InstanceInfo>();
  const [request, setRequest] = useState<AuthRequest>();
  const [error, setError] = useState<string>();
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
  const returned = request.status === 'returned';
  return <RoutedAuthReview requests={returned ? [] : [request]} history={returned ? [request] : []}
    instance={instance} onRefresh={refresh} />;
}

render(<PrivateReview />, document.getElementById('root')!);
