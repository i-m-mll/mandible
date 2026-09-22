import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { renderMandibleInstructionsFragment } from "../src/instructions/fragment.js";

const syntax = createRequire(import.meta.url)("../cli/command-syntax.cjs") as {
  loadCommands(file?: string): Record<string, { route: string[]; syntax: string }>;
  renderCommands(source: string, options?: { markdown?: boolean; commands?: Record<string, { route: string[]; syntax: string }> }): string;
  help(route: string[], commands?: Record<string, { route: string[]; syntax: string }>): string;
};

describe("authored instructions and CLI syntax", () => {
  it("uses the same command definitions for CLI help and Markdown while preserving prose", () => {
    const commands = structuredClone(syntax.loadCommands());
    const source = "Before\n{{command issue.report}} — My editable explanation.\nAfter\n";
    commands["issue.report"].syntax += " [--future-option]";
    expect(syntax.renderCommands(source, { commands })).toBe(
      "Before\n`mandible issue report <id> [--json] [--future-option]` — My editable explanation.\nAfter\n",
    );
    expect(syntax.help(["issue", "report"], commands)).toContain(commands["issue.report"].syntax);
    const markdown = fs.readFileSync("cli/instructions-contract.md", "utf8");
    expect(markdown).toContain("{{command issue.report}}");
    expect(markdown.split("## Commands\n")[1].split("\n## ")[0]).not.toMatch(/^- `mandible /m);
    expect(renderMandibleInstructionsFragment()).toBe(syntax.renderCommands(markdown));
    expect(renderMandibleInstructionsFragment()).not.toContain("{{");
  });

  it("refuses malformed, unknown, and executable-looking insertions", () => {
    for (const source of ["{{command missing}}", "{{command issue.report}", "{{include /etc/passwd}}", "{{command issue.report; exit}}", "}}"])
      expect(() => syntax.renderCommands(source)).toThrow();
    expect(() => syntax.help(["absent-command"])).toThrow();
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-syntax-"));
    try {
      const file = path.join(root, "syntax.json");
      fs.writeFileSync(file, JSON.stringify({ schema_version: 1, commands: { bad: { route: ["issue"], syntax: "$(touch bad)" } } }));
      expect(() => syntax.loadCommands(file)).toThrow("Invalid CLI syntax definition");
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  it("documents only flags present in the implementing CLI, not invented document-only options", () => {
    const commands = syntax.loadCommands();
    for (const [key, command] of Object.entries(commands)) {
      const family = command.route[0];
      const script = family === "auth" ? `auth-${command.route[1]}.sh` : `${family}.sh`;
      const source = fs.readFileSync(path.join("cli", script), "utf8")
        + fs.readFileSync("cli/ledger-client.sh", "utf8");
      for (const flag of command.syntax.match(/--[a-z][a-z-]*/g) || []) {
        const optionCases = source.split("\n").filter(line => /^\s*[-a-zA-Z0-9_|*]+\)/.test(line) || /\[\[.*(?:==|=).*--/.test(line)).join("\n");
        expect(optionCases, `${key}: ${flag} is absent from parser cases in ${script}`).toContain(flag);
      }
    }
  });
});
