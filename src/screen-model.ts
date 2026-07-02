import type { ConsoleAttentionKind, ConsoleAttentionState, ConsoleSession } from "./types.js";
import {
  detectClaudePermissionPrompt,
  type ClaudePermissionPrompt,
} from "./claude-permission-patterns.js";

const DEFAULT_SETTLE_MS = 125;
const DEFAULT_UNKNOWN_QUIET_MS = 1_000;
const MAX_EXCERPT_LINES = 12;
const MAX_EXCERPT_CHARS = 1_500;

type Provider = ConsoleSession["agent_type"];

export interface ScreenSnapshot {
  session_id: string;
  rows: string[];
  cursor: { x: number; y: number };
  cols: number;
  row_count: number;
  text: string;
  at: number;
}

export interface ScreenClassification {
  kind: ConsoleAttentionKind;
  source: ConsoleAttentionState["source"];
  requires_attention: boolean;
  confidence: ConsoleAttentionState["detail"]["confidence"];
  reason: string;
  matched?: string;
  claude_permission?: ClaudePermissionPrompt;
}

export interface PtyScreenObserverOptions {
  sessionId: string;
  provider: Provider;
  cols: number;
  rows: number;
  settleMs?: number;
  unknownQuietMs?: number;
  now?: () => number;
  onAttentionChange?: (state: ConsoleAttentionState | null, classification?: ScreenClassification) => void;
}

export function shouldEnablePtyScreenModel(meta: ConsoleSession): boolean {
  const processSwitch = readBooleanSwitch(process.env.MANDIBLE_PTY_SCREEN_ATTENTION);
  if (processSwitch === false) {
    return false;
  }

  const sessionSwitch =
    readBooleanSwitch(meta.env.MANDIBLE_PTY_SCREEN_ATTENTION) ??
    readBooleanSwitch(meta.env.MANDIBLE_SCREEN_ATTENTION);
  if (sessionSwitch !== null) {
    return sessionSwitch;
  }

  return meta.backend_type === "pty" && ["claude", "codex", "gemini"].includes(meta.command);
}

export function detectInteractiveState(
  snapshot: ScreenSnapshot,
  provider: Provider,
  options: { processAlive?: boolean; recentStructuredActivity?: boolean } = {},
): ScreenClassification | null {
  const text = normalizeScreenText(snapshot.text);
  if (!text) {
    return null;
  }

  const permission = detectPermissionMenu(text, provider);
  if (permission) {
    return permission;
  }

  const inputPrompt = detectInputPrompt(text, provider);
  if (inputPrompt) {
    return inputPrompt;
  }

  const running = detectRunningOutput(text);
  if (running) {
    return running;
  }

  if (options.processAlive !== false && !options.recentStructuredActivity) {
    return {
      kind: "unknown",
      source: "pty_screen_fallback",
      requires_attention: true,
      confidence: "low",
      reason: "settled screen changed without recent structured transcript activity",
    };
  }

  return {
    kind: "running_output",
    source: "pty_screen",
    requires_attention: false,
    confidence: "low",
    reason: "settled screen has recent structured activity",
  };
}

export class PtyScreenObserver {
  private readonly sessionId: string;
  private readonly provider: Provider;
  private readonly settleMs: number;
  private readonly unknownQuietMs: number;
  private readonly now: () => number;
  private readonly onAttentionChange?: (state: ConsoleAttentionState | null, classification?: ScreenClassification) => void;
  private readonly terminal: SimpleHeadlessTerminal;
  private settleTimer: NodeJS.Timeout | null = null;
  private lastSignature: string | null = null;
  private lastStructuredActivityAt = 0;
  private currentAttention: ConsoleAttentionState | null = null;

  constructor(options: PtyScreenObserverOptions) {
    this.sessionId = options.sessionId;
    this.provider = options.provider;
    this.settleMs = options.settleMs ?? DEFAULT_SETTLE_MS;
    this.unknownQuietMs = options.unknownQuietMs ?? DEFAULT_UNKNOWN_QUIET_MS;
    this.now = options.now ?? Date.now;
    this.onAttentionChange = options.onAttentionChange;
    this.terminal = new SimpleHeadlessTerminal(options.cols, options.rows);
  }

