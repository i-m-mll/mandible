import { useLayoutEffect, useState } from 'preact/hooks';
import { getNativeWindowCapabilities, getWindowHost, listenNativeFrameChanges, startDesktopWindowDrag, type NativeWindowCapabilities } from './api';
import { installNativeTopBarDragging } from './native-top-bar';

type NativeWindowPresentation = Pick<NativeWindowCapabilities, 'trafficLightReservation' | 'liquidGlassRegular'>;

export function useNativeWindowPresentation(): NativeWindowPresentation {
  const [presentation, setPresentation] = useState<NativeWindowPresentation>({ trafficLightReservation: 0, liquidGlassRegular: false });
  useLayoutEffect(() => {
    const root = document.documentElement;
    const host = getWindowHost();
    const removeDragging = host.kind === 'tauri' ? installNativeTopBarDragging(document, startDesktopWindowDrag) : () => undefined;
    root.dataset.framePresentation = host.framePresentation;
    let disposed = false;
    let removeListener: (() => void) | undefined;
    let revision = 0;
    const refresh = () => {
      const request = ++revision;
      return getNativeWindowCapabilities().then(capabilities => {
        if (disposed || request !== revision) return;
        const { liquidGlassRegular, topBarHeight, trafficLightReservation } = capabilities;
        root.style.setProperty('--app-frame-header-height', `${topBarHeight}px`);
        root.style.setProperty('--app-native-controls-reservation', `${trafficLightReservation}px`);
        if (liquidGlassRegular) root.dataset.nativeGlass = 'regular';
        else root.removeAttribute('data-native-glass');
        setPresentation(current => current.trafficLightReservation === trafficLightReservation && current.liquidGlassRegular === liquidGlassRegular ? current : { trafficLightReservation, liquidGlassRegular });
      });
    };
    void refresh().catch(error => console.error('Failed to read native window capabilities:', error));
    void listenNativeFrameChanges(() => {
      void refresh().catch(error => console.error('Failed to refresh native window capabilities:', error));
    }).then(cleanup => {
      if (disposed) { cleanup(); return; }
      removeListener = cleanup;
      return refresh();
    }).catch(error => console.error('Failed to subscribe to native frame changes:', error));
    return () => {
      disposed = true;
      removeDragging();
      removeListener?.();
      const root = document.documentElement;
      root.removeAttribute('data-native-glass');
      root.removeAttribute('data-frame-presentation');
      root.style.removeProperty('--app-frame-header-height');
      root.style.removeProperty('--app-native-controls-reservation');
    };
  }, []);
  return presentation;
}
