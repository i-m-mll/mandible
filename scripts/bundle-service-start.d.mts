import type { BundleContext, NativeServiceObservation } from './bundle-services.mjs';
import type { ServiceKind, ServiceDefinitionInspection } from './service-definitions.mjs';
import type { RuntimeObservationError } from './runtime-observation.mjs';
import type { RuntimeProcessIdentity } from './runtime-observation.mjs';
export const BUNDLE_SERVICE_START_TIMEOUT_MS: number;
export function startOwnedJob(context: BundleContext, role: ServiceKind, until?: number): { ok: boolean; status?: number | null; error?: string | null };
export function bundleServiceStartAction(state: { previousStatus?: string; registered?: boolean; startAttempted?: boolean }, nativeStatus: string,
  job?: { loaded?: boolean; pid?: number | null }): 'start' | 'register' | null;
export function reconcileBundleServiceStart(context: BundleContext, role: ServiceKind, options: {
  until: number;
  processes?: Partial<Record<ServiceKind, RuntimeProcessIdentity>>;
  readProcess(context: BundleContext, role: ServiceKind, options?: { until?: number }): RuntimeProcessIdentity | null;
  control(context: BundleContext, operation: 'status' | 'register', role: ServiceKind, options?: { until?: number }): NativeServiceObservation;
  observe?(context: BundleContext, options?: { until?: number }): ServiceDefinitionInspection;
  start?(context: BundleContext, role: ServiceKind, until?: number): { ok: boolean; status?: number | null; error?: string | null };
  now?(): number; wait?(ms: number): Promise<void>;
}): Promise<{ ok: true; observation: unknown; processes: Partial<Record<ServiceKind, RuntimeProcessIdentity>> } | { ok: false; error: RuntimeObservationError }>;
