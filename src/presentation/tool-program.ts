import { parse, type AnyNode, type Identifier } from 'acorn';

type Ast = AnyNode;
const GLOBAL_BINDINGS=new Set(['tools','text','image','audio','JSON','Promise','ALL_TOOLS','Object','Array','String','Number','Boolean']);
export type ToolEmissionEncoding = 'literal' | 'json' | 'native';
export type ToolProgramOperation = { encoding:ToolEmissionEncoding; name: string; input: Record<string, unknown> | string | undefined; emission?:number; resultPath?:Array<string|number>; collectionPath?:Array<string|number>; resultTransformed?:boolean; forwarding: 'result' | 'stdout' | 'direct'; index?: number; indexKey?: string; resultKey?: string; collection?: number; settled?: boolean };
export type ToolProgram = { operations: ToolProgramOperation[]; outputAttributed?:boolean;effectsComplete?:false };
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
function operation(node: Ast, bindings = new Map<string, unknown>(), pure?:(node:Ast,scope?:ReadonlyMap<string,unknown>)=>boolean): ToolProgramOperation | null {
  if (node.type === 'AwaitExpression') return operation(node.argument,bindings,pure);
  if (node.type !== 'CallExpression' || node.optional || node.arguments.length !== 1) return null;
  const callee = node.callee;
  if(callee.type==='MemberExpression'&&!callee.computed&&identifier(callee.property)&&['then','catch'].includes(callee.property.name)&&pure?.(node.arguments[0],bindings)){const original=operation(callee.object,bindings,pure);return original?{...original,resultTransformed:true}:null;}
  if (callee.type !== 'MemberExpression' || callee.computed || callee.optional || !identifier(callee.object, 'tools') || !identifier(callee.property)) return null;
  const input = data(node.arguments[0],bindings);
  return input && (typeof input.value === 'string' || (input.value && typeof input.value === 'object' && !Array.isArray(input.value)))
    ? {name: callee.property.name, input: input.value as Record<string, unknown> | string, forwarding: 'result',encoding:'native'} : pure?.(node.arguments[0],bindings)?{name:callee.property.name,input:undefined,forwarding:'result',encoding:'native'}:null;
}
function bindPattern(pattern:Ast,value:unknown,bindings:Map<string,unknown>):boolean {
  if(identifier(pattern)){if(GLOBAL_BINDINGS.has(pattern.name))return false;bindings.set(pattern.name,value);return true;}
  if(pattern.type==='ArrayPattern'&&Array.isArray(value)&&pattern.elements.length===value.length)return pattern.elements.every((entry:Ast|null,index:number)=>entry&&bindPattern(entry,value[index],bindings));
  if(pattern.type==='ObjectPattern'&&value&&typeof value==='object')return pattern.properties.every((entry:Ast)=>entry.type==='Property'&&!entry.computed&&entry.kind==='init'&&identifier(entry.key)&&Object.hasOwn(value,entry.key.name)&&bindPattern(entry.value,(value as Record<string,unknown>)[entry.key.name],bindings));
  return false;
}
function calls(node:Ast,bindings=new Map<string,unknown>(),pure?:(node:Ast,scope?:ReadonlyMap<string,unknown>)=>boolean):{operations:ToolProgramOperation[];batch:boolean}|null {
  if(node.type!=='AwaitExpression')return null;
  const call=node.argument;
  if(call.type==='CallExpression'&&!call.optional&&call.arguments.length===1&&(member(call.callee,'Promise','all')||member(call.callee,'Promise','allSettled'))) {
    const settled=member(call.callee,'Promise','allSettled');
    const collection=call.arguments[0];
    const entries:Array<{node:Ast;bindings:Map<string,unknown>}> = [];
    if(collection.type==='ArrayExpression'){for(const entry of collection.elements){if(!entry)return null;entries.push({node:entry,bindings});}}
    else if(collection.type==='CallExpression'&&!collection.optional&&collection.callee.type==='MemberExpression'&&!collection.callee.computed&&identifier(collection.callee.property,'map')&&collection.arguments.length===1) {
      const items=data(collection.callee.object,bindings),callback=collection.arguments[0];
      if(!items||!Array.isArray(items.value)||items.value.length>256||callback.type!=='ArrowFunctionExpression'||callback.params.length!==1)return null;
      const body=callback.body.type==='BlockStatement'&&callback.body.body.length===1&&callback.body.body[0].type==='ReturnStatement'?callback.body.body[0].argument:callback.body;
      if(!body)return null;
      for(const value of items.value){const scoped=new Map(bindings);if(!bindPattern(callback.params[0],value,scoped))return null;entries.push({node:body,bindings:scoped});}
    }else return null;
    const operations:ToolProgramOperation[]=[];
    const returned=(node:Ast,scope:Map<string,unknown>,path:Array<string|number>):boolean=>{
      const op=operation(node,scope,pure);
      if(op){operations.push({...op,index:Number(path[0]),collectionPath:path,...(settled?{settled:true}:{})});return operations.length<=256;}
      if(data(node,scope))return true;
      if(node.type==='ArrayExpression')return node.elements.every((entry:Ast|null,index:number)=>entry&&returned(entry,scope,[...path,index]));
      if(node.type==='ObjectExpression')return node.properties.every((entry:Ast)=>entry.type==='Property'&&!entry.computed&&entry.kind==='init'&&!entry.method&&identifier(entry.key)&&returned(entry.value,scope,[...path,entry.key.name]));
      return false;
    };
    for(const [index,entry] of entries.entries())if(!returned(entry.node,entry.bindings,[index]))return null;
    return operations.length?{batch:true,operations}:null;
  }
  const op=operation(node,bindings,pure);return op?{batch:false,operations:[op]}:null;
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
    && ['filter','map','slice','includes','test','toLowerCase','join'].includes(node.callee.property.name)) return pureDiscovery(node.callee.object,locals) && node.arguments.every((arg:Ast)=>pureDiscovery(arg,locals));
  return false;
}
function discoveryRoot(node:Ast, collections:ReadonlySet<string> = new Set(['ALL_TOOLS'])):boolean {
  return node.type==='CallExpression' && node.callee.type==='MemberExpression' && !node.callee.computed && identifier(node.callee.property)
    && ['filter','map','slice'].includes(node.callee.property.name) && ((identifier(node.callee.object) && collections.has(node.callee.object.name)) || discoveryRoot(node.callee.object,collections));
}
function discoveryProgram(statements:readonly Ast[]):boolean {
  const collections=new Set(['ALL_TOOLS']);
  const emitters=new Set(['text']);
  const names=new Set(['ALL_TOOLS','text','tools','image','audio','JSON','Promise']);
  let discovered=false;
  for(const statement of statements.slice(0,-1)) {
    if(statement.type!=='VariableDeclaration' || statement.kind!=='const' || statement.declarations.length!==1) return false;
    const declaration=statement.declarations[0];
    if(!identifier(declaration.id) || names.has(declaration.id.name) || !declaration.init) return false;
    names.add(declaration.id.name);
    if(identifier(declaration.init) && collections.has(declaration.init.name)) collections.add(declaration.id.name);
    else if(identifier(declaration.init) && emitters.has(declaration.init.name)) emitters.add(declaration.id.name);
    else if(discoveryRoot(declaration.init,collections) && pureDiscovery(declaration.init,collections)) {collections.add(declaration.id.name);discovered=true;}
    else return false;
  }
  if(!discovered) return false;
  const output=statements.at(-1);
  if(output?.type!=='ExpressionStatement' || output.expression.type!=='CallExpression' || output.expression.optional || output.expression.arguments.length!==1) return false;
  const call=output.expression;
  if(identifier(call.callee) && emitters.has(call.callee.name)) return identifier(call.arguments[0]) && collections.has(call.arguments[0].name);
  if(call.callee.type!=='MemberExpression' || call.callee.computed || call.callee.optional || !((identifier(call.callee.object)&&collections.has(call.callee.object.name))||(discoveryRoot(call.callee.object,collections)&&pureDiscovery(call.callee.object,collections))) || !identifier(call.callee.property,'forEach')) return false;
  const callback=call.arguments[0];
  if(callback.type!=='ArrowFunctionExpression' || callback.async || callback.params.length!==1 || !identifier(callback.params[0]) || emitters.has(callback.params[0].name)) return false;
  const body=callback.body.type==='BlockStatement' && callback.body.body.length===1 ? callback.body.body[0] : callback.body;
  const emission=body.type==='ExpressionStatement' ? body.expression : body;
  return emission.type==='CallExpression' && !emission.optional && identifier(emission.callee) && emitters.has(emission.callee.name) && emission.arguments.length===1 && identifier(emission.arguments[0],callback.params[0].name);
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
function optionalContent(node:Ast,name:string):boolean {
  const value=node.type==='ChainExpression' ? node.expression : node;
  return value.type==='MemberExpression' && !value.computed && identifier(value.object,name) && identifier(value.property,'content');
}
function fallbackContentForwarding(loop:Ast,fallback:Ast | undefined,name:string):boolean {
  if(loop.type!=='ForOfStatement' || loop.await || loop.left.type!=='VariableDeclaration' || loop.left.kind!=='const' || loop.left.declarations.length!==1 || !identifier(loop.left.declarations[0].id)) return false;
  const content=loop.right;
  if(content.type!=='LogicalExpression' || content.operator!=='??' || !optionalContent(content.left,name) || content.right.type!=='ArrayExpression' || content.right.elements.length) return false;
  const item=loop.left.declarations[0].id.name;
  const body=loop.body.type==='BlockStatement' && loop.body.body.length===1 ? loop.body.body[0] : loop.body;
  const conditional=body.type==='ExpressionStatement' && body.expression;
  if(!conditional || conditional.type!=='ConditionalExpression' || conditional.test.type!=='BinaryExpression' || conditional.test.operator!=='===' || !member(conditional.test.left,item,'type') || conditional.test.right.type!=='Literal' || conditional.test.right.value!=='image') return false;
  const image=conditional.consequent;
  const text=conditional.alternate;
  if(image.type!=='CallExpression' || image.optional || !identifier(image.callee,'image') || image.arguments.length!==1 || !identifier(image.arguments[0],item)
    || text.type!=='CallExpression' || text.optional || !identifier(text.callee,'text') || text.arguments.length!==1) return false;
  const value=text.arguments[0];
  if(value.type!=='LogicalExpression' || value.operator!=='??' || !member(value.left,item,'text') || !identifier(value.right,item)) return false;
  if(fallback?.type!=='IfStatement' || fallback.alternate || fallback.test.type!=='UnaryExpression' || fallback.test.operator!=='!' || !optionalContent(fallback.test.argument,name)) return false;
  const result=fallback.consequent.type==='BlockStatement' && fallback.consequent.body.length===1 ? fallback.consequent.body[0] : fallback.consequent;
  return identifier(textValue(result) ?? undefined,name);
}
type ResultReference={indices:number[];batch:boolean;paths?:Array<Array<string|number>>};
/** Recover unconditional tool effects and transparent output provenance without evaluating source. */
export function projectToolProgram(name:string,input:Record<string,unknown>|string={},kind?:string):ToolProgram|null {
  if(!['exec','functions.exec'].includes(name.toLowerCase())||(kind&&kind!=='custom_tool_call'))return null;
  const script=typeof input==='string'?input:input.code;
  if(typeof script!=='string')return null;
  let program;try{program=parse(script,{ecmaVersion:'latest',sourceType:'module'});}catch{return null;}
  if(program.body.some(statement=>statement.type==='FunctionDeclaration'&&statement.id&&GLOBAL_BINDINGS.has(statement.id.name)))return null;
  if(program.body.some(statement=>statement.type==='VariableDeclaration'&&statement.declarations.some(declaration=>identifier(declaration.id)&&GLOBAL_BINDINGS.has(declaration.id.name))))return null;
  if(discoveryProgram(program.body))return {operations:[{name:'__tool_discovery',input:{},forwarding:'result',encoding:'literal'}]};
  const operations:ToolProgramOperation[]=[];
  let emissions=0,opaque=false;
  const analyze=(statements:readonly Ast[],environment:{bindings:Map<string,unknown>;references:Map<string,ResultReference>;names:Set<string>;values:Set<string>;mutable:Set<string>}):boolean=>{
  const {bindings,references,names,values,mutable}=environment;
  const pure=(node:Ast,locals:ReadonlySet<string>=values):boolean=>{
    if(node.type==='Literal')return !node.regex;
    if(identifier(node))return locals.has(node.name)||['undefined','NaN','Infinity'].includes(node.name);
    if(node.type==='ChainExpression')return pure(node.expression,locals);
    if(node.type==='MemberExpression')return pure(node.object,locals)&&(!node.computed||pure(node.property,locals));
    if(node.type==='TemplateLiteral')return node.expressions.every((entry:Ast)=>pure(entry,locals));
    if(node.type==='BinaryExpression'||node.type==='LogicalExpression')return pure(node.left,locals)&&pure(node.right,locals);
    if(node.type==='UnaryExpression')return ['!','+','-','typeof','void'].includes(node.operator)&&pure(node.argument,locals);
    if(node.type==='ConditionalExpression')return pure(node.test,locals)&&pure(node.consequent,locals)&&pure(node.alternate,locals);
    if(node.type==='ArrayExpression')return node.elements.every((entry:Ast|null)=>entry&&pure(entry,locals));
    if(node.type==='ObjectExpression')return node.properties.every((entry:Ast)=>entry.type==='SpreadElement'?pure(entry.argument,locals):entry.type==='Property'&&entry.kind==='init'&&!entry.method&&(!entry.computed||pure(entry.key,locals))&&pure(entry.value,locals));
    if(node.type==='ArrowFunctionExpression'&&!node.async&&node.params.every((param:Ast)=>identifier(param))) {
      const scoped=new Set([...locals,...node.params.map((param:Identifier)=>param.name)]);
      return node.body.type==='BlockStatement'?pureOutputStatement(node.body,scoped,new Set()):pure(node.body,scoped);
    }
    if(node.type==='CallExpression'&&!node.optional&&identifier(node.callee)&&['String','Number','Boolean'].includes(node.callee.name))return node.arguments.every((entry:Ast)=>pure(entry,locals));
    if(node.type==='CallExpression'&&!node.optional&&node.callee.type==='MemberExpression'&&!node.callee.computed&&identifier(node.callee.property)) {
      const builtin=(identifier(node.callee.object,'JSON')&&['parse','stringify'].includes(node.callee.property.name))
        ||(identifier(node.callee.object,'Object')&&['keys','values','entries','fromEntries'].includes(node.callee.property.name))
        ||(identifier(node.callee.object,'Array')&&node.callee.property.name==='isArray');
      return (builtin||(['map','flatMap','at','filter','find','findIndex','some','every','slice','includes','join','trim','toLowerCase','toUpperCase','startsWith','endsWith','substring','split'].includes(node.callee.property.name)&&pure(node.callee.object,locals)))&&node.arguments.every((entry:Ast)=>pure(entry,locals));
    }
    return false;
  };
  const append=(node:Ast):ResultReference|null=>{
    const batch=calls(node,bindings,(entry,scope)=>pure(entry,new Set([...values,...(scope?.keys()??[])]))); if(!batch)return null;
    if(operations.length+batch.operations.length>256)return null;
    const indices=batch.operations.map(op=>{const index=operations.length;operations.push(op);return index;});
    return {indices,batch:batch.batch,paths:batch.operations.map((op,index)=>op.collectionPath??[index])};
  };
  const assign=(reference:ResultReference,emission:number,path:Array<string|number>,mode:{encoding:ToolEmissionEncoding;forwarding:'result'|'stdout'})=>{
    reference.indices.forEach((index,offset)=>{const op=operations[index];if(op.emission!==undefined)opaque=true;
      Object.assign(op,mode,{emission,resultPath:reference.batch?[...path,...(reference.paths?.[offset]??[offset])]:path});});
  };
  const output=(node:Ast,emission:number,path:Array<string|number>=[],encoding:ToolEmissionEncoding='native'):boolean=>{
    if(identifier(node)&&references.has(node.name)){assign(references.get(node.name)!,emission,path,{encoding,forwarding:'result'});return true;}
    if(node.type==='AwaitExpression'){const ref=append(node);if(ref){assign(ref,emission,path,{encoding,forwarding:'result'});return true;}return false;}
    if(node.type==='MemberExpression'&&!node.computed&&node.object.type==='AwaitExpression'&&identifier(node.property,'output')){const ref=append(node.object);if(!ref||ref.batch)return false;assign(ref,emission,path,{encoding:encoding==='json'?'json':'literal',forwarding:'stdout'});return true;}
    if(node.type==='MemberExpression'&&!node.computed&&identifier(node.object)&&references.has(node.object.name)&&identifier(node.property,'output')){const ref=references.get(node.object.name)!;if(ref.batch)return false;assign(ref,emission,path,{encoding:encoding==='json'?'json':'literal',forwarding:'stdout'});return true;}
    if(node.type==='CallExpression'&&!node.optional&&member(node.callee,'JSON','stringify')&&node.arguments.length===1)return output(node.arguments[0],emission,path,'json');
    if(node.type==='ObjectExpression')return node.properties.every((entry:Ast)=>{if(entry.type!=='Property'||entry.computed||entry.kind!=='init'||entry.method)return false;const key=entry.key.type==='Identifier'?entry.key.name:entry.key.type==='Literal'?entry.key.value:null;return typeof key==='string'&&output(entry.value,emission,[...path,key],'json');});
    if(node.type==='ArrayExpression')return node.elements.every((entry:Ast|null,index:number)=>entry&&output(entry,emission,[...path,index],'json'));
    return false;
  };
  const pureOutputStatement=(node:Ast,locals:Set<string>=values,mutableLocals:Set<string>=mutable):boolean=>{
    if(node.type==='EmptyStatement')return true;
    if(node.type==='ReturnStatement')return !node.argument||pure(node.argument,locals);
    if(node.type==='ForStatement'){const scope=new Set(locals),assignable=new Set(mutableLocals);return (!node.init||pureOutputStatement(node.init,scope,assignable))&&(!node.test||pure(node.test,scope))&&(!node.update||(node.update.type==='UpdateExpression'&&identifier(node.update.argument)&&assignable.has(node.update.argument.name)))&&pureOutputStatement(node.body,scope,assignable);}
    if(node.type==='BlockStatement'){const scope=new Set(locals),assignable=new Set(mutableLocals);return node.body.every((entry:Ast)=>pureOutputStatement(entry,scope,assignable));}
    if(node.type==='VariableDeclaration'&&['const','let'].includes(node.kind))return node.declarations.every(entry=>{if(!identifier(entry.id)||!entry.init||!pure(entry.init,locals))return false;locals.add(entry.id.name);if(node.kind==='let')mutableLocals.add(entry.id.name);return true;});
    if(node.type==='IfStatement')return pure(node.test,locals)&&pureOutputStatement(node.consequent,locals,mutableLocals)&&(!node.alternate||pureOutputStatement(node.alternate,locals,mutableLocals));
    if(node.type==='TryStatement'){const scope=new Set(locals);if(node.handler?.param){if(!identifier(node.handler.param))return false;scope.add(node.handler.param.name);}return pureOutputStatement(node.block,locals,mutableLocals)&&(!node.handler||pureOutputStatement(node.handler.body,scope,mutableLocals))&&(!node.finalizer||pureOutputStatement(node.finalizer,locals,mutableLocals));}
    if(node.type==='ForOfStatement'&&!node.await&&pure(node.right,locals)&&node.left.type==='VariableDeclaration'&&node.left.kind==='const'&&node.left.declarations.length===1){const pattern=node.left.declarations[0].id;const ids=identifier(pattern)?[pattern]:pattern.type==='ArrayPattern'?pattern.elements:[];if(!ids.length||ids.some((entry:Ast|null)=>!entry||!identifier(entry)))return false;const scope=new Set(locals);for(const id of ids as Identifier[])scope.add(id.name);return pureOutputStatement(node.body,scope,new Set(mutableLocals));}
    if(node.type==='ExpressionStatement'){
      const expression=node.expression;
      if(expression.type==='AssignmentExpression'&&expression.operator==='='&&identifier(expression.left)&&mutableLocals.has(expression.left.name))return pure(expression.right,locals);
      if(expression.type==='CallExpression'&&!expression.optional&&expression.callee.type==='MemberExpression'&&!expression.callee.computed&&identifier(expression.callee.property,'forEach')&&pure(expression.callee.object,locals)&&expression.arguments.length===1) {
        const callback=expression.arguments[0];if(callback.type!=='ArrowFunctionExpression'||callback.async||!callback.params.every((param:Ast)=>identifier(param)))return false;
        const scope=new Set(locals);for(const param of callback.params as Identifier[])scope.add(param.name);
        return pureOutputStatement(callback.body.type==='BlockStatement'?callback.body:{...callback.body,type:'ExpressionStatement',expression:callback.body} as Ast,scope,new Set(mutableLocals));
      }
      return expression.type==='CallExpression'&&!expression.optional&&identifier(expression.callee)&&['text','image','audio'].includes(expression.callee.name)&&expression.arguments.length===1&&pure(expression.arguments[0],locals);
    }
    return false;
  };
  for(let index=0;index<statements.length;index++) {
    const statement=statements[index] as Ast;
    if(statement.type==='FunctionDeclaration'&&statement.id&&!names.has(statement.id.name)){names.add(statement.id.name);continue;}
    if(statement.type==='ForOfStatement'&&!statement.await&&statement.left.type==='VariableDeclaration'&&statement.left.kind==='const'&&statement.left.declarations.length===1) {
      const collection=data(statement.right,bindings);
      if(collection&&Array.isArray(collection.value)&&collection.value.length<=256) {
        for(const value of collection.value){const scoped={bindings:new Map(bindings),references:new Map(references),names:new Set(names),values:new Set(values),mutable:new Set(mutable)};
          if(!bindPattern(statement.left.declarations[0].id,value,scoped.bindings))return false;
          for(const key of scoped.bindings.keys()){scoped.names.add(key);scoped.values.add(key);}
          if(!analyze(statement.body.type==='BlockStatement'?statement.body.body:[statement.body],scoped))return false;
        }continue;
      }
    }
    if(statement.type==='VariableDeclaration'&&['const','let'].includes(statement.kind)) {
      for(const declaration of statement.declarations) {
        if(!declaration.init)return false;
        const ids=identifier(declaration.id)?[declaration.id]:declaration.id.type==='ArrayPattern'?declaration.id.elements:[];
        if(!ids.length||ids.some((id:Ast|null)=>!id||!identifier(id)||names.has(id.name)))return false;
        const literal=data(declaration.init,bindings);
        const ref=literal?null:append(declaration.init);
        if(!literal&&!ref&&!pure(declaration.init))return false;
        if(ids.length>1&&(!ref?.batch||ids.length!==ref.indices.length))return false;
        ids.forEach((pattern,offset:number)=>{const id=pattern as Identifier;names.add(id.name);values.add(id.name);
          if(literal&&statement.kind==='const')bindings.set(id.name,literal.value);
          if(statement.kind==='let')mutable.add(id.name);
          if(ref)references.set(id.name,declaration.id.type==='ArrayPattern'?{indices:[ref.indices[offset]],batch:false}:ref);
          else if(identifier(declaration.init??undefined)&&references.has((declaration.init as Identifier).name))references.set(id.name,references.get((declaration.init as Identifier).name)!);
        });
      }
      continue;
    }
    const value=textValue(statement);
    if(value) {
      const emission=emissions++;
      if(!output(value,emission)){if(!pure(value))return false;opaque=true;}
      continue;
    }
    if(statement.type==='ExpressionStatement'&&statement.expression.type==='AwaitExpression') {if(!append(statement.expression))return false;continue;}
    let forwarded=false;
    for(const [name,ref] of references) {
      const mode=forwarding(statement,name,ref.batch);
      if(mode&&ref.batch) {
        ref.indices.forEach((operationIndex,offset)=>{const op=operations[operationIndex];if(op.emission!==undefined)opaque=true;Object.assign(op,mode,{emission:emissions+offset,resultPath:[]});});emissions+=ref.indices.length;forwarded=true;break;
      }
      const fallback=!ref.batch&&fallbackContentForwarding(statement,statements[index+1] as Ast|undefined,name);
      if(!ref.batch&&(contentForwarding(statement,name)||fallback)) {
        assign(ref,emissions++,[],{forwarding:'result',encoding:'literal'});if(fallback)index++;forwarded=true;break;
      }
    }
    if(forwarded)continue;
    if(pureOutputStatement(statement)){opaque=true;continue;}
    return false;
  }
  return true;
  };
  const complete=analyze(program.body,{bindings:new Map(),references:new Map(),names:new Set(GLOBAL_BINDINGS),values:new Set(),mutable:new Set()});
  return operations.length?{operations,...(!complete?{effectsComplete:false as const}:{}),outputAttributed:complete&&!opaque&&operations.every(op=>op.emission!==undefined&&!op.resultTransformed)}:null;
}
