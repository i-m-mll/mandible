export function acceptanceScratchPath(cache: string, recordId: string): string;
export function reclaimAcceptanceScratch(cache: string, recordId: string, home: string): Promise<string | null>;
export function requireIdleAcceptanceWorkspace(cache: string): void;
