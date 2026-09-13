import { describe, expect, it } from 'vitest';

import {
  CHAT_DETAIL_PREVIEW_MIN_WIDTH,
  RIGHT_SIDEBAR_AUTO_COLLAPSE_WIDTH,
  VIEW_SIDEBAR_AUTO_COLLAPSE_WIDTH,
  WIDE_RESPONSIVE_SIDEBAR_STATE,
  responsiveSidebarThresholdTransition,
  resolveAppRightSidebarLayout,
} from '../ui/src/app-shell';

const chatSidebar = {
  width: 420,
  minWidth: CHAT_DETAIL_PREVIEW_MIN_WIDTH,
  maxWidth: 720,
};

describe('app right-sidebar layout', () => {
  it('always uses the ordinary docked grid without a main-width constraint', () => {
    expect(resolveAppRightSidebarLayout(chatSidebar, 1280)).toEqual({
      presentation: 'dock',
      effectiveWidth: 420,
      minWidth: 360,
      maxWidth: 720,
    });
    expect(resolveAppRightSidebarLayout(chatSidebar, 600)).toEqual({
      presentation: 'dock',
      effectiveWidth: 360,
      minWidth: 360,
      maxWidth: 360,
    });
    expect(chatSidebar.width).toBe(420);
  });

  it('closes the right sidebar once on threshold entry', () => {
    const entered = responsiveSidebarThresholdTransition(
      WIDE_RESPONSIVE_SIDEBAR_STATE,
      RIGHT_SIDEBAR_AUTO_COLLAPSE_WIDTH - 1,
    );
    expect(entered).toMatchObject({ closeRight: true, closeView: false });
    expect(responsiveSidebarThresholdTransition(entered.state, RIGHT_SIDEBAR_AUTO_COLLAPSE_WIDTH - 50))
      .toMatchObject({ closeRight: false, closeView: false });
    expect(responsiveSidebarThresholdTransition(WIDE_RESPONSIVE_SIDEBAR_STATE, 962))
      .toMatchObject({ closeRight: true, closeView: false });
  });

  it('defers threshold consumption until the active sidebar owner is available', () => {
    const pending = responsiveSidebarThresholdTransition(
      WIDE_RESPONSIVE_SIDEBAR_STATE,
      RIGHT_SIDEBAR_AUTO_COLLAPSE_WIDTH - 1,
      { right: false, view: false },
    );
    expect(pending).toMatchObject({
      state: WIDE_RESPONSIVE_SIDEBAR_STATE,
      closeRight: false,
      closeView: false,
    });
    expect(responsiveSidebarThresholdTransition(
      pending.state,
      RIGHT_SIDEBAR_AUTO_COLLAPSE_WIDTH - 1,
      { right: true, view: false },
    )).toMatchObject({ closeRight: true, closeView: false });
  });

  it('respects manual reopening until exit re-arms the threshold', () => {
    const entered = responsiveSidebarThresholdTransition(
      WIDE_RESPONSIVE_SIDEBAR_STATE,
      RIGHT_SIDEBAR_AUTO_COLLAPSE_WIDTH - 1,
    );
    const afterManualReopen = responsiveSidebarThresholdTransition(
      entered.state,
      RIGHT_SIDEBAR_AUTO_COLLAPSE_WIDTH - 20,
    );
    expect(afterManualReopen.closeRight).toBe(false);
    const exited = responsiveSidebarThresholdTransition(
      afterManualReopen.state,
      RIGHT_SIDEBAR_AUTO_COLLAPSE_WIDTH,
    );
    expect(exited.closeRight).toBe(false);
    expect(responsiveSidebarThresholdTransition(exited.state, RIGHT_SIDEBAR_AUTO_COLLAPSE_WIDTH - 1).closeRight)
      .toBe(true);
  });

  it('collapses both sidebars together on first entry below the narrower threshold', () => {
    expect(responsiveSidebarThresholdTransition(
      WIDE_RESPONSIVE_SIDEBAR_STATE,
      VIEW_SIDEBAR_AUTO_COLLAPSE_WIDTH - 1,
    )).toMatchObject({ closeRight: true, closeView: true });
  });
});
