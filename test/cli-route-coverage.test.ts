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
  "cli/conversations.sh:84 api_get \"$request\")",
  "cli/conversations.sh:236 api_get \"$request\")",
  "cli/conversations.sh:287 api_get \"$request\")",
  "cli/inbox.sh:38 api_get \"$url\")",
  "cli/inbox.sh:84 api_get \"$url\")",
  "cli/issue.sh:920 api_get \"$checkpoint_path\") \\",
  "cli/issue.sh:930 api_get \"$checkpoint_path\") \\",
  "cli/issue.sh:1201 api_get \"$path\") \\",
  "cli/ledger-client.sh:40 api_send_capture \"$method\" \"$request_path\" \"$data\" \"$tmp_response\")",
  "cli/logs.sh:63 api_get \"$request\")",
  "cli/logs.sh:107 api_get \"$request\")",
  "cli/search.sh:101 api_get \"$request\"",
  "cli/space.sh:81 api_send POST \"$1\" \"$2\"",
  "cli/umbrella.sh:82 api_get \"$path\") \\",
] as const;

describe("CLI API route coverage", () => {
  it("keeps static CLI API calls covered by registered file-RPC route policy", () => {
    const policies = collectRoutePolicies();
    const { refs, unresolved } = collectCliRouteRefs();
    const missing = refs.filter((ref) => !policies.has(routeKey(ref.method, ref.route)));
    const denied = refs.filter((ref) => policies.get(routeKey(ref.method, ref.route)) === "deny");

    expect(formatRefs(missing)).toEqual([]);
    expect(formatRefs(denied)).toEqual([]);
    expect(formatUnresolved(unresolved)).toEqual([...EXPECTED_DYNAMIC_CLI_API_CALL_SITES].sort());
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
      const helper = fs.readFileSync(helperPath, "utf8");
      expect(helper).toContain('api_track_temp "$request_tmp"');
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("emits a fragment-only dashboard enrollment link from the protected bootstrap file", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-dashboard-link-"));
    const authDir = path.join(tempDir, "client-auth");
    fs.mkdirSync(authDir, { recursive: true });
    fs.writeFileSync(path.join(authDir, "bootstrap-token"), "secret with spaces", { mode: 0o600 });
    try {
      const result = spawnSync(
        "zsh",
        [path.join(process.cwd(), "cli", "user.sh"), "dashboard-link"],
        {
          env: {
            ...process.env,
            MANDIBLE_CLI_DIR: path.join(process.cwd(), "cli"),
            MANDIBLE_CONFIG_DIR: tempDir,
            MANDIBLE_BASE: "http://127.0.0.1:19420",
            // api_client_token prefers an explicit MANDIBLE_TOKEN and then the
            // durable operator keychain credential over the bootstrap file, so
            // without these two the assertion compares against — and on failure
            // prints — the real bearer token of whoever ran the suite.
            MANDIBLE_TOKEN: "",
            MANDIBLE_NO_KEYCHAIN_TOKEN: "1",
            CODEX_THREAD_ID: "",
            CLAUDE_SESSION_ID: "",
            MANDIBLE_SESSION_ID: "",
          },
          encoding: "utf8",
        },
      );
      expect(result.status).toBe(0);
      expect(result.stdout.trim()).toBe(
        "http://127.0.0.1:19420/#/?mandible_auth=secret%20with%20spaces",
      );
      expect(fs.existsSync(path.join(authDir, "bootstrap-token"))).toBe(false);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("never gives an unbound Mandible-managed process the operator bootstrap token", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-managed-client-"));
    const authDir = path.join(tempDir, "client-auth");
    fs.mkdirSync(authDir, { recursive: true });
    fs.writeFileSync(path.join(authDir, "bootstrap-token"), "operator-secret", { mode: 0o600 });
    try {
      const result = spawnSync(
        "zsh",
        ["-c", 'source "$API_HELPER_PATH"; api_client_token'],
        {
          env: {
            ...process.env,
            API_HELPER_PATH: path.join(process.cwd(), "cli", "api.sh"),
            MANDIBLE_CONFIG_DIR: tempDir,
            MANDIBLE_MANAGED_CLIENT: "1",
            MANDIBLE_TOKEN: "",
            CODEX_THREAD_ID: "",
            CLAUDE_SESSION_ID: "",
            MANDIBLE_SESSION_ID: "",
            TMPDIR: tempDir,
          },
          encoding: "utf8",
        },
      );
      expect(result.status).toBe(0);
      expect(result.stdout).toBe("");
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
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    if (fs.existsSync(dir)) {
      const match = fs.readdirSync(dir).find((entry) => entry.endsWith(suffix));
      if (match) return path.join(dir, match);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for ${suffix} in ${dir}`);
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

function readFileRpcPolicy(node: ts.Expression, source: ts.SourceFile): RoutePolicy {
  const text = node.getText(source);
  if (/fileRpc\s*:\s*"allow"/.test(text)) {
    return "allow";
  }
  if (/fileRpc\s*:\s*\{/.test(text)) {
    return "conditional";
  }
  return "deny";
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
