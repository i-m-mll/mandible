import { createContext, type ComponentChildren, type Ref } from 'preact';
import { createPortal } from 'preact/compat';
import { useContext, useLayoutEffect } from 'preact/hooks';
import { useAppShell } from '../../app-shell';

const FrameHeaderContext = createContext(false);
export function useIsFrameHeader(): boolean { return useContext(FrameHeaderContext); }

export function useFrameHeaderHost(enabled: boolean): HTMLElement | null {
  const { active, frameHeaderHost, registerFrameHeader } = useAppShell();
  const host = enabled ? frameHeaderHost ?? null : null;
  useLayoutEffect(() => host && active ? registerFrameHeader?.() : undefined, [host, active, registerFrameHeader]);
  return host;
}

export function FrameHeaderPortal({ host, headerRef, labelId, children }: {
  host: HTMLElement;
  headerRef?: Ref<HTMLDivElement>;
  labelId?: string;
  children: ComponentChildren;
}): JSX.Element {
  const { active } = useAppShell();
  return createPortal(<FrameHeaderContext.Provider value>
    <div className="app-frame__header-content" ref={headerRef} id={labelId} hidden={!active} inert={!active || undefined}>{children}</div>
  </FrameHeaderContext.Provider>, host);
}
