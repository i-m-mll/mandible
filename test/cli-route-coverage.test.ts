import { waitUntil } from "./helpers/wait-until.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import ts from "typescript";
import { describe, expect, it } from "vitest";

type RoutePolicy = "allow" | "conditional" | "deny";

interface CliRouteRef {
  file: string;
  line: number;
  method: string;
  route: string;
}

interface UnresolvedCliCallSite {
  file: string;
  line: number;
  fn: string;
  detail: string;
}

const EXPECTED_DYNAMIC_CLI_API_CALL_SITES = [
  // Existing helper wrappers and command-specific request builders that derive
  // API paths in variables. New entries here should be reviewed instead of
  // silently escaping the route-policy coverage lint.
  "cli/artifact.sh:123 api_send POST \"$endpoint\" \"$payload\"",
  "cli/auth-list.sh:67 api_get \"$url\" 2>/dev/null)",
  "cli/changes.sh:49 api_send_capture GET \"$request\" \"\" \"$response_file\")",
  "cli/conversations.sh:207 api_get \"$request\")",
  "cli/conversations.sh:371 api_get \"$request\")",
  "cli/conversations.sh:442 api_get \"$request\")",
  "cli/inbox.sh:38 api_get \"$url\")",
  "cli/inbox.sh:84 api_get \"$url\")",
  "cli/issue.sh:920 api_get \"$checkpoint_path\") \\",
  "cli/issue.sh:930 api_get \"$checkpoint_path\") \\",
  "cli/issue.sh:1219 api_get \"$path\") \\",
  "cli/ledger-client.sh:40 api_send_capture \"$method\" \"$request_path\" \"$data\" \"$tmp_response\")",
  "cli/logs.sh:71 api_get \"$request\")",
  "cli/logs.sh:115 api_get \"$request\")",
  "cli/space.sh:81 api_send POST \"$1\" \"$2\"",
  "cli/umbrella.sh:80 api_get \"$path\") \\",
] as const;

// Subcommands that are deliberately unavailable over the file transport. The
// Interface Contract denies approval, merge, admin, and config routes there,
// so these call sites are correct and their routes are correctly registered
// "deny". The assertion is an exact match, not a filter: a new denied call
// site fails here rather than escaping the coverage lint.
const EXPECTED_FILE_RPC_DENIED_CLI_CALL_SITES = [
  "cli/auth-clearance.sh:57 POST /api/auth/clearances",
  "cli/auth-clearance.sh:68 GET /api/auth/clearances",
  "cli/auth-clearance.sh:70 GET /api/auth/clearances",
  "cli/auth-clearance.sh:76 GET /api/auth/clearances/:param",
  "cli/auth-clearance.sh:81 POST /api/auth/clearances/:param/revoke",
  "cli/auth-clearance.sh:86 POST /api/auth/request/:param/clearance/execute",
  // Issue a09b4d2 — operator retirement of a failed runtime handoff lock.
  "cli/auth-handoff.sh:39 POST /api/runtime-handoff/retire",
  // Issue 23f8142 — operator one-time conversation lineage backfill.
] as const;

