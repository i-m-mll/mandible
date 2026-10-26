export function previewBaseDir(override?: string | null): string;
export function previewPaths(branch: string): { root: string; metadata: string };
export function withPreviewLifecycle<T>(branch: string, operation: () => Promise<T>): Promise<T>;
export function previewWorktreeCustodyReason(branch: string, worktree: string | null): Promise<string | null>;
