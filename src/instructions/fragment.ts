import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const MANDIBLE_INSTRUCTIONS_BEGIN = "<!-- BEGIN MANDIBLE MANAGED INSTRUCTIONS -->";
export const MANDIBLE_INSTRUCTIONS_END = "<!-- END MANDIBLE MANAGED INSTRUCTIONS -->";

interface CommandEntry {
  name: string;
  description: string;
}

interface InstructionsManifest {
  title: string;
  version: number;
  commands: CommandEntry[];
  trailers: string[];
  authLifecycle: string[];
  coordination: string[];
  transports: string[];
}

export interface InstallResult {
  changed: boolean;
  content: string;
}

export function loadInstructionsManifest(): InstructionsManifest {
  const manifestPath = findRepoFile("cli/instructions-contract.json");
  return JSON.parse(fs.readFileSync(manifestPath, "utf8")) as InstructionsManifest;
}

export function renderMandibleInstructionsFragment(
  manifest: InstructionsManifest = loadInstructionsManifest(),
): string {
  const lines = [
    `# ${manifest.title}`,
    "",
    `Version: ${manifest.version}`,
    "",
    "This section is Mandible's interface contract. It describes daemon and CLI behavior that is the same for every install. It deliberately excludes user policy such as signing key names, branch naming schemes, editor preferences, and worktree tooling.",
    "",
    "## Commands",
    "",
    ...manifest.commands.flatMap((command) => [
      `- \`${command.name}\` - ${command.description}`,
    ]),
    "",
    "## Commit Trailers",
    "",
    ...manifest.trailers.map((item) => `- ${item}`),
    "",
    "## Auth Requests",
    "",
    ...manifest.authLifecycle.map((item) => `- ${item}`),
    "",
    "## Coordination",
    "",
    ...manifest.coordination.map((item) => `- ${item}`),
    "",
    "## Transports",
    "",
    ...manifest.transports.map((item) => `- ${item}`),
  ];
  return `${lines.join("\n").trim()}\n`;
}

export function renderManagedInstructionsBlock(fragment = renderMandibleInstructionsFragment()): string {
  return `${MANDIBLE_INSTRUCTIONS_BEGIN}\n${fragment.trim()}\n${MANDIBLE_INSTRUCTIONS_END}\n`;
}

export function installManagedInstructions(existing: string, block = renderManagedInstructionsBlock()): InstallResult {
  const range = findManagedRange(existing);
  if (!range) {
    const prefix = existing.trimEnd();
    const content = `${prefix}${prefix ? "\n\n" : ""}${block}`;
    return { changed: content !== existing, content };
  }
  const content = `${existing.slice(0, range.start)}${block}${existing.slice(range.end)}`;
  return { changed: content !== existing, content };
}

export function diffManagedInstructions(existing: string, block = renderManagedInstructionsBlock()): string {
  const next = installManagedInstructions(existing, block).content;
  if (next === existing) {
    return "";
  }
  return [
    "--- current",
    "+++ desired",
    ...buildLineDiff(existing, next),
  ].join("\n");
}

export function withMandibleInstructionsFragment(systemPrompt: string | undefined): string {
  const block = renderManagedInstructionsBlock();
  if (!systemPrompt || systemPrompt.trim().length === 0) {
    return block.trim();
  }
  if (systemPrompt.includes(MANDIBLE_INSTRUCTIONS_BEGIN)) {
    return systemPrompt;
  }
  return `${block.trim()}\n\n${systemPrompt}`;
}

function findManagedRange(content: string): { start: number; end: number } | null {
  const start = content.indexOf(MANDIBLE_INSTRUCTIONS_BEGIN);
  if (start < 0) {
    return null;
  }
  const endMarkerStart = content.indexOf(MANDIBLE_INSTRUCTIONS_END, start);
  if (endMarkerStart < 0) {
    throw new Error("managed instructions begin marker exists without end marker");
  }
  const end = endMarkerStart + MANDIBLE_INSTRUCTIONS_END.length;
  return {
    start,
    end: content[end] === "\n" ? end + 1 : end,
  };
}

function buildLineDiff(before: string, after: string): string[] {
  const beforeLines = before.split("\n");
  const afterLines = after.split("\n");
  const lines: string[] = [];
  const max = Math.max(beforeLines.length, afterLines.length);
  for (let index = 0; index < max; index += 1) {
    const previous = beforeLines[index];
    const next = afterLines[index];
    if (previous === next) {
      lines.push(` ${previous ?? ""}`);
      continue;
    }
    if (previous !== undefined) {
      lines.push(`-${previous}`);
    }
    if (next !== undefined) {
      lines.push(`+${next}`);
    }
  }
  return lines;
}

function findRepoFile(relativePath: string): string {
  let current = path.dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 8; depth += 1) {
    const candidate = path.join(current, relativePath);
    if (fs.existsSync(candidate)) {
      return candidate;
    }
    current = path.dirname(current);
  }
  throw new Error(`Could not find ${relativePath}`);
}
