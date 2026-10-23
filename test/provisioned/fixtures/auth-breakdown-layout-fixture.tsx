import { render } from 'preact';
import { AuthChangeBreakdown } from '../../../ui/src/views/AuthChangeBreakdown';
import { authBreakdownFixture } from '../../helpers/auth-breakdown-fixture';

const report = authBreakdownFixture();
report.files.forEach((file, index) => { if (index % 2) file.language = 'JavaScript'; });
const requestId = `browser-breakdown-${window.innerWidth}`;
render(
  <section className="auth-detail-pane">
    <main className="auth-detail__body" id="outer-review">
      <AuthChangeBreakdown requestId={requestId} report={report} />
      <div className="additional-context">Additional request context</div>
    </main>
  </section>,
  document.getElementById('root')!,
);