  feed(data: string): void {
    this.terminal.write(data);
    this.scheduleSettle();
  }

  resize(cols: number, rows: number): void {
    this.terminal.resize(cols, rows);
    this.scheduleSettle();
  }

  markStructuredActivity(): void {
    this.lastStructuredActivityAt = this.now();
    if (this.currentAttention) {
      this.clear("structured_stream_activity");
    }
  }

  settleNow(): ScreenClassification | null {
    this.clearSettleTimer();
    const snapshot = this.snapshot();
    const signature = snapshot.rows.join("\n");
    if (signature === this.lastSignature) {
      return null;
    }
    const previousSignature = this.lastSignature;
    this.lastSignature = signature;

    const classification = detectInteractiveState(snapshot, this.provider, {
      processAlive: true,
      recentStructuredActivity: this.now() - this.lastStructuredActivityAt < this.unknownQuietMs,
    });
    if (!classification) {
      if (this.currentAttention) {
        this.clear("screen_changed");
      }
      return null;
    }

    if (classification.requires_attention) {
      this.publishAttention(snapshot, classification);
    } else if (this.currentAttention && previousSignature !== null) {
      this.clear("screen_changed");
    }
    return classification;
  }

  snapshot(): ScreenSnapshot {
    const rows = this.terminal.visibleRows();
    return {
      session_id: this.sessionId,
      rows,
      cursor: this.terminal.cursor(),
      cols: this.terminal.cols,
      row_count: this.terminal.rows,
      text: rows.join("\n").trim(),
      at: this.now(),
    };
  }

  clear(reason: NonNullable<ConsoleAttentionState["cleared_by"]> = "manual_clear"): void {
    this.clearSettleTimer();
    if (!this.currentAttention) {
      return;
    }
    const cleared: ConsoleAttentionState = {
      ...this.currentAttention,
      active: false,
      cleared_at: this.now(),
      cleared_by: reason,
    };
    this.currentAttention = null;
    this.onAttentionChange?.(cleared);
  }

  destroy(): void {
    this.clear("process_exit");
    this.clearSettleTimer();
  }

  private publishAttention(snapshot: ScreenSnapshot, classification: ScreenClassification): void {
    const next: ConsoleAttentionState = {
      session_id: this.sessionId,
      kind: classification.kind,
      source: classification.source,
      at: snapshot.at,
      active: true,
      screen_excerpt: excerpt(snapshot.rows),
      clear_conditions: [
        "screen_changed",
        "structured_stream_activity",
        "process_exit",
      ],
      detail: {
        provider: this.provider,
        confidence: classification.confidence,
        reason: classification.reason,
        ...(classification.matched ? { matched: classification.matched } : {}),
      },
    };

    if (attentionEquivalent(this.currentAttention, next)) {
      return;
    }
    this.currentAttention = next;
    this.onAttentionChange?.(next, classification);
  }

  private scheduleSettle(): void {
    this.clearSettleTimer();
    this.settleTimer = setTimeout(() => {
      this.settleTimer = null;
      this.settleNow();
    }, this.settleMs);
    if (this.settleTimer && typeof this.settleTimer === "object" && "unref" in this.settleTimer) {
      this.settleTimer.unref();
    }
  }

  private clearSettleTimer(): void {
    if (!this.settleTimer) {
      return;
    }
    clearTimeout(this.settleTimer);
    this.settleTimer = null;
  }
}

class SimpleHeadlessTerminal {
  cols: number;
  rows: number;
  private buffer: string[][];
  private x = 0;
  private y = 0;

  constructor(cols: number, rows: number) {
    this.cols = Math.max(1, cols);
    this.rows = Math.max(1, rows);
    this.buffer = Array.from({ length: this.rows }, () => []);
  }

