export function acceptedReleaseHome(root: string): string;
export function releaseRunSchema(storage: string): string;
export function retireAcceptedReleaseRunLock(root: string): Promise<boolean>;
export function withAcceptedReleaseRunLock<T>(root: string, operation: (token: string, assertHeld: () => void) => T | Promise<T>, options?: {
  mode?: 'create' | 'existing' | 'recover';
  recoverStale?: boolean;
  onUnavailable?: (state: 'occupied' | 'completed' | 'absent', reason: string) => T | Promise<T>;
}): Promise<T>;
