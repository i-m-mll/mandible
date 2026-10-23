import { render } from 'preact';
import { AuthChangeBreakdown } from '../../../ui/src/views/AuthChangeBreakdown';
import { authBreakdownFixture } from '../../helpers/auth-breakdown-fixture';

const requestId = `browser-breakdown-${window.innerWidth}`;
render(
  <section className="auth-detail-pane">
    <main className="auth-detail__body" id="outer-review">
      <AuthChangeBreakdown requestId={requestId} report={authBreakdownFixture()} />
      <div className="additional-context">Additional request context</div>
    </main>
  </section>,
  document.getElementById('root')!,
);
