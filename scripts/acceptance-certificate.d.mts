export type AcceptanceGate = 'package_build' | 'package_verification' | 'readiness' | 'desktop_interaction' | 'health_coverage' | 'shutdown' | 'log_assessment' | 'runtime_scratch_cleanup';
export interface AcceptanceCertification {
  gates: Record<AcceptanceGate, 'passed'>;
  interaction: { completed_at: number; reloads: 2 };
  health: { started_at: number; completed_at: number; periodic_windows: number };
  shutdown: { desktop_exit: number | null; desktop_signal: string | null };
}
export const LEGACY_ACCEPTED_RELEASE_SCHEMA: 'mandible-accepted-release@1';
export const ACCEPTANCE_CERTIFICATE_SCHEMA: 'mandible-accepted-release@2';
export const ACCEPTANCE_RECEIPT_CAPABILITY: 'MANDIBLE_ACCEPTANCE_RECEIPT_SCHEMA';
export const ACCEPTANCE_CERTIFICATE_LIMIT: number;
export const ACCEPTANCE_CONTRACT: 'mandible-candidate-acceptance@1';
export function acceptanceReceiptSchema(value: string | undefined): typeof LEGACY_ACCEPTED_RELEASE_SCHEMA | typeof ACCEPTANCE_CERTIFICATE_SCHEMA;
export function certifyAcceptance(result: unknown): AcceptanceCertification;
export function validateAcceptanceCertificate(receipt: unknown): void;
export function boundedAcceptanceBytes(value: unknown): Buffer;
