const fs = require('node:fs');
const path = require('node:path');

function validateNode(node) {
  if (!node || typeof node !== 'object') return false;
  switch (node.kind) {
    case 'sequence': case 'choice': return Array.isArray(node.items) && node.items.every(validateNode);
    case 'optional': return validateNode(node.item);
    case 'repeat': return Number.isInteger(node.min) && node.min >= 0 && validateNode(node.item);
    case 'argument': return typeof node.name === 'string' && node.name.length > 0 && node.value
      && ['string', 'integer', 'enum', 'literal'].includes(node.value.type)
      && (node.value.type !== 'enum' || (Array.isArray(node.value.values) && node.value.values.length > 0));
    case 'option': return Array.isArray(node.names) && node.names.length > 0
      && node.names.every(name => /^--?[a-z][a-z0-9-]*$/.test(name))
      && Array.isArray(node.values) && node.values.every(value => value.kind === 'argument' && validateNode(value));
    default: return false;
  }
}

function loadCommands(file = path.join(__dirname, 'command-syntax.json')) {
  const registry = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (registry.schema_version !== 2 || !registry.commands || Array.isArray(registry.commands)) {
    throw new Error('Invalid CLI grammar registry; expected schema version 2');
  }
  for (const [key, entry] of Object.entries(registry.commands)) {
    if (!/^[a-z][a-z0-9.-]*$/.test(key) || !entry || Object.keys(entry).sort().join() !== 'grammar,route'
      || !Array.isArray(entry.route) || entry.route.length === 0
      || entry.route.some(part => !/^[a-z][a-z-]*(\|[a-z][a-z-]*)*$/.test(part))
      || !validateNode(entry.grammar)) throw new Error(`Invalid CLI grammar definition: ${key}`);
  }
  return registry.commands;
}

