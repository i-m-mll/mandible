import type { BundleContext, NativeServiceObservation } from './bundle-services.mjs';
import type { ServiceKind, ServiceDefinitionInspection } from './service-definitions.mjs';
import type { RuntimeObservationError } from './runtime-observation.mjs';
import type { RuntimeProcessIdentity } from './runtime-observation.mjs';
export const BUNDLE_SERVICE_START_TIMEOUT_MS: number;
export function reconcileBundleServiceStart(context: BundleContext, role: ServiceKind, options: {
  until: number;
  processes?: Partial<Record<ServiceKind, RuntimeProcessIdentity>>;
  readProcess(context: BundleContext, role: ServiceKind): RuntimeProcessIdentity | null;
  control(context: BundleContext, operation: 'status' | 'register', role: ServiceKind): NativeServiceObservation;
  observe?(context: BundleContext): ServiceDefinitionInspection;
  start?(context: BundleContext, role: ServiceKind): { ok: boolean; status?: number | null; error?: string | null };
  now?(): number; wait?(ms: number): Promise<void>;
}): Promise<{ ok: true; observation: unknown; processes: Partial<Record<ServiceKind, RuntimeProcessIdentity>> } | { ok: false; error: RuntimeObservationError }>;