  write(data: string): void {
    for (let i = 0; i < data.length; i += 1) {
      const char = data[i];
      if (char === "\x1b") {
        i = this.consumeEscape(data, i);
        continue;
      }
      if (char === "\r") {
        this.x = 0;
        continue;
      }
      if (char === "\n") {
        this.lineFeed();
        continue;
      }
      if (char === "\b") {
        this.x = Math.max(0, this.x - 1);
        continue;
      }
      if (char === "\t") {
        const spaces = 4 - (this.x % 4);
        for (let j = 0; j < spaces; j += 1) {
          this.putChar(" ");
        }
        continue;
      }
      if (char >= " ") {
        this.putChar(char);
      }
    }
  }

  resize(cols: number, rows: number): void {
    this.cols = Math.max(1, cols);
    this.rows = Math.max(1, rows);
    while (this.buffer.length < this.rows) {
      this.buffer.push([]);
    }
    if (this.buffer.length > this.rows) {
      this.buffer = this.buffer.slice(this.buffer.length - this.rows);
    }
    this.y = Math.min(this.y, this.rows - 1);
    this.x = Math.min(this.x, this.cols - 1);
  }

  visibleRows(): string[] {
    return this.buffer.map((row) => row.join("").slice(0, this.cols).trimEnd());
  }

  cursor(): { x: number; y: number } {
    return { x: this.x, y: this.y };
  }

  private consumeEscape(data: string, start: number): number {
    const next = data[start + 1];
    if (next === "[") {
      for (let i = start + 2; i < data.length; i += 1) {
        const code = data.charCodeAt(i);
        if (code >= 0x40 && code <= 0x7e) {
          this.applyCsi(data.slice(start + 2, i), data[i]);
          return i;
        }
      }
      return data.length - 1;
    }
    if (next === "]") {
      for (let i = start + 2; i < data.length; i += 1) {
        if (data[i] === "\x07") {
          return i;
        }
      }
      return data.length - 1;
    }
    return Math.min(start + 1, data.length - 1);
  }

  private applyCsi(paramsRaw: string, final: string): void {
    const params = paramsRaw
      .replace(/[?=]/g, "")
      .split(";")
      .map((part) => Number.parseInt(part, 10))
      .map((value) => (Number.isFinite(value) ? value : 0));
    const first = params[0] || 0;
    if (final === "H" || final === "f") {
      this.y = clamp((params[0] || 1) - 1, 0, this.rows - 1);
      this.x = clamp((params[1] || 1) - 1, 0, this.cols - 1);
      return;
    }
    if (final === "A") this.y = clamp(this.y - (first || 1), 0, this.rows - 1);
    if (final === "B") this.y = clamp(this.y + (first || 1), 0, this.rows - 1);
    if (final === "C") this.x = clamp(this.x + (first || 1), 0, this.cols - 1);
    if (final === "D") this.x = clamp(this.x - (first || 1), 0, this.cols - 1);
    if (final === "G") this.x = clamp((first || 1) - 1, 0, this.cols - 1);
    if (final === "K") this.eraseLine(first);
    if (final === "J") this.eraseDisplay(first);
  }

  private putChar(char: string): void {
    if (this.x >= this.cols) {
      this.x = 0;
      this.lineFeed();
    }
    this.buffer[this.y][this.x] = char;
    this.x += 1;
  }

  private lineFeed(): void {
    this.y += 1;
    if (this.y >= this.rows) {
      this.buffer.shift();
      this.buffer.push([]);
      this.y = this.rows - 1;
    }
  }

  private eraseLine(mode: number): void {
    if (mode === 1) {
      this.buffer[this.y].splice(0, this.x + 1);
      return;
    }
    if (mode === 2) {
      this.buffer[this.y] = [];
      return;
    }
    this.buffer[this.y].splice(this.x);
  }

  private eraseDisplay(mode: number): void {
    if (mode === 2 || mode === 3) {
      this.buffer = Array.from({ length: this.rows }, () => []);
      this.x = 0;
      this.y = 0;
    }
  }
}

