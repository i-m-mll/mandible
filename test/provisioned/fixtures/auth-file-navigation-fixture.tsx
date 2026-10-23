import { render } from 'preact';
import { RoutedAuthReview, navigationRequestId } from '../../helpers/auth-navigation-fixture';

window.fetch = () => Promise.reject(new Error('Offline review fixture'));
if (!window.location.hash) {
  window.localStorage.clear();
  window.history.replaceState({ fixtureState: 'preserved' }, '', `#/auth?request=${navigationRequestId}&sidebar=hidden&agent_session=fixture-agent`);
}
render(<RoutedAuthReview />, document.getElementById('root')!);
