import { parse, type AnyNode, type Identifier } from 'acorn';

type Ast = AnyNode;
export type ToolEmissionEncoding = 'literal' | 'json' | 'native';
export type ToolProgramOperation = { encoding:ToolEmissionEncoding; name: string; input: Record<string, unknown> | string; forwarding: 'result' | 'stdout' | 'direct'; index?: number; indexKey?: string; resultKey?: string; collection?: number; settled?: boolean };
export type ToolProgram = { operations: ToolProgramOperation[] };
const identifier = (node: Ast | undefined, name?: string): node is Identifier => node?.type === 'Identifier' && (name === undefined || node.name === name);
const member = (node: Ast | undefined, object: string, property: string): boolean => node?.type === 'MemberExpression' && !node.computed && !node.optional && identifier(node.object, object) && identifier(node.property, property);
function data(node: Ast, bindings = new Map<string, unknown>()): { value: unknown } | null {
  if (identifier(node) && bindings.has(node.name)) return {value:bindings.get(node.name)};
  if (node.type === 'Literal' && !node.regex && typeof node.value !== 'bigint') return {value: node.value};
  if (node.type === 'TemplateLiteral' && !node.expressions.length) return {value: node.quasis[0].value.cooked};
  if (node.type === 'UnaryExpression' && ['-', '+'].includes(node.operator)) {
    const value = data(node.argument,bindings); return value && typeof value.value === 'number' ? {value: node.operator === '-' ? -value.value : value.value} : null;
  }
  if (node.type === 'ArrayExpression') {
    const values = node.elements.map((element: Ast | null) => element && data(element,bindings));
    return values.every((value): value is {value:unknown} => value!==null) ? {value: values.map(value => value.value)} : null;
  }
  if (node.type === 'ObjectExpression') {
    const value: Record<string, unknown> = {};
    for (const property of node.properties) {
      if (property.type !== 'Property' || property.kind !== 'init' || property.method || property.computed) return null;
      const key = property.key.type === 'Identifier' ? property.key.name : property.key.type === 'Literal' ? property.key.value : undefined;
      const entry = data(property.value,bindings);
      if (typeof key !== 'string' || Object.hasOwn(value, key) || !entry || key === '__proto__') return null;
      value[key] = entry.value;
    }
    return {value};
  }
  return null;
}
function operation(node: Ast, bindings = new Map<string, unknown>()): ToolProgramOperation | null {
  if (node.type === 'AwaitExpression') return operation(node.argument,bindings);
  if (node.type !== 'CallExpression' || node.optional || node.arguments.length !== 1) return null;
  const callee = node.callee;
  if (callee.type !== 'MemberExpression' || callee.computed || callee.optional || !identifier(callee.object, 'tools') || !identifier(callee.property)) return null;
  const input = data(node.arguments[0],bindings);
  return input && (typeof input.value === 'string' || (input.value && typeof input.value === 'object' && !Array.isArray(input.value)))
    ? {name: callee.property.name, input: input.value as Record<string, unknown> | string, forwarding: 'result',encoding:'native'} : null;
}
function calls(node: Ast, bindings = new Map<string, unknown>()): {operations: ToolProgramOperation[]; batch: boolean} | null {
  if (node.type !== 'AwaitExpression') return null;
  const call = node.argument;
  if (call.type === 'CallExpression' && !call.optional && call.arguments.length === 1
      && (member(call.callee, 'Promise', 'all') || member(call.callee, 'Promise', 'allSettled')) && call.arguments[0].type === 'ArrayExpression') {
    const settled = member(call.callee, 'Promise', 'allSettled');
    const operations = call.arguments[0].elements.map((element: Ast | null) => element && operation(element,bindings));
    return operations.length && operations.every((op): op is ToolProgramOperation => op!==null) ? {batch:true, operations: operations.map((op: ToolProgramOperation,index: number) => ({...op,index,...(settled ? {settled:true} : {})}))} : null;
  }
  const op = operation(node,bindings); return op ? {batch:false,operations:[op]} : null;
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
function pureDiscovery(node: Ast, locals = new Set<string>()): boolean {
  if (node.type === 'Literal') return true;
  if (identifier(node)) return node.name === 'ALL_TOOLS' || locals.has(node.name);
  if (node.type === 'MemberExpression') return !node.optional && pureDiscovery(node.object,locals) && (!node.computed || pureDiscovery(node.property,locals));
  if (node.type==='LogicalExpression' || node.type==='BinaryExpression') return pureDiscovery(node.left,locals) && pureDiscovery(node.right,locals);
  if (node.type === 'UnaryExpression') return ['!','typeof'].includes(node.operator) && pureDiscovery(node.argument,locals);
  if (node.type === 'ArrayExpression') return node.elements.every(entry=>Boolean(entry && pureDiscovery(entry,locals)));
  if (node.type === 'ObjectExpression') return node.properties.every((entry:Ast)=>entry.type==='Property' && !entry.computed && !entry.method && entry.kind==='init' && pureDiscovery(entry.value,locals));
  if (node.type === 'ArrowFunctionExpression' && !node.async && node.params.every((param:Ast)=>identifier(param))) {
    const names = new Set([...locals,...node.params.map((param:Identifier)=>param.name)]);
    return node.body.type!=='BlockStatement' && pureDiscovery(node.body,names);
  }
  if (node.type === 'CallExpression' && !node.optional && node.callee.type==='MemberExpression' && !node.callee.computed && identifier(node.callee.property)
    && ['filter','map','includes','test','toLowerCase','join'].includes(node.callee.property.name)) return pureDiscovery(node.callee.object,locals) && node.arguments.every((arg:Ast)=>pureDiscovery(arg,locals));
  return false;
}
function discoveryRoot(node:Ast):boolean {
  return node.type==='CallExpression' && node.callee.type==='MemberExpression' && !node.callee.computed && identifier(node.callee.property)
    && ['filter','map'].includes(node.callee.property.name) && (identifier(node.callee.object,'ALL_TOOLS') || discoveryRoot(node.callee.object));
}
function contentForwarding(statement:Ast,name:string):boolean {
  if(statement.type!=='ForOfStatement' || statement.await || statement.left.type!=='VariableDeclaration' || statement.left.kind!=='const' || statement.left.declarations.length!==1 || !identifier(statement.left.declarations[0].id) || !member(statement.right,name,'content')) return false;
  const item=statement.left.declarations[0].id.name;
  const branch=(node:Ast,kind?:string):boolean=>{
    if(node.type==='BlockStatement') return node.body.length===1 && branch(node.body[0],kind);
    if(node.type==='IfStatement') return node.test.type==='BinaryExpression' && ['===','=='].includes(node.test.operator) && member(node.test.left,item,'type') && node.test.right.type==='Literal' && typeof node.test.right.value==='string' && ['text','image','audio'].includes(node.test.right.value) && branch(node.consequent,String(node.test.right.value)) && (!node.alternate || branch(node.alternate));
    const call=node.type==='ExpressionStatement' && node.expression;
    if(!call || call.type!=='CallExpression' || call.optional || !identifier(call.callee) || call.arguments.length!==1) return false;
    return (kind==='text' && call.callee.name==='text' && member(call.arguments[0],item,'text')) || (kind===call.callee.name && ['image','audio'].includes(call.callee.name) && identifier(call.arguments[0],item));
  };
  return branch(statement.body);
}
/** Project only a complete static program whose outputs account for every call. Never execute provider source. */
export function projectToolProgram(name: string, input: Record<string, unknown> | string = {}, kind?: string): ToolProgram | null {
  if (!['exec','functions.exec'].includes(name.toLowerCase()) || (kind && kind !== 'custom_tool_call')) return null;
  const script = typeof input === 'string' ? input : input.code;
  if (typeof script !== 'string') return null;
  let program;
  try {program = parse(script,{ecmaVersion:'latest',sourceType:'module'});} catch {return null;}
  const discovery=program.body.length===2 && program.body[0].type==='VariableDeclaration' && program.body[0].kind==='const' && program.body[0].declarations.length===1 ? program.body[0].declarations[0] : null;
  if(discovery && identifier(discovery.id) && discovery.init && discoveryRoot(discovery.init) && pureDiscovery(discovery.init) && identifier(textValue(program.body[1] as Ast) ?? undefined,discovery.id.name)) return {operations:[{name:'__tool_discovery',input:{},forwarding:'result',encoding:'literal'}]};
  const operations: ToolProgramOperation[] = [];
  const bindings = new Map<string,unknown>();
  const names = new Set(['tools','text','image','audio','JSON','Promise','ALL_TOOLS']);
  for (let i=0;i<program.body.length;i++) {
    const statement = program.body[i] as Ast;
    if (statement.type === 'VariableDeclaration' && statement.kind === 'const' && statement.declarations.length === 1) {
      const declaration = statement.declarations[0];
      if (!identifier(declaration.id) || names.has(declaration.id.name) || !declaration.init) return null;
      names.add(declaration.id.name);
      const literal = data(declaration.init,bindings);
      if (literal) {bindings.set(declaration.id.name,literal.value);continue;}
      const batch = calls(declaration.init,bindings);
      const output = program.body[++i] as Ast | undefined;
      const mode = batch && output && (forwarding(output,declaration.id.name,batch.batch) || (!batch.batch && contentForwarding(output,declaration.id.name) ? {forwarding:'result' as const,encoding:'literal' as const} : null));
      if (!batch || !mode) return null;
      operations.push(...batch.operations.map(op=>({...op,...mode,...(batch.batch && !mode.indexKey ? {collection:i} : {})})));
    } else {
      let value = textValue(statement);
      const serialized=value?.type==='CallExpression' && !value.optional && member(value.callee,'JSON','stringify') && value.arguments.length===1;
      if(value?.type==='CallExpression' && !value.optional && member(value.callee,'JSON','stringify') && value.arguments.length===1) value=value.arguments[0];
      const stdout = value?.type === 'MemberExpression' && !value.computed && !value.optional && identifier(value.property,'output');
      const call = value && calls(stdout && value.type==='MemberExpression' ? value.object : value,bindings);
      if (!call || (call.batch && stdout)) return null;
      operations.push(...call.operations.map(op=>({...op,encoding:serialized || call.batch ? 'json' as const : stdout ? 'literal' as const : 'native' as const,forwarding:stdout ? 'stdout' as const : 'result' as const,...(call.batch ? {collection:i} : {})})));
    }
  }
  return operations.length ? {operations} : null;
}
