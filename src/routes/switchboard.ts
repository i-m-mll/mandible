import crypto from "node:crypto";
import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { RequestLike, ResponseLike, RouteRegistrar } from "../server.js";

const STATE_FILE = path.join(os.homedir(), ".config", "switchboard", "state.json");
const PAIRINGS_FILE = path.join(os.homedir(), ".dotfiles", "private", "switchboard", "pairings.json");
const TEMPLATES_FILE = path.join(os.homedir(), ".dotfiles", "private", "switchboard", "hook_templates.json");

function sendJson(res: ResponseLike, code: number, payload: unknown): void {
  res.status(code).json(payload);
}

function readBody<T>(req: RequestLike): T {
  return (req.body ?? {}) as T;
}

// --- Types ---

interface PairingsFile {
  [name: string]: {
    source: string;
    target: string;
    hook_setup?: string;
    hook_teardown?: string;
  };
}

interface PairingHooks {
  hook_setup?: string;
  hook_teardown?: string;
}

export interface HookTemplate {
  id: string;
  name: string;
  hook_setup?: string;
  hook_teardown?: string;
  builtin?: boolean;
}

const MLL_BIO_SETUP = `python3 -c "
import re, os, sys
f = os.environ.get('SWITCHBOARD_REAL', '')
if os.path.isdir(f):
    name = os.path.basename(f)
    found = False
    for ext in ['.md', '.mdx']:
        c = os.path.join(f, name + ext)
        if os.path.exists(c):
            f = c
            found = True
            break
    if not found:
        c = os.path.join(f, '_series.md')
        if os.path.exists(c):
            f = c
if not os.path.isfile(f):
    sys.exit(0)
if not (f.endswith('.md') or f.endswith('.mdx')):
    sys.exit(0)
content = open(f).read()
if re.search(r'^draft:.*$', content, re.MULTILINE):
    content = re.sub(r'^draft:.*$', 'draft: false', content, flags=re.MULTILINE)
else:
    content = re.sub(r'^(---\\n)', r'\\g<1>draft: false\\n', content, count=1)
open(f, 'w').write(content)
"`;

const MLL_BIO_TEARDOWN = `python3 -c "
import re, os, sys
f = os.environ.get('SWITCHBOARD_REAL', '')
if os.path.isdir(f):
    name = os.path.basename(f)
    found = False
    for ext in ['.md', '.mdx']:
        c = os.path.join(f, name + ext)
        if os.path.exists(c):
            f = c
            found = True
            break
    if not found:
        c = os.path.join(f, '_series.md')
        if os.path.exists(c):
            f = c
if not os.path.isfile(f):
    sys.exit(0)
if not (f.endswith('.md') or f.endswith('.mdx')):
    sys.exit(0)
content = open(f).read()
if re.search(r'^draft:.*$', content, re.MULTILINE):
    content = re.sub(r'^draft:.*$', 'draft: true', content, flags=re.MULTILINE)
else:
    content = re.sub(r'^(---\\n)', r'\\g<1>draft: true\\n', content, count=1)
open(f, 'w').write(content)
"`;

const BUILTIN_TEMPLATES: HookTemplate[] = [
  {
    id: "mll-bio-draft",
    name: "mll.bio draft management",
    builtin: true,
    hook_setup: MLL_BIO_SETUP,
    hook_teardown: MLL_BIO_TEARDOWN,
  },
];

function loadUserTemplates(): HookTemplate[] {
  try {
    if (!fs.existsSync(TEMPLATES_FILE)) return [];
    return JSON.parse(fs.readFileSync(TEMPLATES_FILE, "utf-8")) as HookTemplate[];
  } catch {
    return [];
  }
}

function saveUserTemplates(templates: HookTemplate[]): void {
  const dir = path.dirname(TEMPLATES_FILE);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(TEMPLATES_FILE, JSON.stringify(templates, null, 2) + "\n", "utf-8");
}

function getAllTemplates(): HookTemplate[] {
  return [...BUILTIN_TEMPLATES, ...loadUserTemplates()];
}

// --- Hook runner ---

