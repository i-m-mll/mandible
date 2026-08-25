// Bug: 11f4f47 — PTY deprecation banner for rich view
import type { JSX } from 'preact/jsx-runtime';

export function PtyBanner(): JSX.Element {
  return (
    <div className="pty-banner">
      PTY sessions have limited integration with Mandible. For full features
      (permissions, cost tracking, conversation history), use an SDK
      agent session instead.
    </div>
  );
}
