import { wrapperCommandResult, type ToolTransportResult } from './tool-transport.js';
import { projectToolProgram } from './tool-program.js';
export type ExecutionForwarding = 'result' | 'stdout' | 'direct';
export type ExecutionOperation = { command: string; shell?: string; forwarding: ExecutionForwarding };
export type ExecutionFacts = { kind: 'command'; count: number; shells: Array<string | null>; forwarding: ExecutionForwarding[] }
  | { kind: 'script'; language: 'javascript' };
export type ExecutionPresentation = { facts: ExecutionFacts; operations: ExecutionOperation[]; script?: string };

export function projectExecution(name: string, input: Record<string, unknown> | string = {}, toolKind?: string): ExecutionPresentation | null {
  const normalized = name.trim().toLowerCase();
  let object: Record<string, unknown> = typeof input === 'object' ? input : {};
  if (typeof input === 'string') {
    try { const parsed: unknown = JSON.parse(input); if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) object = parsed as Record<string, unknown>; }
    catch { /* Opaque provider input is script or literal command data. */ }
  }
  let operations: ExecutionOperation[] | null = null;
  if (['bash', 'exec_command', 'functions.exec_command', 'run_shell_command'].includes(normalized) || toolKind === 'commandExecution') {
    const command = object.cmd ?? object.command ?? (typeof input === 'string' && !Object.keys(object).length ? input : undefined);
    if (typeof command !== 'string') return null;
    operations = [{command, ...(typeof object.shell === 'string' ? {shell: object.shell} : normalized === 'bash' ? {shell: 'bash'} : {}), forwarding: 'direct'}];
  } else if (['exec', 'functions.exec'].includes(normalized) && (!toolKind || toolKind === 'custom_tool_call')) {
    const script = typeof input === 'string' ? input : typeof input.code === 'string' ? input.code : undefined;
    if (script === undefined) return null;
    const program = projectToolProgram(name, input, toolKind);
    operations = program?.operations.every(op => ['exec_command', 'functions.exec_command', 'Bash', 'bash', 'run_shell_command'].includes(op.name))
      ? program.operations.flatMap(op => {const execution = projectExecution(op.name, op.input); return execution?.operations.map(value => ({...value, forwarding:op.forwarding})) ?? [];}) : null;
    if (!operations?.length || operations.length !== program?.operations.length) return {facts: {kind: 'script', language: 'javascript'}, operations: [], script};
  }
  return operations ? {operations, facts: {kind: 'command', count: operations.length,
    shells: operations.map(operation => operation.shell ?? null), forwarding: operations.map(operation => operation.forwarding)}} : null;
}

export type ExecutionResultPresentation = ToolTransportResult;
export function projectExecutionResult(execution: ExecutionPresentation | null, text: string): ExecutionResultPresentation {
  return wrapperCommandResult(execution,text);
}