function runHook(hookCmd: string, itemName: string, source: string, target: string): string | null {
  const realPath = path.resolve(path.join(source, itemName));
  const env = {
    ...process.env,
    SWITCHBOARD_ITEM: itemName,
    SWITCHBOARD_SOURCE: source,
    SWITCHBOARD_TARGET: target,
    SWITCHBOARD_LINK: path.join(target, itemName),
    SWITCHBOARD_REAL: realPath,
  };
  try {
    execSync(hookCmd, { env, stdio: "pipe" });
    return null;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return `hook failed: ${message}`;
  }
}

interface StateConnection {
  source: string;
  target: string;
  linked: string[];
}

interface StateFile {
  connections: { [connId: string]: StateConnection };
}

// --- Helpers ---

function connectionId(source: string, target: string): string {
  const resolved = `${path.resolve(source)}|${path.resolve(target)}`;
  return crypto.createHash("sha256").update(resolved).digest("hex").slice(0, 8);
}

function loadPairings(): PairingsFile {
  try {
    if (!fs.existsSync(PAIRINGS_FILE)) return {};
    return JSON.parse(fs.readFileSync(PAIRINGS_FILE, "utf-8")) as PairingsFile;
  } catch {
    return {};
  }
}

function savePairings(pairings: PairingsFile): void {
  const dir = path.dirname(PAIRINGS_FILE);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(PAIRINGS_FILE, JSON.stringify(pairings, null, 2) + "\n", "utf-8");
}

function loadState(): StateFile {
  try {
    if (!fs.existsSync(STATE_FILE)) return { connections: {} };
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf-8")) as StateFile;
  } catch {
    return { connections: {} };
  }
}

function saveState(state: StateFile): void {
  const dir = path.dirname(STATE_FILE);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2) + "\n", "utf-8");
}

function getLinkedSet(state: StateFile, connId: string): Set<string> {
  const conn = state.connections[connId];
  if (!conn) return new Set();
  return new Set(conn.linked ?? []);
}

function setLinkedSet(
  state: StateFile,
  connId: string,
  source: string,
  target: string,
  linked: Set<string>
): void {
  if (!state.connections) state.connections = {};
  state.connections[connId] = {
    source: path.resolve(source),
    target: path.resolve(target),
    linked: Array.from(linked).sort(),
  };
}

type ItemState = "linked" | "unlinked" | "broken" | "conflict";

interface ClassifiedItem {
  name: string;
  state: ItemState;
  is_dir: boolean;
}

function classifyItems(
  source: string,
  target: string,
  linkedNames: Set<string>
): ClassifiedItem[] {
  const items: ClassifiedItem[] = [];

  let sourceEntries: string[];
  try {
    sourceEntries = fs.readdirSync(source).sort();
  } catch {
    return items;
  }

  for (const name of sourceEntries) {
    const srcPath = path.join(source, name);
    const tgtPath = path.join(target, name);

    let is_dir = false;
    try {
      is_dir = fs.statSync(srcPath).isDirectory();
    } catch {
      // ignore stat errors
    }

    const inConfig = linkedNames.has(name);
    let state: ItemState;

    if (inConfig) {
      const isSymlink = (() => {
        try { return fs.lstatSync(tgtPath).isSymbolicLink(); } catch { return false; }
      })();
      const tgtExists = (() => {
        try { fs.statSync(tgtPath); return true; } catch { return false; }
      })();

      if (isSymlink) {
        try {
          const linkTarget = fs.realpathSync(tgtPath);
          const expected = fs.realpathSync(srcPath);
          state = linkTarget === expected ? "linked" : "conflict";
        } catch {
          // Dangling symlink
          state = "broken";
        }
      } else if (tgtExists) {
        state = "conflict";
      } else {
        state = "broken";
      }
    } else {
      const isSymlink = (() => {
        try { return fs.lstatSync(tgtPath).isSymbolicLink(); } catch { return false; }
      })();
      const tgtExists = (() => {
        try { fs.statSync(tgtPath); return true; } catch { return false; }
      })();

      if (isSymlink) {
        // Anything symlinked there that we don't manage is a conflict
        state = "conflict";
      } else if (tgtExists) {
        state = "conflict";
      } else {
        state = "unlinked";
      }
    }

    items.push({ name, state, is_dir });
  }

  return items;
}

type PairingEntry = PairingsFile[string];

