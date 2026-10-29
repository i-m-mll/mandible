import type { BundleContext, NativeServiceObservation } from './bundle-services.mjs';
import type { ServiceKind, ServiceDefinitionInspection, LoadedService } from './service-definitions.mjs';
import type { RuntimeObservationError } from './runtime-observation.mjs';
import type { RuntimeProcessIdentity } from './runtime-observation.mjs';
export const BUNDLE_SERVICE_START_TIMEOUT_MS: number;
export interface ServiceStartCommandResult {
  operation: 'kickstart'; outcome: 'acknowledged' | 'indeterminate' | 'failed';
  code: string | null; status: number | null; signal: string | null; message: string | null;
}
export function startOwnedJob(context: BundleContext, role: ServiceKind, until?: number): ServiceStartCommandResult;
export function bundleServiceCompletedRun(job?: LoadedService): 'clean' | 'failed' | null;
export function bundleServiceStartAction(state: { previousStatus?: string; registered?: boolean; startAttempted?: boolean }, nativeStatus: string,
  job?: LoadedService): 'start' | 'register' | null;
export function reconcileBundleServiceStart(context: BundleContext, role: ServiceKind, options: {
  until: number;
  processes?: Partial<Record<ServiceKind, RuntimeProcessIdentity>>;
  readProcess(context: BundleContext, role: ServiceKind, options?: { until?: number }): RuntimeProcessIdentity | null;
  control(context: BundleContext, operation: 'status' | 'register', role: ServiceKind, options?: { until?: number }): NativeServiceObservation;
  observe?(context: BundleContext, options?: { until?: number }): ServiceDefinitionInspection;
  start?(context: BundleContext, role: ServiceKind, until?: number): ServiceStartCommandResult;
  now?(): number; wait?(ms: number): Promise<void>;
}): Promise<{ ok: true; observation: unknown; processes: Partial<Record<ServiceKind, RuntimeProcessIdentity>> } | { ok: false; error: RuntimeObservationError }>;
