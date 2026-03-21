/**
 * Tests for the presets module: Markdown parser/serializer round-trip,
 * union engine, content hashing, token estimation, and routing.
 * Bug: 61bee4e
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { openDb, migrate, type Db } from "../src/db.js";
import {
  parseMarkdownToNodes,
  serializeNodesToMarkdown,
  computeContentHash,
  estimateTokens,
  computePresetUnion,
  routePresetDiff,
  MODEL_CONTEXT_WINDOWS,
  type Preset,
  type PresetNode,
} from "../src/presets.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

let tempDir: string;
let db: Db;

function createTempDb(): Db {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-presets-test-"));
  const dbPath = path.join(tempDir, "test.db");
  // openDb runs all migrations; on a fresh DB, migration 36 hits a "duplicate column"
  // error because migration 16 already creates the conversation_blocks table with those
  // columns. This is a pre-existing bug (not related to presets). Workaround: catch and
  // create just the tables we need for presets testing.
  try {
    return openDb(dbPath);
  } catch {
    const fallbackDb = new Database(dbPath);
    fallbackDb.pragma("journal_mode = WAL");
    // Manually create the preset tables needed for tests
    fallbackDb.exec(`CREATE TABLE IF NOT EXISTS presets (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
      source TEXT NOT NULL DEFAULT 'manual', source_path TEXT, content_hash TEXT NOT NULL DEFAULT '',
      version INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    )`);
    fallbackDb.exec(`CREATE TABLE IF NOT EXISTS preset_nodes (
      id TEXT PRIMARY KEY, preset_id TEXT NOT NULL REFERENCES presets(id) ON DELETE CASCADE,
      parent_id TEXT, position INTEGER NOT NULL DEFAULT 0,
      title TEXT NOT NULL DEFAULT '', body TEXT NOT NULL DEFAULT '',
      level INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    )`);
    fallbackDb.exec(`CREATE TABLE IF NOT EXISTS session_presets (
      session_id TEXT NOT NULL, preset_id TEXT NOT NULL,
      preset_version INTEGER NOT NULL DEFAULT 1, position INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (session_id, preset_id)
    )`);
    fallbackDb.exec(`CREATE TABLE IF NOT EXISTS preset_diffs (
      id TEXT PRIMARY KEY, session_id TEXT NOT NULL, preset_id TEXT, node_id TEXT,
      diff_type TEXT NOT NULL, old_content TEXT, new_content TEXT,
      status TEXT NOT NULL DEFAULT 'proposed', created_at INTEGER NOT NULL
    )`);
    return fallbackDb;
  }
}

function cleanupTemp(): void {
  if (tempDir) {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function insertPreset(preset: Partial<Preset> & { id: string; name: string }): void {
  const now = Date.now();
  db.prepare(
    `INSERT INTO presets (id, name, description, source, source_path, content_hash, version, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    preset.id,
    preset.name,
    preset.description ?? "",
    preset.source ?? "manual",
    preset.source_path ?? null,
    preset.content_hash ?? "",
    preset.version ?? 1,
    preset.created_at ?? now,
    preset.updated_at ?? now,
  );
}

function insertNodes(nodes: PresetNode[]): void {
  const stmt = db.prepare(
    `INSERT INTO preset_nodes (id, preset_id, parent_id, position, title, body, level, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const n of nodes) {
    stmt.run(n.id, n.preset_id, n.parent_id, n.position, n.title, n.body, n.level, n.created_at, n.updated_at);
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Markdown Parser", () => {
  it("parses headings into nodes with correct levels", () => {
    const md = "# Title\nSome content\n## Subtitle\nMore content";
    const nodes = parseMarkdownToNodes(md, "preset-1");

    expect(nodes.length).toBe(2);
    expect(nodes[0].title).toBe("Title");
    expect(nodes[0].level).toBe(1);
    expect(nodes[0].body).toContain("Some content");
    expect(nodes[1].title).toBe("Subtitle");
    expect(nodes[1].level).toBe(2);
    expect(nodes[1].body).toContain("More content");
  });

  it("creates parent-child relationships from heading depth", () => {
    const md = "# Parent\n## Child\n### Grandchild";
    const nodes = parseMarkdownToNodes(md, "preset-1");

    expect(nodes.length).toBe(3);
    // Parent has no parent
    expect(nodes[0].parent_id).toBeNull();
    // Child's parent is Parent
    expect(nodes[1].parent_id).toBe(nodes[0].id);
    // Grandchild's parent is Child
    expect(nodes[2].parent_id).toBe(nodes[1].id);
  });

  it("handles pre-heading content as synthetic root node", () => {
    const md = "Some preamble text\n\n# First Heading\nContent";
    const nodes = parseMarkdownToNodes(md, "preset-1");

    expect(nodes.length).toBe(2);
    // First node is synthetic root
    expect(nodes[0].title).toBe("");
    expect(nodes[0].level).toBe(0);
    expect(nodes[0].body).toContain("Some preamble text");
    // Second node is the heading
    expect(nodes[1].title).toBe("First Heading");
  });

  it("handles sibling headings at the same level", () => {
    const md = "# First\nContent A\n# Second\nContent B\n# Third\nContent C";
    const nodes = parseMarkdownToNodes(md, "preset-1");

    expect(nodes.length).toBe(3);
    // All are siblings (no parent)
    expect(nodes[0].parent_id).toBeNull();
    expect(nodes[1].parent_id).toBeNull();
    expect(nodes[2].parent_id).toBeNull();
  });

  it("handles empty document", () => {
    const nodes = parseMarkdownToNodes("", "preset-1");
    expect(nodes.length).toBe(0);
  });

  it("handles document with only whitespace", () => {
    const nodes = parseMarkdownToNodes("   \n  \n  ", "preset-1");
    expect(nodes.length).toBe(0);
  });

  it("assigns unique IDs to each node", () => {
    const md = "# A\n## B\n## C\n# D";
    const nodes = parseMarkdownToNodes(md, "preset-1");

    const ids = nodes.map((n) => n.id);
    const uniqueIds = new Set(ids);
    expect(uniqueIds.size).toBe(ids.length);
  });

  it("assigns correct preset_id to all nodes", () => {
    const md = "# A\n## B";
    const nodes = parseMarkdownToNodes(md, "my-preset");
    for (const n of nodes) {
      expect(n.preset_id).toBe("my-preset");
    }
  });

  it("handles heading level jumps (e.g., h1 -> h3)", () => {
    const md = "# Top\n### Deep\nContent";
    const nodes = parseMarkdownToNodes(md, "preset-1");

    expect(nodes.length).toBe(2);
    // h3 should still be parented under h1 (nearest ancestor with lower level)
    expect(nodes[1].parent_id).toBe(nodes[0].id);
  });
});

describe("Markdown Serializer", () => {
  it("serializes nodes back to Markdown", () => {
    const now = Date.now();
    const nodes: PresetNode[] = [
      { id: "1", preset_id: "p1", parent_id: null, position: 0, title: "Title", body: "Content here", level: 1, created_at: now, updated_at: now },
      { id: "2", preset_id: "p1", parent_id: "1", position: 1, title: "Sub", body: "Sub content", level: 2, created_at: now, updated_at: now },
    ];

    const md = serializeNodesToMarkdown(nodes);
    expect(md).toContain("# Title");
    expect(md).toContain("Content here");
    expect(md).toContain("## Sub");
    expect(md).toContain("Sub content");
  });

  it("handles synthetic root node (level 0)", () => {
    const now = Date.now();
    const nodes: PresetNode[] = [
      { id: "0", preset_id: "p1", parent_id: null, position: 0, title: "", body: "Preamble", level: 0, created_at: now, updated_at: now },
      { id: "1", preset_id: "p1", parent_id: null, position: 1, title: "Heading", body: "Body", level: 1, created_at: now, updated_at: now },
    ];

    const md = serializeNodesToMarkdown(nodes);
    expect(md).toContain("Preamble");
    expect(md).toContain("# Heading");
  });

  it("returns empty string for empty nodes array", () => {
    expect(serializeNodesToMarkdown([])).toBe("");
  });
});

describe("Round-trip invariant", () => {
  it("simple document", () => {
    const md = "# Title\nContent\n## Sub\nMore content";
    const nodes = parseMarkdownToNodes(md, "test");
    const result = serializeNodesToMarkdown(nodes);
    expect(result.trim()).toBe(md.trim());
  });

  it("document with pre-heading content", () => {
    const md = "Preamble text\n# Heading\nBody";
    const nodes = parseMarkdownToNodes(md, "test");
    const result = serializeNodesToMarkdown(nodes);
    expect(result.trim()).toBe(md.trim());
  });

  it("nested document", () => {
    const md = "# A\n## B\n### C\nContent C\n## D\nContent D";
    const nodes = parseMarkdownToNodes(md, "test");
    const result = serializeNodesToMarkdown(nodes);
    expect(result.trim()).toBe(md.trim());
  });

  it("multiline body content", () => {
    const md = "# Title\nLine 1\nLine 2\nLine 3\n## Sub\nSub line";
    const nodes = parseMarkdownToNodes(md, "test");
    const result = serializeNodesToMarkdown(nodes);
    expect(result.trim()).toBe(md.trim());
  });
});

describe("Content Hash", () => {
  it("produces consistent SHA-256 hex output", () => {
    const hash = computeContentHash("hello world");
    expect(hash).toMatch(/^[0-9a-f]{64}$/);

    // Same input -> same output
    expect(computeContentHash("hello world")).toBe(hash);
  });

  it("different content produces different hashes", () => {
    const h1 = computeContentHash("content A");
    const h2 = computeContentHash("content B");
    expect(h1).not.toBe(h2);
  });
});

describe("Token Estimation", () => {
  it("estimates tokens as ceil(length / 3.5)", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("hello")).toBe(Math.ceil(5 / 3.5));
    expect(estimateTokens("a".repeat(100))).toBe(Math.ceil(100 / 3.5));
  });

  it("MODEL_CONTEXT_WINDOWS has expected entries", () => {
    expect(MODEL_CONTEXT_WINDOWS.opus).toBe(1_000_000);
    expect(MODEL_CONTEXT_WINDOWS.sonnet).toBe(250_000);
    expect(MODEL_CONTEXT_WINDOWS.haiku).toBe(200_000);
  });
});

describe("Union Engine", () => {
  beforeEach(() => {
    db = createTempDb();
  });

  afterEach(() => {
    try { db.close(); } catch { /* ignore */ }
    cleanupTemp();
  });

  it("returns empty for no presets", () => {
    const result = computePresetUnion([], db);
    expect(result.text).toBe("");
    expect(result.tokenEstimate).toBe(0);
  });

  it("serializes single preset nodes", () => {
    insertPreset({ id: "p1", name: "Test" });
    const now = Date.now();
    insertNodes([
      { id: "n1", preset_id: "p1", parent_id: null, position: 0, title: "A", body: "Content A", level: 1, created_at: now, updated_at: now },
    ]);

    const result = computePresetUnion(["p1"], db);
    expect(result.text).toContain("# A");
    expect(result.text).toContain("Content A");
    expect(result.tokenEstimate).toBeGreaterThan(0);
  });

  it("concatenates multiple presets", () => {
    insertPreset({ id: "p1", name: "First" });
    insertPreset({ id: "p2", name: "Second" });
    const now = Date.now();
    insertNodes([
      { id: "n1", preset_id: "p1", parent_id: null, position: 0, title: "A", body: "Alpha", level: 1, created_at: now, updated_at: now },
    ]);
    insertNodes([
      { id: "n2", preset_id: "p2", parent_id: null, position: 0, title: "B", body: "Beta", level: 1, created_at: now, updated_at: now },
    ]);

    const result = computePresetUnion(["p1", "p2"], db);
    expect(result.text).toContain("Alpha");
    expect(result.text).toContain("Beta");
  });

  it("deduplicates identical preset content", () => {
    insertPreset({ id: "p1", name: "First" });
    insertPreset({ id: "p2", name: "Duplicate" });
    const now = Date.now();
    // Both presets have identical content
    insertNodes([
      { id: "n1", preset_id: "p1", parent_id: null, position: 0, title: "Same", body: "Content", level: 1, created_at: now, updated_at: now },
    ]);
    insertNodes([
      { id: "n2", preset_id: "p2", parent_id: null, position: 0, title: "Same", body: "Content", level: 1, created_at: now, updated_at: now },
    ]);

    const result = computePresetUnion(["p1", "p2"], db);
    // Should only appear once
    const count = (result.text.match(/# Same/g) ?? []).length;
    expect(count).toBe(1);
  });
});

