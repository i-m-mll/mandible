import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { renderMandibleInstructionsFragment } from "../src/instructions/fragment.js";

const syntax = createRequire(import.meta.url)("../cli/command-syntax.cjs");

describe("one CLI grammar", () => {
  it("generates parsing, help, and instructions from the same structured change", () => {
    const commands = structuredClone(syntax.loadCommands());
    commands["issue.report"].grammar.items.push({ kind: "optional", item: { kind: "option", names: ["--future"], values: [] } });
    expect(syntax.parseEntry("issue.report", ["id", "--future"], commands).options.future).toBe(true);
    expect(syntax.help(["issue", "report"], commands)).toContain("[--future]");
    expect(syntax.renderCommands("Before\n{{command issue.report}} — explanation.\nAfter\n", { commands }))
      .toContain("[--future]` — explanation.");
    const markdown = fs.readFileSync("cli/instructions-contract.md", "utf8");
    expect(renderMandibleInstructionsFragment()).toBe(syntax.renderCommands(markdown));
  });

  it("rejects unknown options, missing values, invalid enums and ranges, excess arguments, and duplicate flags", () => {
    for (const argv of [["issue", "report", "id", "--bad"], ["changes", "--project"],
      ["changes", "--project", "mandible", "--limit", "201"], ["issue", "status", "id", "invalid"],
      ["issue", "report", "id", "extra"], ["issue", "report", "id", "--json", "--json"]])
      expect(() => syntax.parse(argv)).toThrow();
    expect(syntax.parse(["work-unit", "release", "--repo", "mandible", "--branch", "feature/x", "--expected-generation", "1"]).options.branch).toBe("feature/x");
    expect(syntax.parse(["issue", "new", "--kind", "bug", "--title", "title", "--message", "body"]).options.message).toBe("body");
  });

  it("binds retained aliases, repeated options, multi-value flags, and literal shell bytes safely", () => {
    const options = { issue: { option: ["issue", "issue-id"] }, refs: { option: "issue", array: true },
      message: { option: "message" }, group: { option: "promote-briefing", valueIndex: 0 } };
    const changeMessage = ["--message", "m", "--verification", "v"];
    expect(syntax.bindEntry("work-unit.claim", { issue: options.issue }, ["--issue-id", "i", "--repo-id", "r"]))
      .toBe("issue='i'");
    expect(syntax.bindEntry("@auth request", { refs: options.refs, group: options.group },
      ["feature/x", "--title", "t", "--issue", "one", "--issue", "two", "--promote-briefing", "g", "b", "p", ...changeMessage]))
      .toBe("refs=('one' 'two')\ngroup='g'");
    expect(syntax.bindEntry("@auth request", { publication: { option: "space-publication" } },
      ["feature/x", "--title", "t", "--issue", "one", "--space-publication", "frozen-row", ...changeMessage]))
      .toBe("publication='frozen-row'");
    expect(() => syntax.parse(["auth", "request", "feature/x", "--title", "t", "--issue", "one", "--space-publication"]))
      .toThrow();
    expect(syntax.parse(["auth", "request", "feature/x", "--title", "t", "--closes-issue", "one", ...changeMessage]).options["closes-issue"])
      .toBe("one");
    expect(syntax.bindEntry("auth.withdraw", { request: { position: 0 } },
      ["abc/def", "--reason", "abandoned", "--expected-revision", "4", "--expected-custody-generation", "2"]))
      .toBe("request='abc/def'");
    expect(syntax.bindEntry("wrap", { argv: { rest: 0 } }, ["--", "command", "--help"]))
      .toBe("argv=('command' '--help')");
    expect(syntax.parse(["artifact", "bundle", "create", "--name", "smoke", "report.md", "--dry-run", "--json"]))
      .toMatchObject({ options: { name: "smoke", "dry-run": true }, positionals: ["report.md"] });
    expect(syntax.parse(["artifact", "snapshot", "artifact-version:one", "--from", "report.md", "--json"]).options.from)
      .toBe("report.md");
    expect(syntax.bindEntry("session.link-issue", { session: [{ option: ["session", "session-id"] }, { position: 0 }] },
      ["--session-id", "session", "--issue", "issue", "--repo", "repo"]))
      .toBe("session='session'");
    expect(syntax.parse(["auth", "list", "--head", "feature/topic", "--type", "merge"]).options)
      .toEqual({ head: "feature/topic", type: "merge" });
    expect(syntax.bindEntry("project.repair", { source: { option: "merge", valueIndex: 0 }, target: { option: "merge", valueIndex: 1 } },
      ["--merge", "a", "b"]))
      .toBe("source='a'\ntarget='b'");
    expect(syntax.parse(["space", "block", "edit", "space", "block", "--parent", ""]).options.parent)
      .toBe("");
    expect(syntax.bindEntry("conversations.comment", { message: { option: "m" } }, ["id", "-m", "$(touch bad)'literal"]))
      .toContain("'$(touch bad)'\\''literal'");
  });

  it("refuses executable-looking insertions and malformed grammar registries", () => {
    for (const source of ["{{command missing}}", "{{command issue.report}", "{{include /etc/passwd}}", "{{command issue.report; exit}}", "}}"])
      expect(() => syntax.renderCommands(source)).toThrow();
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-grammar-"));
    try {
      const file = path.join(root, "grammar.json");
      fs.writeFileSync(file, JSON.stringify({ schema_version: 1, commands: {} }));
      expect(() => syntax.loadCommands(file)).toThrow();
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
});
