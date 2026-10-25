export interface ServiceInstallationContext {
  home: string; accountHome: string; runtimeDir: string; domain: string;
  serviceDir: string; privateServiceDir: string; backendLabel: string; gatewayLabel: string;
}
export interface LoadedService {
  loaded?: boolean; pid: number | null; program?: string; argv?: string[]; environment?: Record<string, string>;
  workingDirectory?: string; stdoutPath?: string; stderrPath?: string; keepAlive?: boolean;
}
export interface ServiceDefinition {
  Label: string; ProgramArguments: string[]; EnvironmentVariables: Record<string, string>;
  WorkingDirectory: string; StandardOutPath: string; StandardErrorPath: string; KeepAlive: boolean; Comment?: string;
}
export interface ServiceDefinitionRefusal {
  service: 'backend' | 'gateway'; label: string;
  category: 'ownership_conflict' | 'malformed_definition' | 'duplicate_label' | 'missing_definition' | 'unreadable_state' | 'definition_mismatch';
  fields: string[]; message: string; repairCommand: string;
}
export interface ServiceObservation {
  service: 'backend' | 'gateway'; label: string; file: string; definition: ServiceDefinition; job: LoadedService;
}
export type ServiceDefinitionInspection = { ok: true; observations: ServiceObservation[] } | { ok: false; refusal: ServiceDefinitionRefusal };
export function serviceInstallationContext(options?: { home?: string; accountHome?: string; domain?: string }): ServiceInstallationContext;
export function parseLoadedService(detail: string): LoadedService;
export function differingServiceFields(record: ServiceDefinition, job: LoadedService): string[];
export function loadedServiceMatches(record: ServiceDefinition, job: LoadedService): boolean;
export function ownsServiceDefinition(context: ServiceInstallationContext, service: 'backend' | 'gateway', record: ServiceDefinition): boolean;
export function inspectServiceDefinitions(context: ServiceInstallationContext): Promise<ServiceDefinitionInspection>;
export function inspectServiceDefinitionsSync(context: ServiceInstallationContext): ServiceDefinitionInspection;
