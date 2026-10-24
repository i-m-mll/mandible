// Find daemon source that lets a child process write to the daemon's own
// stdout or stderr. The daemon rotates those files by copying and truncating
// them, and only its rotating thread may write to them (docs/runtime-handoff.md).
import ts from 'typescript';

const STD_STREAMS = new Set(['process.stdout', 'process.stderr']);

function inherits(node) {
  if (ts.isStringLiteralLike(node) && node.text === 'inherit') return '"inherit"';
  if (ts.isNumericLiteral(node) && (node.text === '1' || node.text === '2')) return `fd ${node.text}`;
  if (ts.isPropertyAccessExpression(node) && STD_STREAMS.has(node.getText())) return node.getText();
  return null;
}

function propertyName(node) {
  return node.name && (ts.isIdentifier(node.name) || ts.isStringLiteralLike(node.name)) ? node.name.text : null;
}

const CHILD_PROCESS = /^(?:node:)?child_process$/;

function unwrap(node) {
  while (ts.isParenthesizedExpression(node) || ts.isAwaitExpression(node) || ts.isAsExpression(node)
    || ts.isTypeAssertionExpression(node) || ts.isNonNullExpression(node) || ts.isSatisfiesExpression(node)) node = node.expression;
  return node;
}

function memberName(node) {
  if (ts.isPropertyAccessExpression(node)) return node.name.text;
  if (ts.isElementAccessExpression(node) && ts.isStringLiteralLike(node.argumentExpression)) return node.argumentExpression.text;
  return null;
}

/**
 * The names a file binds to the child_process module and to its `fork`, across
 * ESM imports, `import x = require(…)`, `require(…)`, `await import(…)`,
 * destructuring and local aliases. Bindings are resolved per file, not per
 * scope, which can only over-report.
 */
function childProcessBindings(file) {
  const modules = new Set();
  const forks = new Set();
  const isModule = node => {
    node = unwrap(node);
    if (ts.isIdentifier(node)) return modules.has(node.text);
    return ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === 'require'))
      && node.arguments.length > 0 && ts.isStringLiteralLike(node.arguments[0]) && CHILD_PROCESS.test(node.arguments[0].text);
  };
  const isFork = node => {
    node = unwrap(node);
    if (ts.isIdentifier(node)) return forks.has(node.text);
    return memberName(node) === 'fork' && isModule(node.expression);
  };
  const bindPattern = (pattern, source) => {
    if (!isModule(source)) return;
    for (const element of pattern.elements) {
      const key = element.propertyName ?? element.name;
      if ((ts.isIdentifier(key) || ts.isStringLiteralLike(key)) && key.text === 'fork' && ts.isIdentifier(element.name)) forks.add(element.name.text);
    }
  };
  const declarations = [];
  const collect = node => {
    if (ts.isVariableDeclaration(node) && node.initializer) declarations.push(node);
    ts.forEachChild(node, collect);
  };
  collect(file);
  for (let size = -1; size !== modules.size + forks.size;) {
    size = modules.size + forks.size;
    for (const statement of file.statements) {
      if (ts.isImportEqualsDeclaration(statement) && ts.isExternalModuleReference(statement.moduleReference)
          && ts.isStringLiteralLike(statement.moduleReference.expression) && CHILD_PROCESS.test(statement.moduleReference.expression.text)) modules.add(statement.name.text);
      if (!ts.isImportDeclaration(statement) || !ts.isStringLiteralLike(statement.moduleSpecifier) || !CHILD_PROCESS.test(statement.moduleSpecifier.text)) continue;
      const clause = statement.importClause;
      if (clause?.name) modules.add(clause.name.text);
      const bindings = clause?.namedBindings;
      if (bindings && ts.isNamespaceImport(bindings)) modules.add(bindings.name.text);
      if (bindings && ts.isNamedImports(bindings)) for (const element of bindings.elements) if ((element.propertyName ?? element.name).text === 'fork') forks.add(element.name.text);
    }
    for (const declaration of declarations) {
      if (ts.isIdentifier(declaration.name)) {
        if (isModule(declaration.initializer)) modules.add(declaration.name.text);
        if (isFork(declaration.initializer)) forks.add(declaration.name.text);
      } else if (ts.isObjectBindingPattern(declaration.name)) bindPattern(declaration.name, declaration.initializer);
    }
  }
  return { isFork };
}

/** Each site in one source file, as `{ line, reason }`, with 1-based lines. */
export function stderrInheritanceSites(fileName, source) {
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, fileName.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const { isFork } = childProcessBindings(file);
  const sites = [];
  const report = (node, reason) => sites.push({ line: file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1, reason });
  const visit = node => {
    if (ts.isStringLiteralLike(node) && node.text === 'inherit') report(node, '"inherit"');
    if (ts.isPropertyAssignment(node)) {
      const name = propertyName(node);
      const value = node.initializer;
      if (name === 'stdio' && ts.isArrayLiteralExpression(value)) {
        value.elements.slice(1, 3).forEach(element => { const reason = inherits(element); if (reason && reason !== '"inherit"') report(element, `stdio passes ${reason}`); });
      }
      if (name === 'stdout' || name === 'stderr') {
        const reason = inherits(value);
        if (reason && reason !== '"inherit"') report(value, `${name} passes ${reason}`);
      }
    }
    if (ts.isCallExpression(node)) {
      const callee = node.expression.getText(file);
      if (callee === 'Bun.spawn' || callee === 'Bun.spawnSync') report(node, `${callee} inherits stderr by default`);
      if (isFork(node.expression)) report(node, 'fork inherits stdio by default');
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return sites;
}