function renderNode(node) {
  switch (node.kind) {
    case 'sequence': return node.items.map(renderNode).join(' ');
    case 'choice': return '(' + node.items.map(renderNode).join(' | ') + ')';
    case 'optional': return `[${renderNode(node.item)}]`;
    case 'repeat': return `${node.min === 0 ? '[' + renderNode(node.item) + ']' : renderNode(node.item)}...`;
    case 'argument': return `<${node.name}>`;
    case 'option': return node.names.join('|') + (node.values.length ? ' ' + node.values.map(renderNode).join(' ') : '');
    default: throw new Error('Invalid grammar node');
  }
}
function commandSyntax(key, commands = loadCommands()) {
  if (!Object.hasOwn(commands, key)) throw new Error(`Unknown command insertion: ${key}`);
  const entry = commands[key];
  return `mandible ${entry.route.join(' ')}${entry.grammar.items?.length === 0 ? '' : ' ' + renderNode(entry.grammar)}`;
}
function renderCommands(source, { markdown = true, commands = loadCommands() } = {}) {
  const result = source.replace(/\{\{command ([a-z][a-z0-9.-]*)\}\}/g, (_, key) => {
    const syntax = commandSyntax(key, commands);
    return markdown ? `\`${syntax}\`` : syntax;
  });
  if (result.includes('{{') || result.includes('}}')) throw new Error('Unknown or malformed command insertion');
  return result;
}
function help(route, commands = loadCommands()) {
  const matches = Object.entries(commands).filter(([, entry]) =>
    route.every((part, index) => entry.route[index]?.split('|').includes(part)));
  if (!matches.length) throw new Error(`Unknown command: ${route.join(' ')}`);
  return `Usage:\n${matches.map(([key]) => `  ${commandSyntax(key, commands)}`).join('\n')}\n`;
}
function walk(node, fn) {
  fn(node);
  if (node.items) node.items.forEach(item => walk(item, fn));
  if (node.item) walk(node.item, fn);
}
function validValue(spec, value) {
  if (value === undefined || value === '') return false;
  if (spec.type === 'enum') return spec.values.includes(value);
  if (spec.type === 'literal') return value === spec.value;
  if (spec.type === 'integer') return /^\d+$/.test(value) && Number.isSafeInteger(Number(value))
    && (spec.min === undefined || Number(value) >= spec.min) && (spec.max === undefined || Number(value) <= spec.max);
  return true;
}
function parseEntry(key, argv, commands = loadCommands()) {
  const entry = commands[key];
  if (!entry) throw new Error(`Unknown command: ${key}`);
  const specs = new Map();
  walk(entry.grammar, node => {
    if (node.kind === 'option') for (const name of node.names) {
      if (specs.has(name) && JSON.stringify(specs.get(name)) !== JSON.stringify(node.values)) {
        throw new Error(`Conflicting option grammar: ${key} ${name}`);
      }
      specs.set(name, node.values);
    }
  });
  const options = new Map(), positional = [], optionOccurrences = [];
  let literal = false;
  for (let index = 0; index < argv.length; index++) {
    let token = argv[index];
    if (!literal && token === '--') { literal = true; continue; }
    if (!literal && token.startsWith('-') && token !== '-') {
      const equal = token.indexOf('=');
      const name = equal < 0 ? token : token.slice(0, equal);
      const spec = specs.get(name);
      if (!spec) throw new Error(`Unknown option: ${name}`);
      if (equal >= 0 && spec.length !== 1) throw new Error(`Option ${name} does not accept an inline value`);
      const values = [];
      for (let v = 0; v < spec.length; v++) {
        const value = equal >= 0 ? token.slice(equal + 1) : argv[++index];
        if (value === undefined || (value.startsWith('-') && value !== '-')) throw new Error(`Missing value for ${name}`);
        if (!validValue(spec[v].value, value)) throw new Error(`Invalid value for ${name}: ${value}`);
        values.push(value);
      }
      const occurrences = options.get(name) ?? [];
      occurrences.push(values);
      options.set(name, occurrences);
      optionOccurrences.push({ name: name.replace(/^-+/, ""), values });
    } else positional.push(token);
  }
  const initial = { index: 0, used: {}, arguments: {} };
  const append = (args, name, value) => ({ ...args, [name]: Object.hasOwn(args, name)
    ? [...(Array.isArray(args[name]) ? args[name] : [args[name]]), value] : value });
  function match(node, state) {
    switch (node.kind) {
      case 'argument': {
        const value = positional[state.index];
        return validValue(node.value, value)
          ? [{ ...state, index: state.index + 1, arguments: append(state.arguments, node.name, value) }] : [];
      }
      case 'option': {
        return node.names.flatMap(name => {
          const count = state.used[name] ?? 0;
          if (!options.get(name)?.[count]) return [];
          return [{ ...state, used: { ...state.used, [name]: count + 1 } }];
        });
      }
      case 'sequence': return node.items.reduce((states, item) => states.flatMap(s => match(item, s)), [state]);
      case 'choice': return node.items.flatMap(item => match(item, state));
      case 'optional': {
        const matches = match(node.item, state);
        let positional = false;
        walk(node.item, item => { if (item.kind === 'argument') positional = true; });
        // Flag-only optional groups are independent of positional consumption.
        // Once supplied, consume them instead of enumerating every skip/take subset.
        return matches.length && !positional ? matches : [...matches, state];
      }
      case 'repeat': {
        let current = [state], accepted = node.min === 0 ? [state] : [];
        for (let n = 1; n <= argv.length + 1; n++) {
          current = current.flatMap(s => match(node.item, s).filter(next => next.index !== s.index
            || JSON.stringify(next.used) !== JSON.stringify(s.used)));
          if (!current.length) break;
          if (n >= node.min) accepted.push(...current);
        }
        return accepted.reverse();
      }
      default: return [];
    }
  }
  const state = match(entry.grammar, initial).find(s => s.index === positional.length
    && [...options].every(([name, values]) => s.used[name] === values.length));
  if (!state) throw new Error(`Arguments do not match: ${commandSyntax(key, commands)}`);
  const parsedOptions = Object.fromEntries([...options].map(([name, values]) => [name.replace(/^-+/, ''),
    values.length > 1 ? values.map(v => v.length === 0 ? true : v.length === 1 ? v[0] : v)
      : values[0].length === 0 ? true : values[0].length === 1 ? values[0][0] : values[0]]));
  return { command: key, arguments: state.arguments, options: parsedOptions, positionals: positional, optionOccurrences };
}
function parse(argv, commands = loadCommands()) {
  const candidates = Object.entries(commands).filter(([, c]) => c.route.every((part, i) => part.split('|').includes(argv[i])));
  const length = Math.max(0, ...candidates.map(([, c]) => c.route.length));
  const errors = [];
  for (const [key, entry] of candidates.filter(([, c]) => c.route.length === length)) {
    try { return parseEntry(key, argv.slice(entry.route.length), commands); }
    catch (error) { errors.push(error.message); }
  }
  throw new Error(errors.join('\n') || `Unknown command: ${argv.join(' ')}`);
}

