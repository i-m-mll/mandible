import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { testRuntimeRoot } from "./helpers/runtime-isolation.js";

const syntax = createRequire(import.meta.url)("../cli/command-syntax.cjs");
const inert = (...option: string[]) => ({ _: { option, inert: true } });

describe("one CLI grammar", () => {
  it("parses and binds a bulk auth submission without losing closure/reference order or values", () => {
    const references = Array.from({ length: 7 }, (_, i) => `reference-${i}`);
    const closures = Array.from({ length: 26 }, (_, i) => `closure-${i}`);
    const verification = `Verified exact candidate. ${"check passed; ".repeat(50)}$(literal) 'quoted'`;
    const argv = ["feature/candidate", "--title", "Bulk delivery", "--issue", references[0],
      "--message-file", "/tmp/change-message.md", "--verification", verification,
      "--repo", "mandible", "--cwd", "/tmp/private candidate", "--no-watch",
      ...closures.flatMap(id => ["--closes-issue", id]),
      ...references.slice(1).flatMap(id => ["--issue", id])];
    const parsed = syntax.parse(["auth", "request", ...argv]);
    expect(parsed.command).toBe("auth.request");
    expect(parsed.options.issue).toEqual(references);
    expect(parsed.options["closes-issue"]).toEqual(closures);
    expect(parsed.options.verification).toBe(verification);
    const callSite = fs.readFileSync("cli/auth-request.sh", "utf8")
      .match(/mandible_bind_main_arguments "@auth request" '([^']+)'/)!;
    const binding = syntax.bindEntry("@auth request", JSON.parse(callSite[1]), argv);
    for (const shell of ["bash", "zsh"]) {
      const result = spawnSync(shell, ["-c", `${binding}\nprintf '%s\\n' "\${ISSUE_REFERENCES[@]}"; printf 'closures\\n'; printf '%s\\n' "\${ISSUE_CLOSURES[@]}"; printf 'verification\\n%s' "$verification_text"`], { encoding: "utf8", timeout: 5_000 });
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toBe([...references, "closures", ...closures, "verification"].join("\n") + "\n" + verification);
    }
    expect(() => syntax.parse(["auth", "request", ...argv, "--unknown"])).toThrow("Unknown option");
    expect(() => syntax.parse(["auth", "request", ...argv.slice(0, argv.indexOf("--verification")),
      ...argv.slice(argv.indexOf("--verification") + 2)])).toThrow("Missing required option");
  });

  it("deduplicates repetition frontiers without merging argument bindings or repetition counts", () => {
    const argument = (name: string) => ({ kind: "argument", name, value: { type: "string" } });
    const flag = { kind: "option", names: ["--flag"], values: [] };
    const commands = { sample: { route: ["sample"], grammar: { kind: "repeat", min: 2, item: {
      kind: "choice", items: [flag, { kind: "sequence", items: [flag, flag] }],
    } } } };
    expect(syntax.parseEntry("sample", ["--flag", "--flag"], commands).options.flag).toEqual([true, true]);
    const alternatives = { sample: { route: ["sample"], grammar: { kind: "sequence", items: [
      { kind: "repeat", min: 1, item: { kind: "choice", items: [argument("first"), argument("second")] } },
      argument("tail"),
    ] } } };
    expect(syntax.parseEntry("sample", ["one", "two"], alternatives).arguments).toEqual({ second: "one", tail: "two" });
    alternatives.sample.grammar.items[0].item!.items.push(argument("first"));
    expect(syntax.parseEntry("sample", ["one", "two"], alternatives).arguments).toEqual({ first: "one", tail: "two" });
  });

  it("preserves internal parser defects instead of reporting them as another command variant mismatch", () => {
    const commands = structuredClone(syntax.loadCommands());
    const fault = new RangeError("injected parser defect");
    Object.defineProperty(commands["auth.request"].grammar.items[1].value, "type", { get() { throw fault; } });
    let caught: unknown;
    try { syntax.parse(["auth", "request", "feature/x", "--title", "t", "--issue", "one", "--message", "m", "--verification", "v"], commands); }
    catch (error) { caught = error; }
    expect(caught).toBe(fault);
    const invalid = spawnSync(process.execPath, ["cli/command-syntax.cjs", "parse", "issue", "report", "id", "--unknown"], { encoding: "utf8", timeout: 5_000 });
    expect(invalid.status).toBe(2);
    expect(invalid.stderr).toContain("Unknown option");
    const unknownHelp = spawnSync(process.execPath, ["cli/command-syntax.cjs", "help", "no-such-command"], { encoding: "utf8", timeout: 5_000 });
    expect(unknownHelp.status).toBe(2);
    expect(unknownHelp.stderr).toContain("Unknown command");
    expect(unknownHelp.stderr).not.toContain("internal error");
    const dir = path.join(testRuntimeRoot, "parser-internal-error"); fs.mkdirSync(dir);
    const tool = path.join(dir, "command-syntax.cjs"); fs.copyFileSync("cli/command-syntax.cjs", tool);
    fs.writeFileSync(path.join(dir, "command-syntax.json"), JSON.stringify({ schema_version: 0, commands: {} }));
    const internal = spawnSync(process.execPath, [tool, "parse", "issue", "report", "id"], { encoding: "utf8", timeout: 5_000 });
    expect(internal.status).toBe(1);
    expect(internal.stderr).toContain("Command parser internal error: Invalid CLI grammar registry");
    expect(internal.stderr).not.toContain("Arguments do not match");
  });

  it("generates parsing, help, and instructions from the same structured change", () => {
    const commands = structuredClone(syntax.loadCommands());
    commands["issue.report"].grammar.items.push({ kind: "optional", item: { kind: "option", names: ["--future"], values: [] } });
    expect(syntax.parseEntry("issue.report", ["id", "--future"], commands).options.future).toBe(true);
    expect(syntax.help(["issue", "report"], commands)).toContain("[--future]");
    expect(syntax.renderCommands("Before\n{{command issue.report}} — explanation.\nAfter\n", { commands }))
      .toContain("[--future]` — explanation.");
  });

  it("parses the shortest and the fullest form of every documented command", () => {
    const commands = syntax.loadCommands();
    const value = (spec: any): string =>
      spec.type === "enum" ? spec.values[0] : spec.type === "literal" ? spec.value
        : spec.type === "integer" ? String(spec.min ?? 1) : "x";
    const sample = (node: any, full: boolean): string[] => {
      switch (node.kind) {
        case "sequence": return node.items.flatMap((item: any) => sample(item, full));
        case "choice": return sample(node.items[0], full);
        case "optional": return full ? sample(node.item, full) : [];
        case "repeat": return Array.from({ length: Math.max(node.min, full ? 1 : 0) }, () => sample(node.item, full)).flat();
        case "argument": return [value(node.value)];
        case "option": return [node.names[0], ...node.values.map((item: any) => value(item.value))];
        default: throw new Error(`unknown grammar node ${node.kind}`);
      }
    };
    const documented = [...new Set([...fs.readFileSync("cli/instructions-contract.md", "utf8")
      .matchAll(/\{\{command ([a-z][a-z0-9.-]*)\}\}/g)].map((match) => match[1]))];
    expect(documented.length).toBeGreaterThan(0);
    const unparsed: string[] = [];
    for (const key of documented) {
      const route = commands[key].route.map((part: string) => part.split("|")[0]);
      for (const full of [false, true]) {
        const argv = [...route, ...sample(commands[key].grammar, full)];
        try {
          const parsed = syntax.parse(argv);
          if (commands[parsed.command].route.join(" ") !== commands[key].route.join(" ")) unparsed.push(`${argv.join(" ")} -> ${parsed.command}`);
        } catch (error) {
          unparsed.push(`${argv.join(" ")}: ${(error as Error).message.split("\n")[0]}`);
        }
      }
    }
    expect(unparsed).toEqual([]);
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
    expect(syntax.bindEntry("work-unit.claim", { issue: options.issue, ...inert("repo-id") }, ["--issue-id", "i", "--repo-id", "r"]))
      .toBe("issue='i'");
    expect(syntax.bindEntry("@auth request", { refs: options.refs, group: options.group, ...inert("title", "message", "verification") },
      ["feature/x", "--title", "t", "--issue", "one", "--issue", "two", "--promote-briefing", "g", "b", "p", ...changeMessage]))
      .toBe("refs=('one' 'two')\ngroup='g'");
    expect(syntax.bindEntry("@auth request", { publication: { option: "space-publication" }, ...inert("title", "issue", "message", "verification") },
      ["feature/x", "--title", "t", "--issue", "one", "--space-publication", "frozen-row", ...changeMessage]))
      .toBe("publication='frozen-row'");
    expect(() => syntax.parse(["auth", "request", "feature/x", "--title", "t", "--issue", "one", "--space-publication"]))
      .toThrow();
    expect(syntax.parse(["auth", "request", "feature/x", "--title", "t", "--closes-issue", "one", ...changeMessage]).options["closes-issue"])
      .toBe("one");
    expect(syntax.bindEntry("auth.withdraw", { request: { position: 0 }, ...inert("reason", "expected-revision", "expected-custody-generation") },
      ["abc/def", "--reason", "abandoned", "--expected-revision", "4", "--expected-custody-generation", "2"]))
      .toBe("request='abc/def'");
    expect(syntax.bindEntry("wrap", { argv: { rest: 0 } }, ["--", "command", "--help"]))
      .toBe("argv=('command' '--help')");
    expect(syntax.parse(["artifact", "bundle", "create", "--name", "smoke", "report.md", "--dry-run", "--json"]))
      .toMatchObject({ options: { name: "smoke", "dry-run": true }, positionals: ["report.md"] });
    expect(syntax.parse(["artifact", "snapshot", "artifact-version:one", "--from", "report.md", "--json"]).options.from)
      .toBe("report.md");
    expect(syntax.bindEntry("session.link-issue", { session: [{ option: ["session", "session-id"] }, { position: 0 }], ...inert("issue", "repo") },
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

  it("refuses a supplied option that the call site's bindings never read", () => {
    expect(() => syntax.bindEntry("conversations.search", { query: { position: 0 } }, ["needle", "--json"]))
      .toThrow("Not implemented by mandible conversations search: --json");
    expect(syntax.bindEntry("conversations.search", { query: { position: 0 }, ...inert("json") }, ["needle", "--json"]))
      .toBe("query='needle'");
  });

  // Call sites with a templated key (`"briefing.${action}"`) are left to the
  // runtime refusal above; every literal key is checked against its grammar here.
  it("binds every option each literal call site's grammar declares", () => {
    const commands = syntax.loadCommands();
    const byRoute = new Map(Object.entries(commands).map(([key, entry]: [string, any]) => [entry.route.join(" "), key]));
    const optionGroups = (node: any): string[][] => [
      ...(node.kind === "option" ? [node.names.map((name: string) => name.replace(/^-+/, ""))] : []),
      ...(node.items ?? []).flatMap(optionGroups), ...(node.item ? optionGroups(node.item) : [])];
    const files = [...fs.readdirSync("cli").filter(file => file.endsWith(".sh")).map(file => `cli/${file}`), "bin/mandible"];
    const unbound: string[] = [];
    for (const file of files) {
      for (const match of fs.readFileSync(file, "utf8").matchAll(/mandible_bind_(?:main_)?arguments "?([@a-z][a-z0-9. -]*)"? '([^']*)'/g)) {
        const key = match[1].startsWith("@") ? byRoute.get(match[1].slice(1)) : match[1];
        if (!key || !commands[key]) throw new Error(`${file}: unknown grammar key ${match[1]}`);
        const referenced = new Set(Object.values(JSON.parse(match[2])).flat()
          .flatMap((source: any) => [source.option, source.whenOption, source.unlessOption].flat().filter(Boolean)));
        for (const names of optionGroups(commands[key].grammar))
          for (const name of names) if (!referenced.has(name)) unbound.push(`${file} ${key} ${name}`);
      }
    }
    expect(unbound).toEqual([]);
  });

  it("refuses executable-looking insertions and malformed grammar registries", () => {
    for (const source of ["{{command missing}}", "{{command issue.report}", "{{include /etc/passwd}}", "{{command issue.report; exit}}", "}}"])
      expect(() => syntax.renderCommands(source)).toThrow();
    const file = path.join(testRuntimeRoot, "grammar.json");
    fs.writeFileSync(file, JSON.stringify({ schema_version: 1, commands: {} }));
    expect(() => syntax.loadCommands(file)).toThrow();
  });
});
