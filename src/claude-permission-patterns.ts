import { createHash } from "node:crypto";
import type { PermissionDecision, PermissionRequestOption } from "./agentic-backend.js";

export type ClaudePermissionPromptKind =
  | "tool_use"
  | "bash_command"
  | "file_edit"
  | "mcp_tool"
  | "trust_folder"
  | "login"
  | "update"
  | "plan_mode";

export interface ClaudePermissionPrompt {
  kind: ClaudePermissionPromptKind;
  question: string;
  subject: string;
  options: PermissionRequestOption[];
  detect_only: boolean;
  matched: string;
  screen_hash: string;
  identity: string;
}

const OPTION_RE = /^(?:[❯›>]\s*)?([0-9A-Za-z])[\).]\s+(.+)$/;

export function detectClaudePermissionPrompt(text: string): ClaudePermissionPrompt | null {
  const normalized = normalizePromptText(text);
  if (!normalized) {
    return null;
  }
  const lines = normalized.split("\n").map((line) => line.trim()).filter(Boolean);
  const lower = normalized.toLowerCase();
  const screenHash = hashText(normalized);
  const options = extractOptions(lines);

  const detectOnly = detectDetectOnlyPrompt(lines, lower, screenHash);
  if (detectOnly) {
    return detectOnly;
  }

  if (options.length === 0) {
    return null;
  }

  const question = extractQuestion(lines);
  const subject = extractSubject(lines, lower);
  if (!question || !subject) {
    return null;
  }

  const kind = classifyPromptKind(lines, lower, subject);
  if (!kind) {
    return null;
  }

  return buildPrompt({
    kind,
    question,
    subject,
    options,
    detectOnly: false,
    matched: `claude-permission-${kind}`,
    screenHash,
  });
}

function detectDetectOnlyPrompt(
  lines: string[],
  lower: string,
  screenHash: string,
): ClaudePermissionPrompt | null {
  const question = extractQuestion(lines) ?? lines[0] ?? "Claude needs attention";
  const checks: Array<[ClaudePermissionPromptKind, RegExp, string]> = [
    ["trust_folder", /(do you trust|trust).{0,80}(folder|directory|files in this)/s, "folder trust approval"],
    ["login", /(^|[\s/])login\b|log in to claude|authentication required|sign in to claude/s, "login approval"],
    ["update", /(update available|new version available|install update|claude code update)/s, "update approval"],
    ["plan_mode", /(plan mode|approve plan|proceed with this plan|exit plan mode)/s, "plan mode approval"],
  ];
  for (const [kind, pattern, subject] of checks) {
    if (pattern.test(lower)) {
      return buildPrompt({
        kind,
        question,
        subject,
        options: [],
        detectOnly: true,
        matched: `claude-detect-only-${kind}`,
        screenHash,
      });
    }
  }
  return null;
}

function buildPrompt(input: {
  kind: ClaudePermissionPromptKind;
  question: string;
  subject: string;
  options: PermissionRequestOption[];
  detectOnly: boolean;
  matched: string;
  screenHash: string;
}): ClaudePermissionPrompt {
  const identity = hashText(JSON.stringify({
    kind: input.kind,
    question: input.question,
    subject: input.subject,
    options: input.options.map((option) => [option.key, option.label]),
  }));
  return {
    kind: input.kind,
    question: input.question,
    subject: input.subject,
    options: input.options,
    detect_only: input.detectOnly,
    matched: input.matched,
    screen_hash: input.screenHash,
    identity,
  };
}

function extractOptions(lines: string[]): PermissionRequestOption[] {
  const options: PermissionRequestOption[] = [];
  for (const line of lines) {
    const match = OPTION_RE.exec(line);
    if (!match) {
      continue;
    }
    const key = match[1].trim();
    const label = match[2].trim();
    if (!key || !label) {
      continue;
    }
    options.push({
      key,
      label,
      decision: `option:${key}` as PermissionDecision,
    });
  }
  return options;
}

function extractQuestion(lines: string[]): string | null {
  return lines.find((line) =>
    line.includes("?") &&
    /(allow|approve|permission|proceed|continue|trust|update|login|log in|plan)/i.test(line)
  ) ?? null;
}

function extractSubject(lines: string[], lower: string): string | null {
  const labeled = findLabeledSubject(lines);
  if (labeled) {
    return labeled;
  }

  const joined = lines.join("\n");
  const mcp = /\b(mcp__[A-Za-z0-9_-]+__[A-Za-z0-9_-]+)\b/.exec(joined);
  if (mcp) {
    return mcp[1];
  }

  const bashIndex = lines.findIndex((line) => /bash command|shell command|run command/i.test(line));
  if (bashIndex >= 0) {
    const next = nextSubjectLine(lines, bashIndex + 1);
    if (next) {
      return next;
    }
  }

  const editPath = /(?:edit|write|modify|create|update)(?: file)?\s+([~./][^\n]+)/i.exec(joined);
  if (editPath) {
    return editPath[1].trim();
  }

  const tool = /(?:use|run)(?: the)?\s+([A-Za-z][A-Za-z0-9_-]+)(?: tool)?/i.exec(joined);
  if (tool && !/claude|permission|command|this/i.test(tool[1])) {
    return tool[1];
  }

  if (/bash|command/.test(lower)) {
    const commandLine = lines.find((line) => /^[`$]/.test(line) || /\b(npm|pnpm|yarn|git|python|pytest|uv|rm|mkdir|cp|mv|sed|cat)\b/.test(line));
    if (commandLine) {
      return commandLine.replace(/^[$`]\s*/, "").replace(/`$/, "").trim();
    }
  }

  return null;
}

function findLabeledSubject(lines: string[]): string | null {
  const labels = [
    /^command:\s*(.+)$/i,
    /^bash command:\s*(.+)$/i,
    /^tool:\s*(.+)$/i,
    /^mcp tool:\s*(.+)$/i,
    /^file:\s*(.+)$/i,
    /^path:\s*(.+)$/i,
  ];
  for (const line of lines) {
    for (const label of labels) {
      const match = label.exec(line);
      if (match?.[1]?.trim()) {
        return match[1].trim();
      }
    }
  }
  return null;
}

function nextSubjectLine(lines: string[], start: number): string | null {
  for (let i = start; i < lines.length; i += 1) {
    const line = lines[i];
    if (OPTION_RE.test(line) || line.includes("?")) {
      return null;
    }
    if (!/^(tool input|options|permission required)$/i.test(line)) {
      return line.replace(/^[$`]\s*/, "").replace(/`$/, "").trim();
    }
  }
  return null;
}

function classifyPromptKind(
  lines: string[],
  lower: string,
  subject: string,
): ClaudePermissionPromptKind | null {
  if (/\bmcp__/.test(subject) || /\bmcp tool\b/.test(lower)) {
    return "mcp_tool";
  }
  if (/\bbash\b|\bcommand\b|\bshell\b/.test(lower)) {
    return "bash_command";
  }
  if (/\b(edit|write|multiedit|file|path)\b/.test(lower) && /[~./]/.test(subject)) {
    return "file_edit";
  }
  if (lines.some((line) => /\btool\b/i.test(line)) || /\buse\b/.test(lower)) {
    return "tool_use";
  }
  return null;
}

function normalizePromptText(text: string): string {
  return text
    .replace(/\u001b\[[0-9;?=]*[ -/]*[@-~]/g, "")
    .replace(/[╭╮╰╯│─]/g, " ")
    .replace(/\s+\n/g, "\n")
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join("\n")
    .trim();
}

function hashText(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}
