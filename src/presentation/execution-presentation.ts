import { parse, type Node, type Expression, type ObjectExpression, type ExpressionStatement } from 'acorn';

export type ExecutionForwarding = 'result' | 'stdout' | 'direct';
export type ExecutionOperation = { command: string; shell?: string; forwarding: ExecutionForwarding };
export type ExecutionFacts = { kind: 'command'; count: number; shells: Array<string | null>; forwarding: ExecutionForwarding[] }
  | { kind: 'script'; language: 'javascript' };
export type ExecutionPresentation = { facts: ExecutionFacts; operations: ExecutionOperation[]; script?: string };

function literal(node: Node | null | undefined): unknown {
  if (node?.type === 'Literal') return (node as Extract<Expression, { type: 'Literal' }>).value;
  if (node?.type === 'TemplateLiteral') {
    const template = node as Extract<Expression, { type: 'TemplateLiteral' }>;
    return template.expressions.length === 0 ? template.quasis[0].value.cooked : undefined;
  }
  return undefined;
}
function staticData(node: Node): boolean {
  if (literal(node) !== undefined) return true;
  if (node.type === 'UnaryExpression') {
    const unary = node as Extract<Expression, { type: 'UnaryExpression' }>;
    return ['-', '+'].includes(unary.operator) && typeof literal(unary.argument) === 'number';
  }
  if (node.type === 'ArrayExpression') return (node as Extract<Expression, {type:'ArrayExpression'}>).elements.every(value => value !== null && staticData(value));
  if (node.type === 'ObjectExpression') return (node as ObjectExpression).properties.every(property => property.type === 'Property'
    && property.kind === 'init' && !property.method && !property.computed && !property.shorthand && staticData(property.value));
  return false;
}
function propertyName(node: Node): string | undefined {
  return node.type === 'Identifier' ? (node as Extract<Expression, {type:'Identifier'}>).name
    : typeof literal(node) === 'string' ? literal(node) as string : undefined;
}
function execOperation(node: Node): Omit<ExecutionOperation, 'forwarding'> | null {
  if (node.type !== 'AwaitExpression') return null;
  const call = (node as Extract<Expression, {type:'AwaitExpression'}>).argument;
  if (call.type !== 'CallExpression' || call.optional || call.arguments.length !== 1) return null;
  const member = call.callee;
  if (member.type !== 'MemberExpression' || member.computed || member.optional || member.object.type !== 'Identifier'
    || member.object.name !== 'tools' || propertyName(member.property) !== 'exec_command') return null;
  const options = call.arguments[0];
  if (options.type !== 'ObjectExpression' || !staticData(options)) return null;
  const values = new Map<string, unknown>();
  for (const property of options.properties) {
    if (property.type !== 'Property') return null;
    const key = propertyName(property.key);
    if (!key || values.has(key)) return null;
    values.set(key, literal(property.value));
  }
  const command = values.get('cmd');
  if (typeof command !== 'string') return null;
  const shell = values.get('shell');
  if (shell !== undefined && typeof shell !== 'string') return null;
  return { command, ...(typeof shell === 'string' ? {shell} : {}) };
}
function forwarded(node: Node): { value: Node; forwarding: 'result' | 'stdout' } | null {
  if (node.type !== 'ExpressionStatement') return null;
  const call = (node as ExpressionStatement).expression;
  if (call.type !== 'CallExpression' || call.optional || call.callee.type !== 'Identifier' || call.callee.name !== 'text' || call.arguments.length !== 1) return null;
  const value = call.arguments[0];
  if (value.type === 'MemberExpression' && !value.computed && !value.optional && propertyName(value.property) === 'output') {
    return { value: value.object, forwarding: 'stdout' };
  }
  return { value, forwarding: 'result' };
}
function transparentScript(script: string): ExecutionOperation[] | null {
  let program;
  try { program = parse(script, {ecmaVersion: 'latest', sourceType: 'module'}); }
  catch { return null; }
  const operations: ExecutionOperation[] = [];
  for (let index = 0; index < program.body.length; index++) {
    const statement = program.body[index];
    if (statement.type === 'VariableDeclaration' && statement.kind === 'const' && statement.declarations.length === 1) {
      const declaration = statement.declarations[0];
      if (declaration.id.type !== 'Identifier' || ['text', 'tools'].includes(declaration.id.name) || !declaration.init) return null;
      const operation = execOperation(declaration.init);
      const next = program.body[++index];
      const forward = next && forwarded(next);
      if (!operation || !forward || forward.value.type !== 'Identifier'
        || (forward.value as Extract<Expression, {type:'Identifier'}>).name !== declaration.id.name) return null;
      operations.push({...operation, forwarding: forward.forwarding});
    } else {
      const forward = forwarded(statement);
      const operation = forward && execOperation(forward.value);
      if (!operation || !forward) return null;
      operations.push({...operation, forwarding: forward.forwarding});
    }
  }
  return operations.length ? operations : null;
}

