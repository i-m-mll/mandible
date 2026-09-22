// CLI syntax is shared by help/usage and the authored instruction document.
// This module performs substitutions only: no evaluation or command execution.
const fs = require('node:fs');
const path = require('node:path');

function loadCommands(file = path.join(__dirname, 'command-syntax.json')) {
  const registry = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (registry.schema_version !== 1 || !registry.commands || Array.isArray(registry.commands)
      || Object.keys(registry).some(key => !['schema_version', 'commands'].includes(key))) {
    throw new Error('Invalid CLI syntax registry');
  }
  for (const [key, entry] of Object.entries(registry.commands)) {
    if (!/^[a-z][a-z0-9.-]*$/.test(key) || !entry || Object.keys(entry).sort().join() !== 'route,syntax'
        || !Array.isArray(entry.route) || entry.route.length === 0
        || entry.route.some(part => !/^[a-z][a-z-]*(\|[a-z][a-z-]*)*$/.test(part))
        || typeof entry.syntax !== 'string' || !entry.syntax.startsWith(`mandible ${entry.route.join(' ')}`)
        || /[\n\r`{}]/.test(entry.syntax)) {
      throw new Error(`Invalid CLI syntax definition: ${key}`);
    }
  }
  return registry.commands;
}

function commandSyntax(key, commands = loadCommands()) {
  if (!Object.hasOwn(commands, key)) throw new Error(`Unknown command insertion: ${key}`);
  return commands[key].syntax;
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
  const matches = Object.values(commands).filter(entry =>
    route.every((part, index) => entry.route[index]?.split('|').includes(part)));
  if (!matches.length) throw new Error(`Unknown command: ${route.join(' ')}`);
  return `Usage:\n${matches.map(entry => `  ${entry.syntax}`).join('\n')}\n`;
}

module.exports = { loadCommands, commandSyntax, renderCommands, help };

if (require.main === module) {
  try {
    const [op, ...args] = process.argv.slice(2);
    if (op === 'syntax' && args.length === 1) process.stdout.write(commandSyntax(args[0]) + '\n');
    else if (op === 'help') process.stdout.write(help(args));
    else if (op === 'render' && args.length <= 1) {
      process.stdout.write(renderCommands(fs.readFileSync(args[0] || 0, 'utf8')));
    } else if (op === 'render-cli' && args.length === 0) {
      process.stdout.write(renderCommands(fs.readFileSync(0, 'utf8'), { markdown: false }));
    } else throw new Error('Usage: command-syntax.cjs syntax <key> | help [command...] | render [file] | render-cli');
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 2;
  }
}
