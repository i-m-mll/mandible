import { parse, type AnyNode, type Identifier } from 'acorn';

type Ast = AnyNode;
export type ToolEmissionEncoding = 'literal' | 'json' | 'native';
export type ToolProgramOperation = { encoding:ToolEmissionEncoding; name: string; input: Record<string, unknown> | string; forwarding: 'result' | 'stdout' | 'direct'; index?: number; indexKey?: string; resultKey?: string; collection?: number; settled?: boolean };
export type ToolProgram = { operations: ToolProgramOperation[] };
const identifier = (node: Ast | undefined, name?: string): node is Identifier => node?.type === 'Identifier' && (name === undefined || node.name === name);
const member = (node: Ast | undefined, object: string, property: string): boolean => node?.type === 'MemberExpression' && !node.computed && !node.optional && identifier(node.object, object) && identifier(node.property, property);
function data(node: Ast): { value: unknown } | null {
  if (node.type === 'Literal' && !node.regex && typeof node.value !== 'bigint') return {value: node.value};
  if (node.type === 'TemplateLiteral' && !node.expressions.length) return {value: node.quasis[0].value.cooked};
  if (node.type === 'UnaryExpression' && ['-', '+'].includes(node.operator)) {
    const value = data(node.argument); return value && typeof value.value === 'number' ? {value: node.operator === '-' ? -value.value : value.value} : null;
  }
  if (node.type === 'ArrayExpression') {
    const values = node.elements.map((element: Ast | null) => element && data(element));
    return values.every((value): value is {value:unknown} => value!==null) ? {value: values.map(value => value.value)} : null;
  }
  if (node.type === 'ObjectExpression') {
    const value: Record<string, unknown> = {};
    for (const property of node.properties) {
      if (property.type !== 'Property' || property.kind !== 'init' || property.method || property.computed || property.shorthand) return null;
      const key = property.key.type === 'Identifier' ? property.key.name : property.key.type === 'Literal' ? property.key.value : undefined;
      const entry = data(property.value);
      if (typeof key !== 'string' || Object.hasOwn(value, key) || !entry || key === '__proto__') return null;
      value[key] = entry.value;
    }
    return {value};
  }
  return null;
}
function operation(node: Ast): ToolProgramOperation | null {
  if (node.type === 'AwaitExpression') return operation(node.argument);
  if (node.type !== 'CallExpression' || node.optional || node.arguments.length !== 1) return null;
  const callee = node.callee;
  if (callee.type !== 'MemberExpression' || callee.computed || callee.optional || !identifier(callee.object, 'tools') || !identifier(callee.property)) return null;
  const input = data(node.arguments[0]);
  return input && (typeof input.value === 'string' || (input.value && typeof input.value === 'object' && !Array.isArray(input.value)))
    ? {name: callee.property.name, input: input.value as Record<string, unknown> | string, forwarding: 'result',encoding:'native'} : null;
}
function calls(node: Ast): {operations: ToolProgramOperation[]; batch: boolean} | null {
  if (node.type !== 'AwaitExpression') return null;
  const call = node.argument;
  if (call.type === 'CallExpression' && !call.optional && call.arguments.length === 1
      && (member(call.callee, 'Promise', 'all') || member(call.callee, 'Promise', 'allSettled')) && call.arguments[0].type === 'ArrayExpression') {
    const settled = member(call.callee, 'Promise', 'allSettled');
    const operations = call.arguments[0].elements.map((element: Ast | null) => element && operation(element));
    return operations.length && operations.every((op): op is ToolProgramOperation => op!==null) ? {batch:true, operations: operations.map((op: ToolProgramOperation,index: number) => ({...op,index,...(settled ? {settled:true} : {})}))} : null;
  }
  const op = operation(node); return op ? {batch:false,operations:[op]} : null;
}
function forwardedValue(node: Ast, name: string): 'result' | 'stdout' | null {
  if(identifier(node,name)) return 'result';
  return member(node,name,'output') ? 'stdout' : null;
}
function forward(node: Ast, name: string): {forwarding:'result' | 'stdout';encoding:ToolEmissionEncoding} | null {
  const direct=forwardedValue(node,name);
  if(direct) return {forwarding:direct,encoding:direct==='stdout' ? 'literal' : 'native'};
  if(node.type==='CallExpression' && !node.optional && member(node.callee,'JSON','stringify') && node.arguments.length===1) {
    const value=forwardedValue(node.arguments[0],name);
    return value ? {forwarding:value,encoding:'json'} : null;
  }
  return null;
}
function textValue(node: Ast): Ast | null {
  const call = node.type === 'ExpressionStatement' ? node.expression : node;
  return call.type === 'CallExpression' && !call.optional && identifier(call.callee,'text') && call.arguments.length === 1 ? call.arguments[0] : null;
}
function forwarding(statement: Ast, name: string, batch: boolean): {forwarding:'result' | 'stdout';encoding:ToolEmissionEncoding;indexKey?:string;resultKey?:string} | null {
  if (!batch) { const value = textValue(statement); const mode=value && forward(value,name); return mode; }
  const direct=textValue(statement);
  const mode=direct && forward(direct,name);
  if(mode?.forwarding==='result') return {...mode,encoding:'json'};
  const call = statement.type === 'ExpressionStatement' && statement.expression;
  if (!call || call.type !== 'CallExpression' || call.optional || !member(call.callee,name,'forEach') || call.arguments.length !== 1) return null;
  const callback = call.arguments[0];
  if (callback.type !== 'ArrowFunctionExpression' || callback.async || callback.params.length !== 2 || !callback.params.every(p=>identifier(p))) return null;
  const [valueName,indexName] = callback.params.map(p => identifier(p) ? p.name : '');
  if (valueName === indexName || ['tools','text','JSON'].includes(valueName) || ['tools','text','JSON'].includes(indexName)) return null;
  const body = callback.body.type === 'BlockStatement' && callback.body.body.length === 1 ? callback.body.body[0] : callback.body;
  let value = textValue(body);
  if (value?.type === 'CallExpression' && !value.optional && member(value.callee,'JSON','stringify') && value.arguments.length === 1) value = value.arguments[0];
  if (value?.type !== 'ObjectExpression' || value.properties.length !== 2) return null;
  const [index,spread] = value.properties;
  if (index.type !== 'Property' || index.computed || index.kind !== 'init' || index.method || (index.key.type!=='Identifier' && (index.key.type!=='Literal' || typeof index.key.value!=='string')) || !identifier(index.value,indexName)
      ) return null;
  const indexKey=index.key.type==='Identifier' ? index.key.name : index.key.type==='Literal' ? String(index.key.value) : '';
  if (spread.type === 'SpreadElement' && identifier(spread.argument,valueName)) return {forwarding:'result',encoding:'json',indexKey};
  if (spread.type === 'Property' && spread.kind === 'init' && !spread.computed && !spread.method && identifier(spread.key)) {const mode=forwardedValue(spread.value,valueName);if(mode) return {forwarding:mode,encoding:'json',indexKey,resultKey:spread.key.name};}
  return null;
}
/** Project only a complete static program whose outputs account for every call. Never execute provider source. */
export function projectToolProgram(name: string, input: Record<string, unknown> | string = {}, kind?: string): ToolProgram | null {
  if (!['exec','functions.exec'].includes(name.toLowerCase()) || (kind && kind !== 'custom_tool_call')) return null;
  const script = typeof input === 'string' ? input : input.code;
  if (typeof script !== 'string') return null;
  let program;
  try {program = parse(script,{ecmaVersion:'latest',sourceType:'module'});} catch {return null;}
  const operations: ToolProgramOperation[] = [];
  const names = new Set(['tools','text','JSON','Promise']);
  for (let i=0;i<program.body.length;i++) {
    const statement = program.body[i] as Ast;
    if (statement.type === 'VariableDeclaration' && statement.kind === 'const' && statement.declarations.length === 1) {
      const declaration = statement.declarations[0];
      if (!identifier(declaration.id) || names.has(declaration.id.name) || !declaration.init) return null;
      names.add(declaration.id.name);
      const batch = calls(declaration.init);
      const output = program.body[++i] as Ast | undefined;
      const mode = batch && output && forwarding(output,declaration.id.name,batch.batch);
      if (!batch || !mode) return null;
      operations.push(...batch.operations.map(op=>({...op,...mode,...(batch.batch && !mode.indexKey ? {collection:i} : {})})));
    } else {
      let value = textValue(statement);
      const serialized=value?.type==='CallExpression' && !value.optional && member(value.callee,'JSON','stringify') && value.arguments.length===1;
      if(value?.type==='CallExpression' && !value.optional && member(value.callee,'JSON','stringify') && value.arguments.length===1) value=value.arguments[0];
      const stdout = value?.type === 'MemberExpression' && !value.computed && !value.optional && identifier(value.property,'output');
      const call = value && calls(stdout && value.type==='MemberExpression' ? value.object : value);
      if (!call || (call.batch && stdout)) return null;
      operations.push(...call.operations.map(op=>({...op,encoding:serialized || call.batch ? 'json' as const : stdout ? 'literal' as const : 'native' as const,forwarding:stdout ? 'stdout' as const : 'result' as const,...(call.batch ? {collection:i} : {})})));
    }
  }
  return operations.length ? {operations} : null;
}