export function projectExecution(name: string, input: Record<string, unknown> | string = {}, toolKind?: string): ExecutionPresentation | null {
  const normalized = name.trim().toLowerCase();
  let object: Record<string, unknown> = typeof input === 'object' ? input : {};
  if (typeof input === 'string') {
    try { const parsed: unknown = JSON.parse(input); if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) object = parsed as Record<string, unknown>; }
    catch { /* Opaque provider input is script or literal command data. */ }
  }
  let operations: ExecutionOperation[] | null = null;
  if (['bash', 'exec_command', 'functions.exec_command'].includes(normalized)) {
    const command = object.cmd ?? object.command ?? (typeof input === 'string' && !Object.keys(object).length ? input : undefined);
    if (typeof command !== 'string') return null;
    operations = [{command, ...(typeof object.shell === 'string' ? {shell: object.shell} : normalized === 'bash' ? {shell: 'bash'} : {}), forwarding: 'direct'}];
  } else if (['exec', 'functions.exec'].includes(normalized) && (!toolKind || toolKind === 'custom_tool_call')) {
    const script = typeof input === 'string' ? input : typeof input.code === 'string' ? input.code : undefined;
    if (script === undefined) return null;
    operations = transparentScript(script);
    if (!operations) return {facts: {kind: 'script', language: 'javascript'}, operations: [], script};
  }
  return operations ? {operations, facts: {kind: 'command', count: operations.length,
    shells: operations.map(operation => operation.shell ?? null), forwarding: operations.map(operation => operation.forwarding)}} : null;
}

export type ExecutionResultPresentation = { text: string; wallTimeSeconds?: number; metadata: Array<{label: string; value: string}>; failed: boolean; running: boolean; decoded: boolean };
export function projectExecutionResult(execution: ExecutionPresentation | null, text: string): ExecutionResultPresentation {
  const raw: ExecutionResultPresentation = {text, metadata: [], failed: false, running: false, decoded: false};
  if (execution?.operations.length !== 1 || execution.operations[0].forwarding !== 'result') return raw;
  // The provider framing is validated separately from the one JSON transport object.
  const start = text.indexOf('{');
  if (start < 0) return raw;
  const preface = text.slice(0, start);
  if (preface && !/^(?:Script completed\r?\n|Wall time(?::)? [0-9.]+ seconds\r?\n|Total output lines: \d+\r?\n|Output:\r?\n|\s)*$/.test(preface)) return raw;
  let value: unknown;
  try { value = JSON.parse(text.slice(start)); } catch { return raw; }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return raw;
  const envelope = value as Record<string, unknown>;
  const known = new Set(['output', 'wall_time_seconds', 'exit_code', 'session_id', 'chunk_id', 'original_token_count']);
  if (Object.keys(envelope).some(key => !known.has(key)) || typeof envelope.output !== 'string'
    || typeof envelope.wall_time_seconds !== 'number' || !Number.isFinite(envelope.wall_time_seconds) || envelope.wall_time_seconds < 0
    || (envelope.exit_code != null && !Number.isInteger(envelope.exit_code))
    || (envelope.session_id != null && !Number.isInteger(envelope.session_id))
    || (envelope.chunk_id != null && typeof envelope.chunk_id !== 'string')
    || (envelope.original_token_count != null && !Number.isInteger(envelope.original_token_count))) return raw;
  const metadata = Object.entries(envelope).filter(([key, value]) => !['output', 'wall_time_seconds'].includes(key) && value != null)
    .map(([label, value]) => ({label, value: String(value)}));
  return {text: envelope.output, wallTimeSeconds: envelope.wall_time_seconds, metadata,
    failed: typeof envelope.exit_code === 'number' && envelope.exit_code !== 0,
    running: envelope.session_id != null && envelope.exit_code == null, decoded: true};
}
