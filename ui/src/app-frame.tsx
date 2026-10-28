import { Icon } from './components/icons/Icon';
import { appTip } from './components/shared/AppHoverTips';
import type { AppHistoryNavigation } from './app-history';
import type { ComponentChildren, Ref } from 'preact';
import { chromeAppearanceFrameStyles, type ChromeAppearanceThemes } from './chrome-appearance';

import { APP_FRAME_CONTROLS_OFFSET, AppRightSidebarHeaderControls, AppRightSidebarToggleButton, ViewSidebarIcon, type AppRightSidebarDescriptor } from './app-shell';
import './styles/app-frame.css';

const HISTORY_ARROW_SIZE = 18;

export function AppFrame({ navigation, chromeAppearance, nativeControlsReservation, rail, layoutClassName = '', children, headerHostRef, hasMainHeader, viewSidebarOpen, viewSidebarAvailable, onViewSidebarToggle, rightSidebar, rightSidebarOpen, onRightSidebarOpenChange, rightToggleRef }: {
  navigation: AppHistoryNavigation;
  chromeAppearance?: Readonly<ChromeAppearanceThemes>;
  nativeControlsReservation: number;
  rail: ComponentChildren;
  layoutClassName?: string;
  children: ComponentChildren;
  headerHostRef: Ref<HTMLDivElement>;
  hasMainHeader: boolean;
  viewSidebarOpen: boolean;
  viewSidebarAvailable: boolean;
  onViewSidebarToggle(): void;
  rightSidebar: AppRightSidebarDescriptor | null;
  rightSidebarOpen: boolean;
  onRightSidebarOpenChange(open: boolean): void;
  rightToggleRef?: Ref<HTMLButtonElement>;
}): JSX.Element {
  const leftLabel = viewSidebarOpen ? 'Hide view sidebar' : 'Show view sidebar';
  return <div style={{ ...chromeAppearanceFrameStyles(chromeAppearance), '--app-frame-controls-offset': `${APP_FRAME_CONTROLS_OFFSET}px`, '--app-frame-history-icon-size': `${HISTORY_ARROW_SIZE}px` } as JSX.CSSProperties} className={`app-frame${hasMainHeader ? ' app-frame--main-header' : ''}${viewSidebarOpen ? ' app-frame--left-open' : ''}${rightSidebarOpen ? ' app-frame--right-open' : ''}`}>
    <header className="app-frame__bar" aria-label="Application controls" data-app-surface="chrome" data-native-drag-boundary>
      <div className="app-frame__navigation">
        {nativeControlsReservation > 0 ? <span className="app-frame__native-controls" aria-hidden="true" /> : null}
        <span className="app-frame__logo" aria-hidden="true"><span className="app-header__logo" style={{ '--app-header-logo-image': 'url("/header-logo.svg")' } as JSX.CSSProperties} /></span>
        <button type="button" className="app-frame__button app-frame__history-button" aria-label="Back" {...appTip("Back")} disabled={!navigation.canBack} onClick={navigation.back}><Icon name="historyBack" size={HISTORY_ARROW_SIZE} /></button>
        <button type="button" className="app-frame__button app-frame__history-button" aria-label="Forward" {...appTip("Forward")} disabled={!navigation.canForward} onClick={navigation.forward}><Icon name="historyForward" size={HISTORY_ARROW_SIZE} /></button>
        {viewSidebarAvailable ? <button type="button" className="app-frame__button" aria-label={leftLabel} {...appTip(leftLabel)} aria-pressed={viewSidebarOpen} onClick={onViewSidebarToggle}><ViewSidebarIcon open={viewSidebarOpen} /></button> : null}
      </div>
      <div className="app-frame__main-header" ref={headerHostRef} />
      {rightSidebar ? <div className="app-frame__right">
        {rightSidebarOpen ? <AppRightSidebarHeaderControls descriptor={rightSidebar} /> : null}
        <AppRightSidebarToggleButton descriptor={rightSidebar} buttonRef={rightToggleRef} open={rightSidebarOpen} onOpenChange={onRightSidebarOpenChange} />
      </div> : null}
    </header>
    {rail}
    <div className={`app-layout ${layoutClassName}`}>{children}</div>
  </div>;
}
