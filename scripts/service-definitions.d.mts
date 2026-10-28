export interface ServiceInstallationContext {
  home: string; accountHome: string; runtimeDir: string; domain: string;
  bundleRoot?: string;
  bundleIdentifier?: string;
  serviceDir: string; privateServiceDir: string; backendLabel: string; gatewayLabel: string;
}
export interface LoadedService {
  loaded?: boolean; pid: number | null; program?: string; argv?: string[]; environment?: Record<string, string>;
  workingDirectory?: string; stdoutPath?: string; stderrPath?: string; keepAlive?: boolean;
  bundleProgram?: string; parentBundleIdentifier?: string;
  startedAt?: string; executable?: string; runs?: number; lastExit?: string | null;
}
export interface ServiceDefinition {
  Label: string; Program?: string; ProgramArguments: string[]; EnvironmentVariables: Record<string, string>;
  WorkingDirectory: string; StandardOutPath: string; StandardErrorPath: string; KeepAlive: boolean; Comment?: string;
  BundleProgram?: string; bundleRoot?: string; parentBundleIdentifier?: string;
}
export type ServiceKind = 'backend' | 'gateway';
export interface ServiceDefinitionRefusal {
  service: ServiceKind; label: string;
  category: 'ownership_conflict' | 'malformed_definition' | 'duplicate_label' | 'missing_definition' | 'unreadable_state' | 'definition_mismatch' | 'starting';
  fields: string[]; message: string;
  evidence?: { service: ServiceKind; label: string; executable: string; pid: number; startedAt: string | null; runs: number; bundleProgram: string; parentBundleIdentifier: string };
}
export interface InstalledServiceDefinition { file: string; bytesBase64: string; sha256: string; record: ServiceDefinition }
export interface ServiceObservation {
  service: ServiceKind; label: string; installed: InstalledServiceDefinition[]; job: LoadedService;
  loadedDefinition: ServiceDefinition | null; desired: ServiceDefinition | null;
  differences: { file: string; fields: string[] }[]; desiredDifferences: string[];
}
export type ServiceOwnershipRefusal = ServiceDefinitionRefusal & { category: 'ownership_conflict' | 'unreadable_state' | 'starting' };
export type ServiceDefinitionInspection = { ok: true; observations: ServiceObservation[] } | { ok: false; refusal: ServiceDefinitionRefusal };
export type ServiceOwnershipInspection = { ok: true; observations: ServiceObservation[] } | { ok: false; refusal: ServiceOwnershipRefusal };
export interface ServiceObservationOptions { desired?: Partial<Record<ServiceKind, ServiceDefinition>>; until?: number; services?: ServiceKind[] }
export function serviceInstallationContext(options?: { home?: string; accountHome?: string; domain?: string; bundleRoot?: string; bundleIdentifier?: string }): ServiceInstallationContext;
export function assertBundleServiceIdentity(context: ServiceInstallationContext, until?: number): void;
export function parseLoadedService(detail: string): LoadedService;
export function differingServiceFields(record: ServiceDefinition, job: LoadedService): string[];
export function loadedServiceMatches(record: ServiceDefinition, job: LoadedService): boolean;
export function loadedServiceDefinition(label: string, job: LoadedService): ServiceDefinition;
export function ownsServiceDefinition(context: ServiceInstallationContext, service: ServiceKind, record: ServiceDefinition): boolean;
export function assessServiceObservation(context: ServiceInstallationContext, service: ServiceKind, installed: InstalledServiceDefinition[], job: LoadedService,
  options?: { desired?: ServiceDefinition }): { ok: true; observation: ServiceObservation } | { ok: false; refusal: ServiceOwnershipRefusal };
/** Admission is ownership-only: drift, owned duplicates, and absent services are ready. */
export function serviceOwnershipReady(inspection: ServiceDefinitionInspection): inspection is { ok: true; observations: ServiceObservation[] };
/** Handoff admission also requires a running backend to drain; the gateway may be absent. */
export function runtimeHandoffReadiness(inspection: ServiceOwnershipInspection): ServiceOwnershipInspection | { ok: false; refusal: ServiceDefinitionRefusal & { category: 'missing_definition' } };
/** Controller postcondition: one installed managed definition, equal to launchd whenever loaded. */
export function matchingServiceDefinitions(inspection: ServiceDefinitionInspection): ServiceDefinitionInspection;
/** Read-only ownership observation; neither selects the candidate runtime nor requires convergence. */
export function inspectServiceDefinitions(context: ServiceInstallationContext, options?: ServiceObservationOptions): Promise<ServiceOwnershipInspection>;
export function inspectServiceDefinitionsSync(context: ServiceInstallationContext, options?: ServiceObservationOptions): ServiceOwnershipInspection;
