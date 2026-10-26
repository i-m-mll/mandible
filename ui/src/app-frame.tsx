import type { ComponentChildren, Ref } from 'preact';
import { AppRightSidebarHeaderControls, AppRightSidebarToggleButton, ViewSidebarIcon, type AppRightSidebarDescriptor } from './app-shell';
import './styles/app-frame.css';

export function AppFrame({ nativeControlsReservation, rail, layoutClassName = '', children, headerHostRef, hasMainHeader, viewSidebarOpen, viewSidebarAvailable, onViewSidebarToggle, rightSidebar, rightSidebarOpen, onRightSidebarOpenChange, rightToggleRef }: {
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
  return <div className={`app-frame${hasMainHeader ? ' app-frame--main-header' : ''}${viewSidebarOpen ? ' app-frame--left-open' : ''}${rightSidebarOpen ? ' app-frame--right-open' : ''}`}>
    <header className="app-frame__bar" aria-label="Application controls" data-app-surface="chrome" data-tauri-drag-region>
      <div className="app-frame__navigation" data-tauri-drag-region>
        {nativeControlsReservation > 0 ? <span className="app-frame__native-controls" aria-hidden="true" data-tauri-drag-region /> : null}
        <span className="app-frame__logo" aria-hidden="true" data-tauri-drag-region><span className="app-header__logo" style={{ '--app-header-logo-image': 'url("/header-logo.svg")' } as JSX.CSSProperties} /></span>
        <button type="button" className="app-frame__button" aria-label="Back" title="Back" onClick={() => window.history.back()}><HistoryArrow /></button>
        <button type="button" className="app-frame__button" aria-label="Forward" title="Forward" onClick={() => window.history.forward()}><HistoryArrow forward /></button>
        {viewSidebarAvailable ? <button type="button" className="app-frame__button" aria-label={leftLabel} title={leftLabel} aria-pressed={viewSidebarOpen} onClick={onViewSidebarToggle}><ViewSidebarIcon open={viewSidebarOpen} /></button> : null}
      </div>
      <div className="app-frame__main-header" ref={headerHostRef} data-tauri-drag-region />
      {rightSidebar ? <div className="app-frame__right" data-tauri-drag-region>
        {rightSidebarOpen ? <AppRightSidebarHeaderControls descriptor={rightSidebar} /> : null}
        <AppRightSidebarToggleButton descriptor={rightSidebar} buttonRef={rightToggleRef} open={rightSidebarOpen} onOpenChange={onRightSidebarOpenChange} />
      </div> : null}
    </header>
    {rail}
    <div className={`app-layout ${layoutClassName}`}>{children}</div>
  </div>;
}

function HistoryArrow({ forward = false }: { forward?: boolean }): JSX.Element {
  return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={forward ? 'm9 5 7 7-7 7' : 'm15 5-7 7 7 7'} /></svg>;
}