function detectPermissionMenu(text: string, provider: Provider): ScreenClassification | null {
  const lower = text.toLowerCase();
  const claudePrompt = provider === "claude" ? detectClaudePermissionPrompt(text) : null;
  if (claudePrompt) {
    return {
      kind: "permission_menu",
      source: "pty_screen",
      requires_attention: true,
      confidence: claudePrompt.detect_only ? "medium" : "high",
      reason: claudePrompt.detect_only
        ? "screen matches a Claude attention prompt without structured options"
        : "screen matches a Claude permission prompt",
      matched: claudePrompt.matched,
      claude_permission: claudePrompt,
    };
  }

  const claudePermission =
    provider === "claude" &&
    (
      /claude (needs|requires|is requesting).{0,80}permission/s.test(lower) ||
      /do you want to (allow|proceed|continue)/.test(lower) ||
      /❯\s*(yes|allow|approve)/.test(lower)
    );
  const genericPermission =
    /(permission|approval|approve|allow|deny)/.test(lower) &&
    /(do you want|select|choose|yes|no|allow|deny)/.test(lower);
  if (!claudePermission && !genericPermission) {
    return null;
  }
  return {
    kind: "permission_menu",
    source: "pty_screen",
    requires_attention: true,
    confidence: claudePermission ? "high" : "medium",
    reason: "screen matches a terminal permission menu",
    matched: claudePermission ? "claude-permission-menu" : "generic-permission-menu",
  };
}

function detectInputPrompt(text: string, provider: Provider): ScreenClassification | null {
  const lower = text.toLowerCase();
  const promptLine = text.split("\n").map((line) => line.trim()).filter(Boolean).at(-1) ?? "";
  const genericPrompt = /(^|[\s])([>$#]|❯|›)\s*$/.test(promptLine);
  const providerPrompt =
    (provider === "claude" && /(type your message|enter a prompt|what would you like)/.test(lower)) ||
    (provider === "codex" && /(ask codex|codex.*prompt|type a message)/.test(lower)) ||
    (provider === "gemini" && /(ask gemini|gemini.*prompt|type a message)/.test(lower));
  if (!genericPrompt && !providerPrompt) {
    return null;
  }
  return {
    kind: "input_prompt",
    source: "pty_screen",
    requires_attention: true,
    confidence: providerPrompt ? "high" : "medium",
    reason: "screen matches an interactive input prompt",
    matched: providerPrompt ? `${provider}-input-prompt` : "generic-shell-prompt",
  };
}

function detectRunningOutput(text: string): ScreenClassification | null {
  const lower = text.toLowerCase();
  if (
    /(thinking|working|running|processing|esc to interrupt|ctrl-c to cancel)/.test(lower) ||
    /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/.test(text)
  ) {
    return {
      kind: "running_output",
      source: "pty_screen",
      requires_attention: false,
      confidence: "medium",
      reason: "screen indicates active command output",
    };
  }
  return null;
}

function normalizeScreenText(text: string): string {
  return text
    .replace(/\u001b\[[0-9;?=]*[ -/]*[@-~]/g, "")
    .replace(/\s+\n/g, "\n")
    .trim();
}

function excerpt(rows: string[]): string {
  return rows
    .map((row) => row.trimEnd())
    .filter((row) => row.trim())
    .slice(-MAX_EXCERPT_LINES)
    .join("\n")
    .slice(0, MAX_EXCERPT_CHARS);
}

function attentionEquivalent(a: ConsoleAttentionState | null, b: ConsoleAttentionState): boolean {
  return Boolean(
    a &&
      a.active &&
      a.kind === b.kind &&
      a.source === b.source &&
      a.screen_excerpt === b.screen_excerpt &&
      a.detail.reason === b.detail.reason,
  );
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function readBooleanSwitch(value: string | undefined): boolean | null {
  if (value === undefined) {
    return null;
  }
  const normalized = value.trim().toLowerCase();
  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }
  return null;
}
