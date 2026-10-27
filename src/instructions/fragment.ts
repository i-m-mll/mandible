import fs from "node:fs";
import { createRequire } from "node:module";
import { productResource } from "../product-resources.js";

export const MANDIBLE_INSTRUCTIONS_BEGIN = "<!-- BEGIN MANDIBLE MANAGED INSTRUCTIONS -->";
export const MANDIBLE_INSTRUCTIONS_END = "<!-- END MANDIBLE MANAGED INSTRUCTIONS -->";

export interface InstallResult {
  changed: boolean;
  content: string;
}

export function renderMandibleInstructionsFragment(): string {
  const { renderCommands } = createRequire(import.meta.url)(productResource("cli/command-syntax.cjs")) as {
    renderCommands(source: string): string;
  };
  return renderCommands(fs.readFileSync(productResource("cli/instructions-contract.md"), "utf8"));
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
