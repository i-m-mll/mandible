import type { ServiceInstallationContext, ServiceDefinitionInspection, ServiceKind } from './service-definitions.mjs';
export type BundleContext = ServiceInstallationContext & { bundleRoot: string };
export interface BundleRelease { provenance: { commit: string; source_digest: string } }
export interface BundleOwner { schema: 'mandible-bundle-owner@1'; bundleRoot: string; installationId: string; generation: string; sourceDigest: string; acceptedRelease?: string }
export interface BundleLaunch { enabled: boolean; gatewayEnabled?: boolean; launchMode: 'manual' | 'on_demand'; session?: string }
export type NativeServiceStatus = 'not_registered' | 'enabled' | 'requires_approval' | 'not_found';
export interface NativeServiceObservation { service: ServiceKind; label: string; status: NativeServiceStatus; registration_changed: boolean }
export type BundleAdmission = { ok: true; owner: BundleOwner | null } | { ok: false; code: 'ownership_conflict' | 'replacement_required'; message: string };
export function readBundleOwner(context: ServiceInstallationContext): BundleOwner | null;
export function readBundleLaunch(context: ServiceInstallationContext): BundleLaunch;
export function bundleLoginSession(): string;
export function bundleLaunchAllowed(preference: BundleLaunch | null, session: string, role?: ServiceKind): boolean;
export function admitBundleOwner(context: BundleContext, release: BundleRelease, options?: { relocation?: boolean }): BundleAdmission;
export function adoptBundleRelease(context: BundleContext, release: BundleRelease, expectedOwner: BundleOwner | null, acceptedRelease?: string): BundleOwner;
export function nativeServiceControl(context: BundleContext, operation: 'status' | 'register' | 'unregister' | 'settings', role: ServiceKind, options?: { until?: number }): NativeServiceObservation;
export interface BundleRuntimeObservation {
  status: { state: string; healthy: boolean; [key: string]: unknown };
  trusted: { error?: string | null };
  production: { root: string };
  backendJob: { loaded: boolean; pid?: number | null };
  backendPortOpen: boolean;
  backend?: { ok: boolean; document?: { startup_epoch?: string } };
}
export function bundleRuntimeCommand(command: string, options: {
  context: BundleContext; release: BundleRelease; launchMode: 'manual' | 'on_demand';
  initialize(root: string): Promise<unknown>; inspect(options: { launchMode: string }): Promise<BundleRuntimeObservation>;
  configureGateway(root: string): { adminRestartRequired: boolean } | Promise<{ adminRestartRequired: boolean }>; reloadGateway(): void; restartGateway(): void; previewCount(root: string): number;
  waitReady(launchMode: string): Promise<BundleRuntimeObservation>;
  control?: typeof nativeServiceControl; session?: typeof bundleLoginSession;
  readProcess: Parameters<typeof import('./bundle-service-start.mjs').reconcileBundleServiceStart>[2]['readProcess'];
  startService?: typeof import('./bundle-service-start.mjs').reconcileBundleServiceStart; registrationUntil?: number;
  observe?: (context: ServiceInstallationContext) => ServiceDefinitionInspection;
}): Promise<Record<string, unknown>>;
