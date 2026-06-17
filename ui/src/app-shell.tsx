import { createContext, type ComponentChildren } from 'preact';
import { useContext, useEffect } from 'preact/hooks';

export type AppBottomPanelDescriptor = {
  id: string;
  title: string;
  ariaLabel: string;
  open: boolean;
  height: number;
  minHeight?: number;
  maxHeight?: number;
  onOpenChange(open: boolean): void;
  onHeightChange(height: number): void;
  content: JSX.Element | null;
};

export type AppShellContextValue = {
  bottomPanel: AppBottomPanelDescriptor | null;
  registerBottomPanel(descriptor: AppBottomPanelDescriptor): () => void;
};

const noopContext: AppShellContextValue = {
  bottomPanel: null,
  registerBottomPanel: () => () => undefined,
};

const AppShellContext = createContext<AppShellContextValue>(noopContext);

export function AppShellProvider({
  value,
  children,
}: {
  value: AppShellContextValue;
  children: ComponentChildren;
}): JSX.Element {
  return (
    <AppShellContext.Provider value={value}>
      {children}
    </AppShellContext.Provider>
  );
}

export function useAppShell(): AppShellContextValue {
  return useContext(AppShellContext);
}

export function useRegisterAppBottomPanel(
  descriptor: AppBottomPanelDescriptor | null,
): void {
  const { registerBottomPanel } = useAppShell();

  useEffect(() => {
    if (!descriptor) {
      return undefined;
    }
    return registerBottomPanel(descriptor);
  }, [descriptor, registerBottomPanel]);
}

export function BottomPanelIcon({ open, size = 18 }: { open: boolean; size?: number }): JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M3 15h18" />
      {open ? <path d="M8.5 17.5h7M10.5 12h3" /> : null}
    </svg>
  );
}

export function ViewSidebarIcon({ open, size = 18 }: { open: boolean; size?: number }): JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <rect x="3" y="4" width="18" height="16" rx="2" />
      {open ? <path d="M9 4v16" /> : null}
      <path d={open ? 'M12 12h5' : 'M8 12h8'} />
      <path d={open ? 'm14.5 9.5 2.5 2.5-2.5 2.5' : 'm10.5 9.5-2.5 2.5 2.5 2.5'} />
    </svg>
  );
}
