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
  ensureInstructionArtifactForPreset,
  listInstructionArtifactPresets,
  listSessionInstructionArtifacts,
  presetInstructionSeriesKey,
  replaceSessionInstructionArtifacts,
  routePresetDiff,
  inferSourceFromPath,
  derivePresetName,
  MODEL_CONTEXT_WINDOWS,
  type Preset,
  type PresetNode,
} from "../src/presets.js";
import { readArtifactBytesFull } from "../src/artifact-content.js";
import { getArtifactVersion } from "../src/provider-artifacts.js";

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

describe("Instruction artifact migration", () => {
  let savedEnv: Record<string, string | undefined>;

  beforeEach(() => {
    savedEnv = {
      HOME: process.env.HOME,
      MANDIBLE_HOME: process.env.MANDIBLE_HOME,
      MANDIBLE_ARTIFACT_DIR: process.env.MANDIBLE_ARTIFACT_DIR,
    };
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-instruction-artifacts-test-"));
    process.env.HOME = path.join(tempDir, "home");
    process.env.MANDIBLE_ARTIFACT_DIR = path.join(tempDir, "artifacts");
    delete process.env.MANDIBLE_HOME;
    db = openDb(path.join(tempDir, "mandible.db"));
  });

  afterEach(() => {
    try { db.close(); } catch { /* ignore */ }
    cleanupTemp();
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  function seedLegacyPreset(): void {
    insertPreset({ id: "legacy-preset", name: "Global Instructions", description: "Migrated doc" });
    const now = Date.now();
    insertNodes([
      {
        id: "node-1",
        preset_id: "legacy-preset",
        parent_id: null,
        position: 0,
        title: "Operating Rules",
        body: "Use the issue ledger.",
        level: 1,
        created_at: now,
        updated_at: now,
      },
    ]);
  }

  it("migrates legacy preset nodes into managed instruction artifact versions", () => {
    seedLegacyPreset();

    const migrated = ensureInstructionArtifactForPreset(db, "legacy-preset");

    expect(migrated?.series_id).toMatch(/^artifact-series:/);
    const series = db.prepare("SELECT series_key FROM artifact_series WHERE id = ?")
      .get(migrated?.series_id) as { series_key: string };
    expect(series.series_key).toBe(presetInstructionSeriesKey("legacy-preset"));
    const version = getArtifactVersion(db, migrated!.version_id);
    expect(version?.version_no).toBe(1);
    const bytes = readArtifactBytesFull(db, version!.artifact_id);
    expect(bytes.ok ? bytes.bytes.toString("utf8") : "").toContain("# Operating Rules");

    const listed = listInstructionArtifactPresets(db);
    expect(listed).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: migrated?.series_id,
        name: "Global Instructions",
        legacy_preset_id: "legacy-preset",
      }),
    ]));
  });

  it("composes unions and session attachments from artifact-version refs", () => {
    seedLegacyPreset();
    const migrated = ensureInstructionArtifactForPreset(db, "legacy-preset")!;

    replaceSessionInstructionArtifacts(db, "session-1", ["legacy-preset"]);
    const attachments = listSessionInstructionArtifacts(db, "session-1");

    expect(attachments).toHaveLength(1);
    expect(attachments[0]).toMatchObject({
      artifact_series_id: migrated.series_id,
      artifact_version_id: migrated.version_id,
      legacy_preset_id: "legacy-preset",
      position: 0,
    });
    const union = computePresetUnion([attachments[0].artifact_version_id], db);
    expect(union.text).toContain("Use the issue ledger.");
    expect(union.tokenEstimate).toBeGreaterThan(0);
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

  // Bug: 61bee4e — Routing fallback behavior fixes
  it("returns empty recommendedPresetId for empty diff content", () => {
    const presets: Preset[] = [
      {
        id: "p1", name: "My Preset", description: "", source: "manual",
        source_path: null, content_hash: "", version: 1, created_at: Date.now(), updated_at: Date.now(),
      },
    ];
    const result = routePresetDiff("", presets, {});
    expect(result.recommendedPresetId).toBe("");
    expect(result.confidence).toBe("low");
  });

  it("returns empty when only global presets exist (global is skipped)", () => {
    const presets: Preset[] = [
      {
        id: "g1", name: "Global CLAUDE.md", description: "global", source: "claude_md_global",
        source_path: null, content_hash: "", version: 1, created_at: Date.now(), updated_at: Date.now(),
      },
    ];
    const result = routePresetDiff("some convention about commits", presets, {});
    expect(result.recommendedPresetId).toBe("");
    expect(result.confidence).toBe("low");
    expect(result.reason).toBe("No matching preset found");
  });
});

// ---------------------------------------------------------------------------
// Code-block-aware parsing (Bug: 61bee4e)
// ---------------------------------------------------------------------------

