import { describe, expect, it } from 'vitest';

import {
  CHAT_DETAIL_PREVIEW_MIN_WIDTH,
  CHAT_MAIN_MIN_WIDTH,
  appRightSidebarAvailableWidths,
  resolveAppRightSidebarLayout,
} from '../ui/src/app-shell';

const chatSidebar = {
  width: 420,
  minWidth: CHAT_DETAIL_PREVIEW_MIN_WIDTH,
  maxWidth: 720,
  mainMinWidth: CHAT_MAIN_MIN_WIDTH,
};

describe('app right-sidebar layout', () => {
  it('docks only when both calibrated Chat and preview widths fit', () => {
    expect(resolveAppRightSidebarLayout(chatSidebar, 1072)).toEqual({
      presentation: 'dock',
      effectiveWidth: 420,
      minWidth: 360,
      maxWidth: 512,
    });
    expect(resolveAppRightSidebarLayout(chatSidebar, 900, 1072)).toEqual({
      presentation: 'overlay-drawer',
      effectiveWidth: 420,
      minWidth: 360,
      maxWidth: 720,
    });
  });

  it('clamps only effective geometry and keeps a usable drawer on narrower content', () => {
    expect(resolveAppRightSidebarLayout({ ...chatSidebar, width: 700 }, 1200)).toMatchObject({
      presentation: 'dock',
      effectiveWidth: 640,
    });
    expect(resolveAppRightSidebarLayout(chatSidebar, 500, 320)).toEqual({
      presentation: 'overlay-drawer',
      effectiveWidth: 320,
      minWidth: 320,
      maxWidth: 320,
    });
    expect(chatSidebar.width).toBe(420);
  });

  it('derives stable available widths from physical edges, independent of dock history', () => {
    const layout = { left: 0, right: 1280 } as DOMRect;
    const viewSidebar = { left: 208, right: 528 } as DOMRect;
    const beforeDock = appRightSidebarAvailableWidths(
      layout,
      { left: 208, right: 1280 } as DOMRect,
      viewSidebar,
      8,
    );
    const afterDock = appRightSidebarAvailableWidths(
      layout,
      { left: 208, right: 860 } as DOMRect,
      viewSidebar,
      8,
    );
    expect(beforeDock).toEqual({ mainAndSidebarWidth: 744, drawerWidth: 1072 });
    expect(afterDock).toEqual(beforeDock);
  });
});
