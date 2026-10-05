import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface ParsedCommand {
  command: string;
  options: Record<string, string | boolean | string[]>;
  positionals: string[];
}
const registry = createRequire(import.meta.url)(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../cli/command-syntax.cjs")) as {
  parse(argv: string[]): ParsedCommand;
  help(route: string[]): string;
};
export function commandHelp(route: string[]): string { return registry.help(route); }
export function parseCommand(route: string[], argv: string[]): ParsedCommand {
  if (argv.some(value => value === "--help" || value === "-h")) {
    process.stdout.write(commandHelp(route));
    process.exit(0);
  }
  return registry.parse([...route, ...argv]);
}
export function stringOption(parsed: ParsedCommand, ...names: string[]): string | undefined {
  for (const name of names) {
    const value = parsed.options[name];
    if (typeof value === "string") return value;
  }
  return undefined;
}
export function repeatedOption(parsed: ParsedCommand, name: string): string[] | undefined {
  const value = parsed.options[name];
  return typeof value === "string" ? [value] : Array.isArray(value) ? value : undefined;
}
export function numberOption(parsed: ParsedCommand, name: string): number | undefined {
  const value = stringOption(parsed, name);
  return value === undefined ? undefined : Number(value);
}
export function flagOption(parsed: ParsedCommand, name: string): boolean { return parsed.options[name] === true; }