describe("CLI API route coverage", () => {
  // Issue 15048da — the three mutating clearance subcommands called a helper
  // (`api_mutate`) that never existed, so every one of them died with
  // "command not found" at first use and the whole prospective-clearance
  // mechanism was unreachable from the CLI. Nothing caught it: the route lint
  // above matches four known request helpers by name, and an unknown name is
  // invisible to a lint keyed on known names.
  it("defines every API helper the CLI scripts invoke", () => {
    expect(collectUndefinedApiHelperCallSites()).toEqual([]);
  });

  it("keeps static CLI API calls covered by registered file-RPC route policy", () => {
    const policies = collectRoutePolicies();
    const { refs, unresolved } = collectCliRouteRefs();
    const missing = refs.filter((ref) => !policies.has(routeKey(ref.method, ref.route)));
    const denied = refs.filter((ref) => policies.get(routeKey(ref.method, ref.route)) === "deny");

    expect(formatRefs(missing)).toEqual([]);
    expect(denied.map(ref => `${ref.file} ${ref.method} ${ref.route}`).sort()).toEqual(
      EXPECTED_FILE_RPC_DENIED_CLI_CALL_SITES.map(site => site.replace(/:\d+ /, " ")).sort(),
    );
    const callSites = (sites: readonly string[]) => sites.map(site => site.replace(/:\d+ /, " ")).sort();
    expect(callSites(formatUnresolved(unresolved))).toEqual(callSites(EXPECTED_DYNAMIC_CLI_API_CALL_SITES));
  });

  it("allows only export plus the daemon-only credential workflow among conversation POST routes", () => {
    const policies = collectRoutePolicies();

    expect(policies.get(routeKey("POST", "/api/conversations/:id/export"))).toBe("allow");
    // The CLI must cross the daemon boundary in file-only sandboxes because
    // only the daemon holds the candidate-verification pepper.
    expect(policies.get(routeKey("POST", "/api/conversations/scan-credentials"))).toBe("allow");
    expect(policies.get(routeKey("POST", "/api/conversations/ingest"))).toBe("deny");
    expect(policies.get(routeKey("POST", "/api/conversations/export/transform"))).toBe("deny");
    expect(policies.get(routeKey("POST", "/api/conversations/:id/fork"))).toBe("deny");
    expect(policies.get(routeKey("POST", "/api/conversations/:id/control/submit"))).toBe("deny");
  });

  it("keeps the legacy file-RPC allow fixture backed by real registered route policies", () => {
    const policies = collectRoutePolicies();
    const legacyAllowedRoutes = collectLegacyAllowedRoutes();
    const missing = legacyAllowedRoutes.filter((ref) => !policies.has(routeKey(ref.method, ref.route)));
    const denied = legacyAllowedRoutes.filter((ref) => policies.get(routeKey(ref.method, ref.route)) !== "allow");

    expect(formatRefs(missing)).toEqual([]);
    expect(formatRefs(denied)).toEqual([]);
  });

  it("removes tracked token-bearing temporary files on TERM", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-cli-cleanup-"));
    const trackedPath = path.join(tempDir, "spool-token.request.json.tmp");
    const helperPath = path.join(process.cwd(), "cli", "api.sh");
    try {
      const result = spawnSync(
        "zsh",
        [
          "-c",
          'source "$API_HELPER_PATH"; printf secret > "$TRACKED_PATH"; '
            + 'api_track_temp "$TRACKED_PATH"; kill -TERM $$',
        ],
        {
          env: {
            ...process.env,
            API_HELPER_PATH: helperPath,
            TRACKED_PATH: trackedPath,
            TMPDIR: tempDir,
          },
          encoding: "utf8",
        },
      );
      expect(result.status).toBe(143);
      expect(fs.existsSync(trackedPath)).toBe(false);
      expect(
        fs.readdirSync(tempDir).filter((entry) => entry.startsWith("mandible-api.")),
      ).toEqual([]);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("privatizes and removes the real published file-RPC request on interrupt", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-rpc-signal-"));
    const spoolDir = path.join(tempDir, "spool");
    const child = spawn(
      "zsh",
      [
        "-c",
        'source "$API_HELPER_PATH"; output=$(api_temp_file); '
          + 'api_file_rpc_exchange POST /api/test "{}" "$output" >/dev/null',
      ],
      {
        env: {
          ...process.env,
          API_HELPER_PATH: path.join(process.cwd(), "cli", "api.sh"),
          MANDIBLE_BASE: `file://${spoolDir}`,
          MANDIBLE_TOKEN: "file-rpc-secret",
          CODEX_THREAD_ID: "",
          CODEX_SESSION_ID: "",
          CLAUDE_CODE_SESSION_ID: "",
          CLAUDE_SESSION_ID: "",
          GEMINI_SESSION_ID: "",
          MANDIBLE_MANAGED_CLIENT: "",
          MANDIBLE_SESSION_ID: "",
          MANDIBLE_FILE_RPC_TIMEOUT: "30",
          TMPDIR: tempDir,
        },
        stdio: "ignore",
      },
    );
    try {
      const requestPath = await waitForFile(spoolDir, ".request.json");
      expect(fs.statSync(spoolDir).mode & 0o777).toBe(0o700);
      expect(fs.statSync(requestPath).mode & 0o777).toBe(0o600);
      expect(fs.readFileSync(requestPath, "utf8")).toContain("file-rpc-secret");

      child.kill("SIGTERM");
      const exitCode = await new Promise<number | null>((resolve) => {
        child.once("exit", (code) => resolve(code));
      });
      expect(exitCode).toBe(143);
      expect(fs.existsSync(requestPath)).toBe(false);
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

async function waitForFile(dir: string, suffix: string): Promise<string> {
  const match = await waitUntil(
    () => fs.existsSync(dir) && fs.readdirSync(dir).find((entry) => entry.endsWith(suffix)),
    `${suffix} in ${dir}`, 20);
  return path.join(dir, match);
}

function collectRoutePolicies(): Map<string, RoutePolicy> {
  const routeFiles = [
    ...walk(path.join(process.cwd(), "src", "routes")).filter((file) => file.endsWith(".ts")),
    path.join(process.cwd(), "src", "index.ts"),
    path.join(process.cwd(), "src", "server.ts"),
  ];
  const policies = new Map<string, RoutePolicy>();
  for (const file of routeFiles) {
    const text = fs.readFileSync(file, "utf8");
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const visit = (node: ts.Node): void => {
      if (
        ts.isCallExpression(node)
        && node.arguments.length >= 3
        && ts.isStringLiteralLike(node.arguments[0])
        && isRouteMethodCall(node.expression)
      ) {
        const method = node.expression.name.text.toUpperCase();
        const routePath = node.arguments[0].text;
        if (routePath.startsWith("/api/")) {
          policies.set(
            routeKey(method, routePath),
            readFileRpcPolicy(node.arguments[2], source),
          );
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return policies;
}

function collectLegacyAllowedRoutes(): CliRouteRef[] {
  const file = path.join(process.cwd(), "test", "file-rpc-transport.test.ts");
  const source = ts.createSourceFile(
    file,
    fs.readFileSync(file, "utf8"),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const routes: CliRouteRef[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node)
      && ts.isIdentifier(node.name)
      && node.name.text === "legacyAllowedRoutes"
      && node.initializer
      && ts.isArrayLiteralExpression(node.initializer)
    ) {
      for (const entry of node.initializer.elements) {
        if (!ts.isArrayLiteralExpression(entry) || entry.elements.length < 2) {
          continue;
        }
        const [method, routePath] = entry.elements;
        if (ts.isStringLiteralLike(method) && ts.isStringLiteralLike(routePath)) {
          const pos = source.getLineAndCharacterOfPosition(entry.getStart(source));
          routes.push({
            file: path.relative(process.cwd(), file),
            line: pos.line + 1,
            method: method.text,
            route: routePath.text,
          });
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return routes;
}

// Every `api_*`/`secret_*` name a CLI script runs as a command must be a
// function the script defines itself or inherits from the `cli/api.sh` it
// sources. That shared namespace is the whole surface a CLI script talks to the
// daemon through, and a name that resolves to nothing fails only when a human
// runs that exact subcommand.
function collectUndefinedApiHelperCallSites(): string[] {
  const cliDir = path.join(process.cwd(), "cli");
  const shared = collectShellFunctionNames(fs.readFileSync(path.join(cliDir, "api.sh"), "utf8"));
  const undefinedSites: string[] = [];
  for (const file of walk(cliDir).filter(isShellScript)) {
    const text = fs.readFileSync(file, "utf8");
    const defined = new Set([...shared, ...collectShellFunctionNames(text)]);
    const code = blankShellNonCode(text);
    for (const match of code.matchAll(SHELL_HELPER_COMMAND)) {
      const name = match[1];
      if (defined.has(name)) continue;
      const line = code.slice(0, match.index + match[0].indexOf(name)).split("\n").length;
      undefinedSites.push(`${path.relative(process.cwd(), file)}:${line} ${name}`);
    }
  }
  return undefinedSites.sort();
}

// A helper name in command position: at the start of a command, after a
// separator or pipeline operator, inside a command substitution, or after a
// compound-command keyword. A bare `(` is deliberately not an opener, so
// arithmetic like `(( secret_traced == 0 ))` reads as the variable it is.
const SHELL_HELPER_COMMAND =
  /(?:^|[\n;&|{]|\$\(|`|\bif\b|\bthen\b|\belse\b|\belif\b|\bdo\b|\bwhile\b|\buntil\b|!)\s*((?:api|secret)_[a-z0-9_]*)\b(?!=)/g;

function isShellScript(file: string): boolean {
  if (file.endsWith(".sh")) return true;
  if (path.extname(file) !== "") return false;
  return /^#!.*\b(bash|zsh|sh)\b/.test(fs.readFileSync(file, "utf8").split("\n", 1)[0] ?? "");
}

function collectShellFunctionNames(text: string): Set<string> {
  return new Set(
    [...text.matchAll(/^[ \t]*([A-Za-z_][A-Za-z0-9_]*)\(\)/gm)].map((match) => match[1]),
  );
}

// Blank comments and quoted text so only shell code is scanned, preserving
// offsets. Command substitutions stay code even inside double quotes, which is
// how every `response="$(api_send ...)"` call site is written.
function blankShellNonCode(text: string): string {
  const out = [...text];
  const blank = (index: number): void => {
    if (out[index] !== "\n") out[index] = " ";
  };
  const stack: Array<"code" | "dq" | "sq"> = ["code"];
  let i = 0;
  while (i < text.length) {
    const char = text[i];
    const state = stack[stack.length - 1];
    if (state === "sq") {
      if (char === "'") stack.pop();
      else blank(i);
      i += 1;
    } else if (char === "\\" && i + 1 < text.length) {
      if (state === "dq") {
        blank(i);
        blank(i + 1);
      }
      i += 2;
    } else if (char === "$" && text[i + 1] === "(") {
      stack.push("code");
      i += 2;
    } else if (char === ")" && state === "code" && stack.length > 1) {
      stack.pop();
      i += 1;
    } else if (state === "dq") {
      if (char === '"') stack.pop();
      else blank(i);
      i += 1;
    } else if (char === '"' || char === "'") {
      stack.push(char === '"' ? "dq" : "sq");
      i += 1;
    } else if (char === "#" && (i === 0 || " \t\n;&|(".includes(text[i - 1]))) {
      while (i < text.length && text[i] !== "\n") blank(i++);
    } else {
      i += 1;
    }
  }
  return out.join("");
}

function collectCliRouteRefs(): { refs: CliRouteRef[]; unresolved: UnresolvedCliCallSite[] } {
  const refs: CliRouteRef[] = [];
  const unresolved: UnresolvedCliCallSite[] = [];
  for (const file of walk(path.join(process.cwd(), "cli")).filter((entry) => entry.endsWith(".sh"))) {
    const rel = path.relative(process.cwd(), file);
    const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
    lines.forEach((line, index) => {
      for (const ref of extractCliRefsFromLine(line)) {
        refs.push({ ...ref, file: rel, line: index + 1 });
      }
      for (const callSite of extractUnresolvedCliCallSites(line)) {
        unresolved.push({ ...callSite, file: rel, line: index + 1 });
      }
    });
  }
  return { refs, unresolved };
}

function extractCliRefsFromLine(line: string): Array<Omit<CliRouteRef, "file" | "line">> {
  const refs: Array<Omit<CliRouteRef, "file" | "line">> = [];
  const normalizedLine = line
    .replace(/\$\(\s*urlencode\s+"[^"]+"\s*\)/g, ":param")
    .replace(/\$\(\s*urlencode\s+[^)]*\)/g, ":param");
  const regex = /\b(api_get|api_send|api_send_capture|api_send_content)\s+(?:(GET|POST|PUT|PATCH|DELETE)\s+)?(["'])([^"']+)\3/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(normalizedLine)) !== null) {
    const fn = match[1];
    const explicitMethod = match[2];
    const rawPath = match[4];
    const method = fn === "api_get" ? "GET" : explicitMethod;
    if (!method || !rawPath.startsWith("/api/")) {
      continue;
    }
    refs.push({ method, route: normalizeShellRoute(rawPath) });
  }
  return refs;
}

function extractUnresolvedCliCallSites(line: string): Array<Omit<UnresolvedCliCallSite, "file" | "line">> {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) {
    return [];
  }
  const refs = extractCliRefsFromLine(line);
  const regex = /\b(api_get|api_send|api_send_capture|api_send_content)\s+([^#;&|]+)/g;
  const unresolved: Array<Omit<UnresolvedCliCallSite, "file" | "line">> = [];
  let match: RegExpExecArray | null;
  while ((match = regex.exec(line)) !== null) {
    const fn = match[1];
    const detail = match[2].trim().replace(/\s+/g, " ");
    if (refs.some((ref) => callMatchesStaticRef(fn, detail, ref))) {
      continue;
    }
    unresolved.push({ fn, detail });
  }
  return unresolved;
}

function callMatchesStaticRef(
  fn: string,
  detail: string,
  ref: Omit<CliRouteRef, "file" | "line">,
): boolean {
  if (fn === "api_get") {
    return ref.method === "GET" && startsWithQuotedApiPath(detail);
  }
  return new RegExp(`^(?:${ref.method}\\s+)?["']/api/`).test(detail);
}

function startsWithQuotedApiPath(detail: string): boolean {
  return /^["']\/api\//.test(detail);
}

function isRouteMethodCall(expression: ts.Expression): expression is ts.PropertyAccessExpression {
  if (!ts.isPropertyAccessExpression(expression) && !ts.isPropertyAccessChain(expression)) {
    return false;
  }
  return ["get", "post", "put", "patch", "delete"].includes(expression.name.text);
}

function readFileRpcPolicy(node: ts.Expression, _source: ts.SourceFile): RoutePolicy {
  if (!ts.isObjectLiteralExpression(node)) throw new Error('Nonliteral route options');
  const property = node.properties.find((entry): entry is ts.PropertyAssignment =>
    ts.isPropertyAssignment(entry) && (ts.isIdentifier(entry.name) || ts.isStringLiteral(entry.name))
      && entry.name.text === 'fileRpc');
  if (!property) throw new Error('Missing file-RPC route policy');
  const value = property.initializer;
  if (ts.isStringLiteral(value) && (value.text === 'allow' || value.text === 'deny')) return value.text;
  if (ts.isObjectLiteralExpression(value)) return 'conditional';
  throw new Error('Invalid file-RPC route policy');
}

function normalizeShellRoute(input: string): string {
  const queryless = input
    .replace(/\$\{query\}$/, "")
    .split("?")[0];
  return normalizeRoutePattern(
    queryless
      .replace(/\$\([^)]*\)/g, ":param")
      .replace(/\$\{[^}]+\}/g, ":param")
      .replace(/\$[A-Za-z_][A-Za-z0-9_]*/g, ":param"),
  );
}

function routeKey(method: string, routePath: string): string {
  return `${method.toUpperCase()} ${normalizeRoutePattern(routePath)}`;
}

function normalizeRoutePattern(routePath: string): string {
  return routePath
    .split("?")[0]
    .split("/")
    .map((part) => (part.startsWith(":") ? ":param" : part))
    .join("/");
}

function formatRefs(refs: CliRouteRef[]): string[] {
  return refs.map((ref) => `${ref.file}:${ref.line} ${ref.method} ${ref.route}`);
}

function formatUnresolved(refs: UnresolvedCliCallSite[]): string[] {
  return refs.map((ref) => `${ref.file}:${ref.line} ${ref.fn} ${ref.detail}`).sort();
}

function walk(root: string): string[] {
  const entries: string[] = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      entries.push(...walk(fullPath));
    } else {
      entries.push(fullPath);
    }
  }
  return entries;
}
