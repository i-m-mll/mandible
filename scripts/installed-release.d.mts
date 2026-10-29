export interface InstalledRelease {
  schema: 'mandible-installed-release@1';
  version: string;
  target: string;
  layout: { kind: 'macos-app'; roots: Record<string, string> };
  provenance: { commit: string; source_digest: string; summary: string; date: string; bun_revision: string };
  entrypoints: Record<'daemon' | 'cli' | 'channel' | 'controller' | 'trustSetup' | 'service', string>;
  native: Record<'bun' | 'sqlite' | 'caddy' | 'claude' | 'trustHelper' | 'serviceHelper', string>;
  serviceExecutables?: Record<'backend' | 'gateway', 'bun' | 'caddy'>;
  serviceControlProtocol?: 2;
  resources?: Record<string, string>;
  signing: Record<string, string>;
  files: Record<string, { sha256: string; size: number }>;
}
export const RELEASE_SCHEMA: string;
export function installedFileIdentity(file: string): { sha256: string; size: number };
export function applicationIdentity(app: string): string;
export function installedResourceRoot(): string | null;
export function installedProgramRoots(root: string, layout: InstalledRelease['layout']): string[];
export function releaseFile(root: string, relative: string, layout?: InstalledRelease['layout']): string;
export function readInstalledRelease(root: string): InstalledRelease;
export function verifyInstalledRelease(root: string): InstalledRelease;
export function verifyApplicationRelease(app: string): { release: InstalledRelease; digest: string };
export function installedRuntimeEnvironment(root: string, environment?: NodeJS.ProcessEnv): NodeJS.ProcessEnv;
