import type { ServiceKind } from './service-definitions.mjs';
export type NativeExecutionModel = { ok: true; roles: Record<ServiceKind, { terminal: string; pending: string[] }> } | { ok: false; message: string };
export function nativeExecutionModel(bundleRoot: string, release: { native?: Record<string, string>; serviceExecutables?: Partial<Record<ServiceKind, string>> }): NativeExecutionModel;
export function classifyNativeExecution(model: NativeExecutionModel, role: ServiceKind, executable: string): 'pending' | 'executable-qualified' | 'foreign';