describe("Markdown Parser — code-block awareness", () => {
  it("does NOT parse headings inside fenced code blocks", () => {
    const md = [
      "# Real Heading",
      "",
      "Some text.",
      "",
      "```bash",
      "# This is a comment, not a heading",
      "echo hello",
      "## Also not a heading",
      "```",
      "",
      "## Another Real Heading",
      "",
      "Final text.",
    ].join("\n");

    const nodes = parseMarkdownToNodes(md, "preset-1");
    const titles = nodes.map((n) => n.title);

    expect(titles).toContain("Real Heading");
    expect(titles).toContain("Another Real Heading");
    expect(titles).not.toContain("This is a comment, not a heading");
    expect(titles).not.toContain("Also not a heading");
    // The code block content should be part of the "Real Heading" node body
    const realHeading = nodes.find((n) => n.title === "Real Heading")!;
    expect(realHeading.body).toContain("# This is a comment, not a heading");
    expect(realHeading.body).toContain("## Also not a heading");
  });

  it("handles multiple code blocks correctly", () => {
    const md = [
      "# Heading 1",
      "",
      "```",
      "# not a heading",
      "```",
      "",
      "# Heading 2",
      "",
      "```python",
      "# also not a heading",
      "```",
      "",
      "# Heading 3",
    ].join("\n");

    const nodes = parseMarkdownToNodes(md, "preset-1");
    const titles = nodes.map((n) => n.title);

    expect(titles).toEqual(["Heading 1", "Heading 2", "Heading 3"]);
  });

  it("handles indented code fences", () => {
    const md = [
      "# Heading",
      "",
      "  ```",
      "  # comment inside indented fence",
      "  ```",
      "",
      "# Next Heading",
    ].join("\n");

    const nodes = parseMarkdownToNodes(md, "preset-1");
    const titles = nodes.map((n) => n.title);

    expect(titles).toEqual(["Heading", "Next Heading"]);
  });

  it("handles unclosed code fence (everything after is body)", () => {
    const md = [
      "# Heading",
      "",
      "```",
      "# not a heading",
      "# still not a heading",
    ].join("\n");

    const nodes = parseMarkdownToNodes(md, "preset-1");
    expect(nodes.length).toBe(1);
    expect(nodes[0].title).toBe("Heading");
    expect(nodes[0].body).toContain("# not a heading");
    expect(nodes[0].body).toContain("# still not a heading");
  });
});

// ---------------------------------------------------------------------------
// Round-trip with code blocks (Bug: 61bee4e)
// ---------------------------------------------------------------------------

describe("Round-trip with code blocks", () => {
  it("preserves code blocks through parse-serialize round-trip", () => {
    const md = [
      "# Config",
      "",
      "Instructions.",
      "",
      "```bash",
      "# shell comment",
      "npm run build",
      "```",
      "",
      "## Details",
      "",
      "More details.",
    ].join("\n");

    const nodes = parseMarkdownToNodes(md, "preset-1");
    const output = serializeNodesToMarkdown(nodes);

    expect(output).toContain("```bash");
    expect(output).toContain("# shell comment");
    expect(output).toContain("npm run build");
    expect(output).toContain("```");
    expect(output).toContain("# Config");
    expect(output).toContain("## Details");
  });
});

// ---------------------------------------------------------------------------
// inferSourceFromPath (Bug: 61bee4e)
// ---------------------------------------------------------------------------

describe("inferSourceFromPath", () => {
  const origHome = process.env.HOME;
  afterEach(() => { process.env.HOME = origHome; });

  it("classifies ~/.claude/CLAUDE.md as global", () => {
    process.env.HOME = "/Users/testuser";
    expect(inferSourceFromPath("/Users/testuser/.claude/CLAUDE.md")).toBe("claude_md_global");
  });

  it("classifies ~/.dotfiles/.../CLAUDE.md as global", () => {
    process.env.HOME = "/Users/testuser";
    expect(inferSourceFromPath("/Users/testuser/.dotfiles/.config/claude/CLAUDE.md")).toBe("claude_md_global");
  });

  it("classifies project .claude/CLAUDE.md as project, NOT global", () => {
    process.env.HOME = "/Users/testuser";
    expect(inferSourceFromPath("/Users/testuser/projects/myrepo/.claude/CLAUDE.md")).toBe("claude_md_project");
  });

  it("classifies repo root CLAUDE.md as project", () => {
    process.env.HOME = "/Users/testuser";
    expect(inferSourceFromPath("/Users/testuser/projects/myrepo/CLAUDE.md")).toBe("claude_md_project");
  });

  it("classifies non-CLAUDE.md files as manual", () => {
    process.env.HOME = "/Users/testuser";
    expect(inferSourceFromPath("/Users/testuser/my-preset.md")).toBe("manual");
  });
});

// ---------------------------------------------------------------------------
// derivePresetName (Bug: 61bee4e)
// ---------------------------------------------------------------------------

describe("derivePresetName", () => {
  it("returns 'Global CLAUDE.md' for global source", () => {
    expect(derivePresetName("/Users/me/.claude/CLAUDE.md", "claude_md_global")).toBe("Global CLAUDE.md");
  });

  it("derives repo name from .claude path for project source", () => {
    expect(derivePresetName("/Users/me/projects/mandible/.claude/CLAUDE.md", "claude_md_project")).toBe("mandible CLAUDE.md");
  });

  it("derives repo name from root CLAUDE.md for project source", () => {
    expect(derivePresetName("/Users/me/projects/mandible/CLAUDE.md", "claude_md_project")).toBe("mandible CLAUDE.md");
  });

  it("returns 'Local CLAUDE.md' for local source", () => {
    expect(derivePresetName("/some/path/nested/CLAUDE.md", "claude_md_local")).toBe("Local CLAUDE.md");
  });

  it("returns filename for manual source", () => {
    expect(derivePresetName("/some/path/my-preset.md", "manual")).toBe("my-preset.md");
  });
});