function shellQuote(value) { return "'" + String(value).replaceAll("'", "'\\''") + "'"; }
function bindEntry(key, bindings, argv, commands = loadCommands(), main = false) {
  const separator = argv.indexOf('--');
  const helpArgs = separator < 0 ? argv : argv.slice(0, separator);
  if (helpArgs.some(value => value === '--help' || value === '-h')) {
    return `printf '%s' ${shellQuote(help(key.startsWith('@') ? key.slice(1).split(' ') : commands[key]?.route ?? [], commands))}; ${main ? 'exit' : 'return'} 0`;
  }
  const parsed = key.startsWith("@") ? parse([...key.slice(1).split(" "), ...argv], commands) : parseEntry(key, argv, commands);
  return Object.entries(bindings).flatMap(([variable, source]) => {
    if (!/^[a-zA-Z_][a-zA-Z_0-9]*$/.test(variable)) throw new Error(`Invalid binding variable: ${variable}`);
    const sources = Array.isArray(source) ? source : [source];
    source = sources.find(candidate => {
      if (candidate.whenOption && !Object.hasOwn(parsed.options, candidate.whenOption)) return false;
      if (candidate.unlessOption && Object.hasOwn(parsed.options, candidate.unlessOption)) return false;
      return candidate.option ? (Array.isArray(candidate.option) ? candidate.option : [candidate.option])
        .some(name => Object.hasOwn(parsed.options, name)) : true;
    });
    if (!source) return [];
    let value;
    if (source.option) {
      const option = (Array.isArray(source.option) ? source.option : [source.option])
        .find(name => Object.hasOwn(parsed.options, name));
      if (!option) return [];
      value = source.constant ?? (source.array ? parsed.optionOccurrences
        .filter(item => (Array.isArray(source.option) ? source.option : [source.option]).includes(item.name))
        .map(item => item.values.length === 0 ? true : item.values.length === 1 ? item.values[0] : item.values)
        : parsed.options[option]);
      if (source.valueIndex !== undefined) value = Array.isArray(value) ? value[source.valueIndex] : source.valueIndex === 0 ? value : undefined;
      if (source.array && !Array.isArray(value)) value = [value];
    } else if (source.position !== undefined) value = parsed.positionals[source.position];
    else if (source.rest !== undefined) value = parsed.positionals.slice(source.rest);
    else throw new Error(`Invalid command binding: ${variable}`);
    if (value === undefined) return [];
    if (source.flag) value = value === false ? 0 : 1;
    if (source.json) value = JSON.stringify(source.array && !Array.isArray(value) ? [value] : value);
    return [Array.isArray(value) ? `${variable}=(${value.map(shellQuote).join(' ')})` : `${variable}=${shellQuote(value)}`];
  }).join('\n');
}

module.exports = { loadCommands, commandSyntax, renderCommands, help, parse, parseEntry, bindEntry };
if (require.main === module) {
  try {
    const [op, ...args] = process.argv.slice(2);
    if (op === 'syntax' && args.length === 1) process.stdout.write(commandSyntax(args[0]) + '\n');
    else if (op === 'help') process.stdout.write(help(args));
    else if (op === 'parse') process.stdout.write(JSON.stringify(parse(args)) + '\n');
    else if (op === 'bind-main') process.stdout.write(bindEntry(args[0], JSON.parse(args[1]), args.slice(2), loadCommands(), true) + '\n');
    else if (op === 'bind-entry') process.stdout.write(bindEntry(args[0], JSON.parse(args[1]), args.slice(2)) + '\n');
    else if (op === 'parse-entry') process.stdout.write(JSON.stringify(parseEntry(args[0], args.slice(1))) + '\n');
    else if (op === 'render' && args.length <= 1) process.stdout.write(renderCommands(fs.readFileSync(args[0] || 0, 'utf8')));
    else if (op === 'render-cli' && args.length === 0) process.stdout.write(renderCommands(fs.readFileSync(0, 'utf8'), { markdown: false }));
    else throw new Error('Usage: command-syntax.cjs syntax <key> | help [command...] | parse <command...> | parse-entry <key> [args...] | render [file] | render-cli');
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 2;
  }
}
