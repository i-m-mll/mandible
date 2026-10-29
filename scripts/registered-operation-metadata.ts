import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import * as ts from 'typescript';
import { isLocalCliCredential, type LocalCliCredential } from '../src/local-cli-credential.js';

export type RegisteredOperationMetadata = {
  file: string;
  localCliCredential: LocalCliCredential;
  method: 'get' | 'post' | 'put' | 'patch' | 'delete';
  path: string;
  effects: string[] | null;
  expression: string;
  operationId: string;
  operationalMutationCategory: string | null;
  requestSchema: "handler" | "zod";
};
const cache = new Map<string, RegisteredOperationMetadata[]>();

/** One authored-descriptor parser shared by full Router and lean UI fixtures. */
export function registeredOperationMetadata(files = fs.readdirSync('src/routes')
  .filter(name => name.endsWith('.ts')).map(name => path.join('src/routes', name))): RegisteredOperationMetadata[] {
  const sources = files.map(file => ({ file, source: fs.readFileSync(file, 'utf8') }));
  const key = createHash('sha256').update(JSON.stringify(sources)).digest('hex');
  const existing = cache.get(key);
  if (existing) return existing;
  let program: ts.Program | undefined;
  const typedCalls = new Map<string, Map<number, ts.CallExpression>>();
  const hasRegistrarSignature = (file: string, node: ts.CallExpression): boolean => {
    program ??= ts.createProgram(files, { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.NodeNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext, skipLibCheck: true });
    let calls = typedCalls.get(file);
    if (!calls) {
      calls = new Map();
      const typedTree = program.getSourceFile(file);
      if (!typedTree) throw new Error(`Missing route source: ${file}`);
      const collect = (entry: ts.Node): void => {
        if (ts.isCallExpression(entry)) calls!.set(entry.getStart(typedTree), entry);
        ts.forEachChild(entry, collect);
      };
      collect(typedTree);
      typedCalls.set(file, calls);
    }
    const call = calls.get(node.getStart());
    if (!call) throw new Error(`Missing typed route call: ${file}`);
    const checker = program.getTypeChecker();
    const options = checker.getResolvedSignature(call)?.parameters[2];
    if (!options) return false;
    const type = checker.getTypeOfSymbolAtLocation(options, call);
    return Boolean(type.getProperty('localCliCredential') && type.getProperty('operation') && type.getProperty('fileRpc'));
  };
  const entries: RegisteredOperationMetadata[] = [];
  for (const { file, source } of sources) {
    const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
    const property = (object: ts.ObjectLiteralExpression, name: string) => object.properties.find(
      (entry): entry is ts.PropertyAssignment => ts.isPropertyAssignment(entry) && entry.name.getText(tree) === name,
    )?.initializer;
    const visit = (node: ts.Node): void => {
      const method = ts.isCallExpression(node) && (ts.isPropertyAccessExpression(node.expression)
        ? node.expression.name.text : ts.isElementAccessExpression(node.expression)
          && ts.isStringLiteral(node.expression.argumentExpression) ? node.expression.argumentExpression.text : null);
      const routeMethod = method && ['get', 'post', 'put', 'patch', 'delete'].includes(method);
      const literalPath = ts.isCallExpression(node) && node.arguments[0]
        && ts.isStringLiteral(node.arguments[0]) && node.arguments[0].text.startsWith('/');
      const options = ts.isCallExpression(node) ? node.arguments[2] : undefined;
      const authoredOptions = options && ts.isObjectLiteralExpression(options)
        && (property(options, 'localCliCredential') || property(options, 'operation'));
      const typedRegistration = ts.isCallExpression(node) && node.arguments.length >= 3
        && !(routeMethod && literalPath) && !authoredOptions && hasRegistrarSignature(file, node);
      if (ts.isCallExpression(node) && (authoredOptions || typedRegistration)
          && (!routeMethod || !literalPath)) {
        throw new Error(`Nonliteral registered route: ${file}`);
      }
      if (ts.isCallExpression(node) && routeMethod && literalPath && ts.isStringLiteral(node.arguments[0])) {
        if (options && ts.isObjectLiteralExpression(options)) {
          const credential = property(options, 'localCliCredential');
          const localCliCredential: Record<string, unknown> = {};
          if (!credential || !ts.isObjectLiteralExpression(credential)) {
            throw new Error(`Missing literal CLI credential policy: ${file} ${node.arguments[0].text}`);
          }
          for (const field of credential.properties) {
            if (!ts.isPropertyAssignment(field) || !ts.isStringLiteral(field.initializer)
                || !(ts.isIdentifier(field.name) || ts.isStringLiteral(field.name))
                || Object.hasOwn(localCliCredential, field.name.text)) {
              throw new Error(`Nonserializable CLI credential policy: ${file} ${node.arguments[0].text}`);
            }
            localCliCredential[field.name.text] = field.initializer.text;
          }
          if (!isLocalCliCredential(localCliCredential)) throw new Error(`Invalid CLI credential policy: ${file} ${node.arguments[0].text}`);
          const operation = property(options, 'operation');
          const effects = operation && ts.isObjectLiteralExpression(operation) ? property(operation, 'effects') : undefined;
          if (!operation || !effects) throw new Error(`Missing authored operation descriptor: ${file} ${node.arguments[0].text}`);
          if (!ts.isArrayLiteralExpression(effects) && !ts.isArrowFunction(effects) && !ts.isFunctionExpression(effects)
              && !ts.isConditionalExpression(effects)) {
            throw new Error(`Unsupported authored route effects: ${file} ${node.arguments[0].text}`);
          }
          if (!ts.isObjectLiteralExpression(operation)) throw new Error(`Nonliteral operation descriptor: ${file}`);
          const id = property(operation, 'id');
          const category = property(operation, 'reportingCategory');
          const schema = property(operation, 'requestSchema');
          if (!id || !ts.isStringLiteral(id) || !category || (!ts.isStringLiteral(category) && category.kind !== ts.SyntaxKind.NullKeyword) || !schema) {
            throw new Error(`Unsupported authored operation metadata: ${file} ${node.arguments[0].text}`);
          }
          const staticEffects = ts.isArrayLiteralExpression(effects) ? effects.elements.map(value => {
            if (!ts.isStringLiteral(value)) throw new Error(`Nonliteral static route effect: ${file}`);
            return value.text;
          }) : null;
          entries.push({ file, localCliCredential, method: method as RegisteredOperationMetadata['method'],
            path: node.arguments[0].text, effects: staticEffects, expression: operation.getText(tree),
            operationId: id.text, operationalMutationCategory: ts.isStringLiteral(category) ? category.text : null,
            requestSchema: schema.kind === ts.SyntaxKind.NullKeyword ? 'handler' : 'zod' });
        } else throw new Error(`Nonliteral route options: ${file} ${node.arguments[0].text}`);
      }
      ts.forEachChild(node, visit);
    };
    visit(tree);
  }
  cache.set(key, entries);
  return entries;
}