describe("Routing Algorithm", () => {
  it("returns low confidence when no presets available", () => {
    const result = routePresetDiff("some fix", [], {});
    expect(result.confidence).toBe("low");
    expect(result.recommendedPresetId).toBe("");
  });

  it("skips claude_md_global presets", () => {
    const presets: Preset[] = [
      {
        id: "global",
        name: "Global",
        description: "Global conventions",
        source: "claude_md_global",
        source_path: null,
        content_hash: "",
        version: 1,
        created_at: Date.now(),
        updated_at: Date.now(),
      },
      {
        id: "manual",
        name: "Manual",
        description: "Manual preset",
        source: "manual",
        source_path: null,
        content_hash: "",
        version: 1,
        created_at: Date.now(),
        updated_at: Date.now(),
      },
    ];

    const result = routePresetDiff("add new convention", presets, {});
    // Should not route to the global preset
    expect(result.recommendedPresetId).not.toBe("global");
    expect(result.recommendedPresetId).toBe("manual");
  });

  it("prefers project preset matching repo context", () => {
    const presets: Preset[] = [
      {
        id: "project-a",
        name: "Project A",
        description: "Rules for project A",
        source: "claude_md_project",
        source_path: "/repos/project-a/CLAUDE.md",
        content_hash: "",
        version: 1,
        created_at: Date.now(),
        updated_at: Date.now(),
      },
      {
        id: "manual",
        name: "Manual",
        description: "General preset",
        source: "manual",
        source_path: null,
        content_hash: "",
        version: 1,
        created_at: Date.now(),
        updated_at: Date.now(),
      },
    ];

    const result = routePresetDiff("fix rules for project-a", presets, {
      repo: "project-a",
    });
    expect(result.recommendedPresetId).toBe("project-a");
  });
});
