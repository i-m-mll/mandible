export interface AcceptanceResultBinding {
  recordId: string; requestId: string; projectId: string; workUnitId: string;
  pin_sha: string; tree_sha: string; base_sha: string; head_sha: string;
  started_at: number; deadline: number;
}
export function acceptanceResultPath(cache: string, runId: string): string;
export function readAcceptanceFailure(cache: string, binding: AcceptanceResultBinding): { result: Record<string, unknown> | null; error: string | null };
