import { createContext, type ComponentChildren } from 'preact';
import { useContext, useEffect } from 'preact/hooks';

export type AppRightSidebarDescriptor = {
  id: string;
  title: string;
  ariaLabel: string;
  open: boolean;
  width: number;
  minWidth?: number;
  maxWidth?: number;
  onOpenChange(open: boolean): void;
  onWidthChange(width: number): void;
  content: JSX.Element | null;
};

export type AppShellContextValue = {
  rightSidebar: AppRightSidebarDescriptor | null;
  registerRightSidebar(descriptor: AppRightSidebarDescriptor): () => void;
};

const noopContext: AppShellContextValue = {
  rightSidebar: null,
  registerRightSidebar: () => () => undefined,
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

export function useRegisterAppRightSidebar(
  descriptor: AppRightSidebarDescriptor | null,
): void {
  const { registerRightSidebar } = useAppShell();

  useEffect(() => {
    if (!descriptor) {
      return undefined;
    }
    return registerRightSidebar(descriptor);
  }, [descriptor, registerRightSidebar]);
}

export function RightSidebarIcon({ open, size = 18 }: { open: boolean; size?: number }): JSX.Element {
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
      <path d="M15 4v16" />
      {open ? <path d="M17.5 8.5h1.5M17.5 12h1.5M17.5 15.5h1.5" /> : null}
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