function runConsistencyCheck(
  _name: string,
  pairing: PairingEntry,
): Array<{ item: string; error: string }> {
  const { source, target, hook_setup, hook_teardown } = pairing;
  const errors: Array<{ item: string; error: string }> = [];

  if (!hook_setup && !hook_teardown) {
    return errors;
  }

  let sourceEntries: string[];
  try {
    sourceEntries = fs.readdirSync(source).sort();
  } catch {
    return errors;
  }

  for (const itemName of sourceEntries) {
    const tgtPath = path.join(target, itemName);
    const isSymlink = (() => {
      try { return fs.lstatSync(tgtPath).isSymbolicLink(); } catch { return false; }
    })();
    const tgtExists = (() => {
      try { fs.statSync(tgtPath); return true; } catch { return false; }
    })();
    const linked = isSymlink || tgtExists;

    if (linked && hook_setup) {
      const err = runHook(hook_setup, itemName, source, target);
      if (err) errors.push({ item: itemName, error: err });
    } else if (!linked && hook_teardown) {
      const err = runHook(hook_teardown, itemName, source, target);
      if (err) errors.push({ item: itemName, error: err });
    }
  }

  return errors;
}

export function registerSwitchboardRoutes(server: RouteRegistrar): void {
  // GET /api/switchboard/pairings
  server.get("/api/switchboard/pairings", (_req, res) => {
    const pairings = loadPairings();
    const result = Object.entries(pairings)
      .map(([name, p]) => ({
        name,
        source: p.source,
        target: p.target,
        hook_setup: p.hook_setup,
        hook_teardown: p.hook_teardown,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
    sendJson(res, 200, { pairings: result });
  });

  // POST /api/switchboard/pairings
  server.post("/api/switchboard/pairings", (req, res) => {
    const body = readBody<{ name?: unknown; source?: unknown; target?: unknown; hook_setup?: unknown; hook_teardown?: unknown }>(req);
    const name = typeof body.name === "string" ? body.name.trim() : "";
    const source = typeof body.source === "string" ? body.source.trim() : "";
    const target = typeof body.target === "string" ? body.target.trim() : "";
    const hookSetup = typeof body.hook_setup === "string" && body.hook_setup.trim() ? body.hook_setup.trim() : undefined;
    const hookTeardown = typeof body.hook_teardown === "string" && body.hook_teardown.trim() ? body.hook_teardown.trim() : undefined;

    if (!name) {
      sendJson(res, 400, { error: "name is required" });
      return;
    }
    if (!source || !target) {
      sendJson(res, 400, { error: "source and target are required" });
      return;
    }

    try {
      const srcStat = fs.statSync(source);
      if (!srcStat.isDirectory()) {
        sendJson(res, 400, { error: `source is not a directory: ${source}` });
        return;
      }
    } catch {
      sendJson(res, 400, { error: `source directory does not exist: ${source}` });
      return;
    }

    try {
      const tgtStat = fs.statSync(target);
      if (!tgtStat.isDirectory()) {
        sendJson(res, 400, { error: `target is not a directory: ${target}` });
        return;
      }
    } catch {
      sendJson(res, 400, { error: `target directory does not exist: ${target}` });
      return;
    }

    const pairings = loadPairings();

    // Duplicate guard: check if any existing pairing has the same source+target
    const duplicate = Object.entries(pairings).find(
      ([, p]) =>
        path.resolve(p.source) === path.resolve(source) &&
        path.resolve(p.target) === path.resolve(target)
    );
    if (duplicate) {
      sendJson(res, 409, { error: "A pairing with this source and target already exists." });
      return;
    }

    const entry: PairingsFile[string] = { source, target };
    if (hookSetup) entry.hook_setup = hookSetup;
    if (hookTeardown) entry.hook_teardown = hookTeardown;
    pairings[name] = entry;
    savePairings(pairings);

    sendJson(res, 200, { ok: true, pairing: { name, source, target, hook_setup: hookSetup, hook_teardown: hookTeardown } });
  });

  // PATCH /api/switchboard/pairings/:name
  server.patch("/api/switchboard/pairings/:name", (req, res) => {
    const name = req.params.name;
    if (!name) {
      sendJson(res, 400, { error: "name is required" });
      return;
    }

    const body = readBody<{ source?: unknown; target?: unknown; hook_setup?: unknown; hook_teardown?: unknown }>(req);
    const newSource = typeof body.source === "string" ? body.source.trim() : "";
    const newTarget = typeof body.target === "string" ? body.target.trim() : "";
    // null means "clear the hook"; undefined means "keep existing"
    const newHookSetup = body.hook_setup === null ? null : typeof body.hook_setup === "string" ? body.hook_setup.trim() || undefined : undefined;
    const newHookTeardown = body.hook_teardown === null ? null : typeof body.hook_teardown === "string" ? body.hook_teardown.trim() || undefined : undefined;

    if (!newSource || !newTarget) {
      sendJson(res, 400, { error: "source and target are required" });
      return;
    }

    try {
      const srcStat = fs.statSync(newSource);
      if (!srcStat.isDirectory()) {
        sendJson(res, 400, { error: `source is not a directory: ${newSource}` });
        return;
      }
    } catch {
      sendJson(res, 400, { error: `source directory does not exist: ${newSource}` });
      return;
    }

    try {
      const tgtStat = fs.statSync(newTarget);
      if (!tgtStat.isDirectory()) {
        sendJson(res, 400, { error: `target is not a directory: ${newTarget}` });
        return;
      }
    } catch {
      sendJson(res, 400, { error: `target directory does not exist: ${newTarget}` });
      return;
    }

    const pairings = loadPairings();
    if (!pairings[name]) {
      sendJson(res, 404, { error: `pairing not found: ${name}` });
      return;
    }

    const existing = pairings[name];
    const updatedEntry: PairingsFile[string] = { source: newSource, target: newTarget };
    // Determine hook_setup: null clears it, string updates it, undefined preserves existing
    const resolvedSetup = body.hook_setup !== undefined ? newHookSetup : existing.hook_setup;
    const resolvedTeardown = body.hook_teardown !== undefined ? newHookTeardown : existing.hook_teardown;
    if (resolvedSetup) updatedEntry.hook_setup = resolvedSetup;
    if (resolvedTeardown) updatedEntry.hook_teardown = resolvedTeardown;
    pairings[name] = updatedEntry;
    savePairings(pairings);

    sendJson(res, 200, { ok: true, pairing: { name, source: newSource, target: newTarget, hook_setup: resolvedSetup, hook_teardown: resolvedTeardown } });
  });

  // DELETE /api/switchboard/pairings/:name
  server.delete("/api/switchboard/pairings/:name", (req, res) => {
    const name = req.params.name;
    if (!name) {
      sendJson(res, 400, { error: "name is required" });
      return;
    }
    const pairings = loadPairings();
    delete pairings[name];
    savePairings(pairings);
    sendJson(res, 200, { ok: true });
  });

  // GET /api/switchboard/pairings/:name/items
  server.get("/api/switchboard/pairings/:name/items", (req, res) => {
    const name = req.params.name;
    if (!name) {
      sendJson(res, 400, { error: "name is required" });
      return;
    }

    const pairings = loadPairings();
    const pairing = pairings[name];
    if (!pairing) {
      sendJson(res, 404, { error: `pairing not found: ${name}` });
      return;
    }

    const { source, target } = pairing;

    // Run consistency check before classifying items
    const consistencyErrors = runConsistencyCheck(name, pairing);

    const connId = connectionId(source, target);
    const state = loadState();
    const linked = getLinkedSet(state, connId);
    const items = classifyItems(source, target, linked);

    const response: Record<string, unknown> = {
      pairing: { name, source, target, hook_setup: pairing.hook_setup, hook_teardown: pairing.hook_teardown },
      items,
    };
    if (consistencyErrors.length > 0) {
      response.consistencyErrors = consistencyErrors;
    }

    sendJson(res, 200, response);
  });

  // POST /api/switchboard/pairings/:name/toggle
  server.post("/api/switchboard/pairings/:name/toggle", (req, res) => {
    const name = req.params.name;
    if (!name) {
      sendJson(res, 400, { error: "name is required" });
      return;
    }

    const body = readBody<{ item?: unknown }>(req);
    const itemName = typeof body.item === "string" ? body.item : "";
    if (!itemName) {
      sendJson(res, 400, { error: "item is required" });
      return;
    }

    const pairings = loadPairings();
    const pairing = pairings[name];
    if (!pairing) {
      sendJson(res, 404, { error: `pairing not found: ${name}` });
      return;
    }

    const { source, target, hook_setup, hook_teardown } = pairing;
    const connId = connectionId(source, target);
    const state = loadState();
    const linked = getLinkedSet(state, connId);

    // Classify current item state
    const items = classifyItems(source, target, linked);
    const item = items.find((i) => i.name === itemName);
    if (!item) {
      sendJson(res, 404, { error: `item not found: ${itemName}` });
      return;
    }

    if (item.state === "conflict") {
      sendJson(res, 400, { error: "conflict: real file exists at target" });
      return;
    }

    const srcPath = path.join(source, itemName);
    const tgtPath = path.join(target, itemName);

    if (item.state === "linked") {
      // Unlink: remove symlink and remove from config
      linked.delete(itemName);
      try {
        const lstat = fs.lstatSync(tgtPath);
        if (lstat.isSymbolicLink()) {
          fs.unlinkSync(tgtPath);
        }
      } catch {
        // ignore removal errors
      }
      setLinkedSet(state, connId, source, target, linked);
      saveState(state);
      let hookError: string | undefined;
      if (hook_teardown) {
        const err = runHook(hook_teardown, itemName, source, target);
        if (err) hookError = err;
      }
      sendJson(res, 200, { ok: true, item: itemName, state: "unlinked", ...(hookError ? { hookError } : {}) });
    } else if (item.state === "unlinked") {
      // Link: add to config, create symlink
      linked.add(itemName);
      try {
        const tgtDir = path.dirname(tgtPath);
        if (!fs.existsSync(tgtDir)) {
          fs.mkdirSync(tgtDir, { recursive: true });
        }
        fs.symlinkSync(path.resolve(srcPath), tgtPath);
      } catch (err) {
        sendJson(res, 500, { error: `failed to create symlink: ${String(err)}` });
        return;
      }
      setLinkedSet(state, connId, source, target, linked);
      saveState(state);
      let hookError: string | undefined;
      if (hook_setup) {
        const err = runHook(hook_setup, itemName, source, target);
        if (err) hookError = err;
      }
      sendJson(res, 200, { ok: true, item: itemName, state: "linked", ...(hookError ? { hookError } : {}) });
    } else if (item.state === "broken") {
      // Broken: already in linked set; attempt to create symlink
      linked.add(itemName);
      // Remove any dangling symlink first
      try {
        const lstat = fs.lstatSync(tgtPath);
        if (lstat.isSymbolicLink()) {
          fs.unlinkSync(tgtPath);
        }
      } catch {
        // ignore
      }
      try {
        const tgtDir = path.dirname(tgtPath);
        if (!fs.existsSync(tgtDir)) {
          fs.mkdirSync(tgtDir, { recursive: true });
        }
        fs.symlinkSync(path.resolve(srcPath), tgtPath);
      } catch (err) {
        sendJson(res, 500, { error: `failed to recreate symlink: ${String(err)}` });
        return;
      }
      setLinkedSet(state, connId, source, target, linked);
      saveState(state);
      let hookError: string | undefined;
      if (hook_setup) {
        const err = runHook(hook_setup, itemName, source, target);
        if (err) hookError = err;
      }
      sendJson(res, 200, { ok: true, item: itemName, state: "linked", ...(hookError ? { hookError } : {}) });
    } else {
      sendJson(res, 400, { error: `unexpected item state: ${item.state}` });
    }
  });

  // POST /api/switchboard/pairings/:name/sync
  server.post("/api/switchboard/pairings/:name/sync", (req, res) => {
    const name = req.params.name;
    if (!name) {
      sendJson(res, 400, { error: "name is required" });
      return;
    }

    const pairings = loadPairings();
    const pairing = pairings[name];
    if (!pairing) {
      sendJson(res, 404, { error: `pairing not found: ${name}` });
      return;
    }

    const { source, target } = pairing;
    const connId = connectionId(source, target);
    const state = loadState();
    const linked = getLinkedSet(state, connId);
    const errors: string[] = [];

    // Create symlinks for everything in linked set
    for (const itemName of linked) {
      const srcPath = path.join(source, itemName);
      const tgtPath = path.join(target, itemName);

      let srcExists = false;
      try {
        srcExists = fs.existsSync(srcPath);
      } catch {
        // ignore
      }

      if (!srcExists) {
        errors.push(`${itemName}: source missing`);
        continue;
      }

      const isSymlink = (() => {
        try { return fs.lstatSync(tgtPath).isSymbolicLink(); } catch { return false; }
      })();
      const tgtExists = (() => {
        try { fs.statSync(tgtPath); return true; } catch { return false; }
      })();

      if (isSymlink) {
        try {
          const resolved = fs.realpathSync(tgtPath);
          const expected = fs.realpathSync(srcPath);
          if (resolved === expected) continue; // already correct
        } catch {
          // dangling
        }
        // Wrong symlink — remove and recreate
        try {
          fs.unlinkSync(tgtPath);
        } catch (err) {
          errors.push(`${itemName}: could not remove stale symlink: ${String(err)}`);
          continue;
        }
        try {
          fs.symlinkSync(path.resolve(srcPath), tgtPath);
        } catch (err) {
          errors.push(`${itemName}: ${String(err)}`);
        }
      } else if (tgtExists) {
        errors.push(`${itemName}: conflict (real file exists)`);
      } else {
        try {
          const tgtDir = path.dirname(tgtPath);
          if (!fs.existsSync(tgtDir)) {
            fs.mkdirSync(tgtDir, { recursive: true });
          }
          fs.symlinkSync(path.resolve(srcPath), tgtPath);
        } catch (err) {
          errors.push(`${itemName}: ${String(err)}`);
        }
      }
    }

    // Remove our symlinks not in linked set
    let targetEntries: string[] = [];
    try {
      targetEntries = fs.readdirSync(target);
    } catch {
      // ignore
    }

    const resolvedSource = path.resolve(source);
    for (const entry of targetEntries) {
      const tgtPath = path.join(target, entry);
      let isSymlink = false;
      try { isSymlink = fs.lstatSync(tgtPath).isSymbolicLink(); } catch { continue; }
      if (!isSymlink) continue;

      let linkTarget = "";
      try {
        linkTarget = fs.realpathSync(tgtPath);
      } catch {
        continue;
      }

      if (linkTarget.startsWith(resolvedSource) && !linked.has(entry)) {
        try {
          fs.unlinkSync(tgtPath);
        } catch {
          // ignore cleanup errors
        }
      }
    }

    sendJson(res, 200, { ok: true, errors });
  });

  // GET /api/switchboard/templates
  server.get("/api/switchboard/templates", (_req, res) => {
    sendJson(res, 200, { templates: getAllTemplates() });
  });

  // POST /api/switchboard/templates
  server.post("/api/switchboard/templates", (req, res) => {
    const body = readBody<{ name?: unknown; hook_setup?: unknown; hook_teardown?: unknown }>(req);
    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (!name) {
      sendJson(res, 400, { error: "name is required" });
      return;
    }
    const hookSetup = typeof body.hook_setup === "string" && body.hook_setup.trim() ? body.hook_setup.trim() : undefined;
    const hookTeardown = typeof body.hook_teardown === "string" && body.hook_teardown.trim() ? body.hook_teardown.trim() : undefined;

    const id = crypto.randomUUID();
    const template: HookTemplate = { id, name };
    if (hookSetup) template.hook_setup = hookSetup;
    if (hookTeardown) template.hook_teardown = hookTeardown;

    const templates = loadUserTemplates();
    templates.push(template);
    saveUserTemplates(templates);

    sendJson(res, 200, template);
  });

  // DELETE /api/switchboard/templates/:id
  server.delete("/api/switchboard/templates/:id", (req, res) => {
    const id = req.params.id;
    if (!id) {
      sendJson(res, 400, { error: "id is required" });
      return;
    }
    // Refuse to delete built-in templates
    const isBuiltin = BUILTIN_TEMPLATES.some((t) => t.id === id);
    if (isBuiltin) {
      sendJson(res, 403, { error: "Cannot delete a built-in template" });
      return;
    }
    const templates = loadUserTemplates();
    const updated = templates.filter((t) => t.id !== id);
    saveUserTemplates(updated);
    sendJson(res, 200, { ok: true });
  });
}
