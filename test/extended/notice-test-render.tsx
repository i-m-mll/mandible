import { render as testingRender } from '@testing-library/preact';
import type { ComponentChildren } from 'preact';
import { useState } from 'preact/hooks';
import { AppShellProvider } from '../../ui/src/app-shell';

function NoticeHarness({ children }: { children: ComponentChildren }): JSX.Element {
  const [noticeHost, setNoticeHost] = useState<HTMLElement | null>(null);
  return <AppShellProvider value={{
    active: true,
    noticeHost,
    rightSidebar: null,
    registerRightSidebar: () => () => undefined,
    registerInitialRouteLoad: () => undefined,
    updateRightSidebar: () => undefined,
  }}>
    <div id="app-operational-notices" ref={setNoticeHost} />
    {children}
  </AppShellProvider>;
}

/** Isolated view tests still provide the same app-owned notice outlet. */
export const render: typeof testingRender = (view, options) => {
  const wrap = (content: typeof view) => <NoticeHarness>{content}</NoticeHarness>;
  const result = testingRender(wrap(view), options);
  return { ...result, rerender: (next) => result.rerender(wrap(next)) };
};
