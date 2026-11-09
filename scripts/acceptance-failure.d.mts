export type AcceptanceFault = 'candidate' | 'environment' | 'either';
export type AcceptanceStage = 'startup' | 'checkout' | 'package_build' | 'package_verification' | 'readiness'
  | 'desktop_interaction' | 'health_coverage' | 'finalization';
export interface AcceptanceFailureDescription {
  fault: AcceptanceFault;
  text: string;
  detail: string;
  values?: Record<string, unknown>;
}
export function sentence(text: string): string;
export function stageActivity(stage: AcceptanceStage): string;
export class AcceptanceFailure extends Error {
  constructor(fault: AcceptanceFault, message: string, values?: Record<string, unknown>);
  readonly acceptanceFault: AcceptanceFault;
  readonly values?: Record<string, unknown>;
}
export function acceptanceFailure(fault: AcceptanceFault, message: string, values?: Record<string, unknown>): AcceptanceFailure;
export function failureText(fault: AcceptanceFault, message: string): string;
export function describeAcceptanceFailure(error: unknown, stage?: AcceptanceStage): AcceptanceFailureDescription;
export function compactFailure(failure: unknown): Record<string, unknown> | undefined;
