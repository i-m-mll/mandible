import type { Db } from "../db.js";

export const MARKDOWN_BODY_ESCAPE_POLICY_SETTING = "ledger.markdown_body_escape_policy";
export const DEFAULT_MARKDOWN_BODY_ESCAPE_POLICY: MarkdownBodyEscapePolicy = "warn";

export type MarkdownBodyEscapePolicy = "allow" | "warn" | "reject";

export interface MarkdownBodyEscapeDetection {
  suspicious: boolean;
  reason: string;
  literal_newline_count: number;
  actual_newline_count: number;
}

export interface MarkdownBodyPolicyWarning {
  code: "literal_escaped_newlines";
  message: string;
  details: MarkdownBodyEscapeDetection;
}

export type MarkdownBodyPolicyResult =
  | { action: "allow"; warning?: undefined }
  | { action: "warn"; warning: MarkdownBodyPolicyWarning }
  | { action: "reject"; warning: MarkdownBodyPolicyWarning };

export function parseMarkdownBodyEscapePolicy(value: unknown): MarkdownBodyEscapePolicy {
  return value === "allow" || value === "warn" || value === "reject"
    ? value
    : DEFAULT_MARKDOWN_BODY_ESCAPE_POLICY;
}

export function getMarkdownBodyEscapePolicy(db: Db): MarkdownBodyEscapePolicy {
  const row = db.prepare("SELECT value FROM settings WHERE key = ?")
    .get(MARKDOWN_BODY_ESCAPE_POLICY_SETTING) as { value: string } | undefined;
  return parseMarkdownBodyEscapePolicy(row?.value);
}

export function evaluateMarkdownBodyPolicy(
  body: string,
  policy: MarkdownBodyEscapePolicy,
): MarkdownBodyPolicyResult {
  if (policy === "allow") return { action: "allow" };

  const detection = detectAccidentalEscapedMarkdown(body);
  if (!detection.suspicious) return { action: "allow" };

  const warning: MarkdownBodyPolicyWarning = {
    code: "literal_escaped_newlines",
    message: "Body looks like Markdown submitted with literal \\\\n escapes. Submit Markdown text with real newline characters.",
    details: detection,
  };
  return policy === "reject" ? { action: "reject", warning } : { action: "warn", warning };
}

export function detectAccidentalEscapedMarkdown(body: string): MarkdownBodyEscapeDetection {
  const searchable = stripMarkdownCodeSpans(body);
  const literalNewlineCount = countMatches(searchable, /\\n/g);
  const actualNewlineCount = countMatches(searchable, /\r\n|\r|\n/g);

  if (literalNewlineCount < 2) {
    return detection(false, "fewer than two literal escaped newlines", literalNewlineCount, actualNewlineCount);
  }
  if (looksLikeStandaloneCode(body)) {
    return detection(false, "body looks like an intentional code or data snippet", literalNewlineCount, actualNewlineCount);
  }
  if (actualNewlineCount >= 2 && literalNewlineCount <= actualNewlineCount * 2) {
    return detection(false, "body already contains comparable real Markdown newlines", literalNewlineCount, actualNewlineCount);
  }

  return detection(
    true,
    "repeated literal escaped newlines with few real Markdown newlines",
    literalNewlineCount,
    actualNewlineCount,
  );
}

function stripMarkdownCodeSpans(body: string): string {
  return body
    .replace(/```[\s\S]*?```/g, "")
    .replace(/~~~[\s\S]*?~~~/g, "")
    .replace(/`[^`\r\n]*`/g, "");
}

function looksLikeStandaloneCode(body: string): boolean {
  const trimmed = body.trim();
  if (!trimmed) return false;
  if (isJsonLike(trimmed)) return true;
  return /^(?:const|let|var|function|class|interface|type|import|export)\b/.test(trimmed)
    && /[;{}=]/.test(trimmed);
}

function isJsonLike(value: string): boolean {
  if (!((value.startsWith("{") && value.endsWith("}")) || (value.startsWith("[") && value.endsWith("]")))) {
    return false;
  }
  try {
    JSON.parse(value);
    return true;
  } catch {
    return false;
  }
}

function countMatches(value: string, pattern: RegExp): number {
  return value.match(pattern)?.length ?? 0;
}

function detection(
  suspicious: boolean,
  reason: string,
  literal_newline_count: number,
  actual_newline_count: number,
): MarkdownBodyEscapeDetection {
  return { suspicious, reason, literal_newline_count, actual_newline_count };
}
