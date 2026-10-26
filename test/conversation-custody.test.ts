import { zstdCompressSync } from "node:zlib";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConversationCustodyStore, CustodyError } from "../src/conversations/custody-store.js";

function write(filePath: string, value: string | Buffer): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, value);
}

function jsonl(...records: unknown[]): string {
  return `${records.map((record) => JSON.stringify(record)).join("\n")}\n`;
}

describe("conversation custody", () => {
  let tempRoot: string;
  let custodyRoot: string;

  beforeEach(() => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-conversation-custody-"));
    custodyRoot = path.join(tempRoot, "custody");
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  function claudeFixture(sessionId = "session-a") {
    const project = path.join(tempRoot, "home", ".claude", "projects", "project-a");
    const source = path.join(project, `${sessionId}.jsonl`);
    write(source, jsonl({ type: "user", sessionId, message: { content: "hello" } }));
    write(path.join(project, sessionId, "subagents", "agent-one.jsonl"), jsonl({ type: "assistant", message: { content: "child" } }));
    write(path.join(project, sessionId, "tool-results", "tool-1.txt"), Buffer.from([0, 1, 2, 255]));
    write(path.join(project, "sessions-index.json"), JSON.stringify({ version: 1, entries: [{ sessionId, summary: "kept" }, { sessionId: "other", summary: "excluded" }] }));
    return { source, sessionId, project };
  }

  it("captures exact bytes, provider dependencies, restrictive modes, and converges on repeat", async () => {
    const fixture = claudeFixture();
    const store = new ConversationCustodyStore(custodyRoot);
    const first = await store.capture({ conversation_id: "conv-a", provider: "claude_code", session_id: fixture.sessionId, source_path: fixture.source });
    const second = await store.capture({ conversation_id: "conv-a", provider: "claude_code", session_id: fixture.sessionId, source_path: fixture.source });

    expect(first.reused).toBe(false);
    expect(second.reused).toBe(true);
    expect(second.manifest.custody_version).toBe(first.manifest.custody_version);
    expect(second.status.history.map((event) => event.state)).toEqual([
      "requested", "capturing", "verified", "sealed",
      "requested", "capturing", "verified", "sealed",
    ]);
    expect(first.manifest.files.map((file) => file.dependency_role)).toEqual(expect.arrayContaining([
      "main_transcript", "subagent_transcript", "spilled_tool_result", "session_index_metadata",
    ]));
    const capturedTool = first.manifest.files.find((file) => file.dependency_role === "spilled_tool_result")!;
    expect(fs.readFileSync(path.join(first.version_path, capturedTool.path))).toEqual(Buffer.from([0, 1, 2, 255]));
    expect(fs.statSync(first.version_path).mode & 0o077).toBe(0);
    expect(fs.statSync(path.join(first.version_path, capturedTool.path)).mode & 0o077).toBe(0);
  });

  it("assigns the same custody version under different host collations", async () => {
    const fixture = claudeFixture("locale-session");
    write(path.join(fixture.project, fixture.sessionId, "tool-results", "z.txt"), "z");
    write(path.join(fixture.project, fixture.sessionId, "tool-results", "ä.txt"), "umlaut");
    const store = new ConversationCustodyStore(custodyRoot);
    const localeCompare = vi.spyOn(String.prototype, "localeCompare");

    const en = new Intl.Collator("en-US");
    localeCompare.mockImplementation(function (this: string, other: string) {
      return en.compare(String(this), other);
    });
    const first = await store.capture({
      conversation_id: "conv-locale",
      provider: "claude_code",
      session_id: fixture.sessionId,
      source_path: fixture.source,
    });

    const sv = new Intl.Collator("sv-SE");
    localeCompare.mockImplementation(function (this: string, other: string) {
      return sv.compare(String(this), other);
    });
    const second = await store.capture({
      conversation_id: "conv-locale",
      provider: "claude_code",
      session_id: fixture.sessionId,
      source_path: fixture.source,
    });

    expect(first.manifest.files.map((file) => file.path)).toEqual(
      [...first.manifest.files.map((file) => file.path)].sort(),
    );
    expect(second.manifest.custody_version).toBe(first.manifest.custody_version);
    expect(second.reused).toBe(true);
  });

  it("fails closed when a live source mutates during its stable read", async () => {
    const fixture = claudeFixture();
    let changed = false;
    const store = new ConversationCustodyStore(custodyRoot, {
      afterSourceRead(sourcePath) {
        if (!changed && sourcePath === fixture.source) {
        changed = true;
        fs.appendFileSync(fixture.source, "mutated\n");
        }
      }
    });
    await expect(store.capture({ conversation_id: "conv-live", provider: "claude_code", session_id: fixture.sessionId, source_path: fixture.source })).rejects.toThrowError(/changed during capture/);
    expect(store.status("conv-live")?.state).toBe("error");
  });

  it("detects bit rot and refuses provider collisions", async () => {
    const fixture = claudeFixture();
    const store = new ConversationCustodyStore(custodyRoot);
    const captured = await store.capture({ conversation_id: "conv-b", provider: "claude_code", session_id: fixture.sessionId, source_path: fixture.source });
    const main = captured.manifest.files.find((file) => file.dependency_role === "main_transcript")!;
    const target = path.join(captured.version_path, main.path);
    const bytes = fs.readFileSync(target);
    bytes[0] ^= 1;
    fs.writeFileSync(target, bytes);
    expect(store.verifyVersion("conv-b")).toMatchObject({ ok: false });

    const clean = await store.capture({ conversation_id: "conv-c", provider: "claude_code", session_id: fixture.sessionId, source_path: fixture.source });
    const providerRoot = path.join(tempRoot, "provider-target");
    write(path.join(providerRoot, clean.manifest.files.find((file) => file.dependency_role === "main_transcript")!.provider_relative_path), "occupied");
    expect(() => store.stageProviderRestore("conv-c", path.join(tempRoot, "stage"), providerRoot))
      .toThrowError(/refusing to overwrite/);
  });

  it("rejects traversal and symlink sources", async () => {
    const fixture = claudeFixture();
    const store = new ConversationCustodyStore(custodyRoot);
    await expect(store.capture({ conversation_id: "../escape", provider: "claude_code", session_id: fixture.sessionId, source_path: fixture.source })).rejects.toThrowError(CustodyError);
    const link = path.join(fixture.project, "linked.jsonl");
    fs.symlinkSync(fixture.source, link);
    await expect(store.capture({ conversation_id: "conv-link", provider: "claude_code", session_id: "linked", source_path: link })).rejects.toThrowError(/symlink source rejected/);

    const outside = path.join(tempRoot, "outside");
    write(path.join(outside, "escaped.jsonl"), "escaped\n");
    const linkedDirectory = path.join(fixture.project, "linked-directory");
    fs.symlinkSync(outside, linkedDirectory);
    await expect(store.capture({ conversation_id: "conv-parent-link", provider: "claude_code", session_id: "escaped", source_path: path.join(linkedDirectory, "escaped.jsonl") })).rejects.toThrowError(/escaped through a symlink/);
  });

  it("round-trips a fresh Mandible custody store through an archive", async () => {
    const fixture = claudeFixture();
    const store = new ConversationCustodyStore(custodyRoot);
    const sourceSha256 = crypto.createHash("sha256").update(fs.readFileSync(fixture.source)).digest("hex");
    const captured = await store.capture({
      conversation_id: "conv-roundtrip",
      provider: "claude_code",
      session_id: fixture.sessionId,
      source_path: fixture.source,
      expected_source_version_id: "source-version-1",
      expected_source_sha256: sourceSha256,
    });
    const archive = store.exportArchive("conv-roundtrip", path.join(tempRoot, "archive"), { tags: ["preserved"] });
    expect(store.verifyArchive(archive).ok).toBe(true);

    const restored = new ConversationCustodyStore(path.join(tempRoot, "fresh-custody")).importArchive(archive);
    expect(restored.manifest.custody_version).toBe(captured.manifest.custody_version);
    expect(restored.status.state).toBe("sealed");
    expect(new ConversationCustodyStore(path.join(tempRoot, "fresh-custody")).verifyVersion("conv-roundtrip").ok).toBe(true);
  });

  it("captures Codex history-base chains and only thread-scoped title metadata", async () => {
    const codexRoot = path.join(tempRoot, "home", ".codex");
    const baseId = "019base";
    const sessionId = "019selected";
    const base = path.join(codexRoot, "archived_sessions", `rollout-2026-01-01T00-00-00-${baseId}.jsonl`);
    const nearCollision = path.join(codexRoot, "archived_sessions", `rollout-2026-01-01T00-00-00-${baseId}-near.jsonl`);
    const source = path.join(codexRoot, "sessions", "2026", "01", "02", `rollout-2026-01-02T00-00-00-${sessionId}.jsonl`);
    write(base, jsonl({ type: "session_meta", payload: { id: baseId } }));
    write(nearCollision, jsonl({ type: "session_meta", payload: { id: `${baseId}-near` } }, { type: "event_msg", payload: { message: "wrong near-collision rollout" } }));
    write(source, jsonl({ type: "session_meta", payload: { id: sessionId, history_base: baseId } }));
    write(path.join(codexRoot, "session_index.jsonl"), jsonl({ id: sessionId, thread_name: "selected" }, { id: "other", thread_name: "secret other title" }));

    for (const file of [base, source]) {
      write(`${file}.zst`, zstdCompressSync(fs.readFileSync(file)));
      fs.unlinkSync(file);
    }
    const captured = await new ConversationCustodyStore(custodyRoot).capture({ conversation_id: "conv-codex", provider: "codex", session_id: sessionId, source_path: source });
    expect(captured.manifest.files.filter((file) => file.dependency_role.endsWith("rollout"))).toHaveLength(2);
    expect(captured.manifest.native_identities).toEqual(expect.arrayContaining([sessionId, baseId]));
    const title = captured.manifest.files.find((file) => file.dependency_role === "thread_title_metadata")!;
    const titleBytes = fs.readFileSync(path.join(captured.version_path, title.path), "utf8");
    expect(titleBytes).toContain("selected");
    expect(titleBytes).not.toContain("secret other title");
    const capturedBase = captured.manifest.files.find((file) => file.dependency_role === "history_base_rollout")!;
    expect(fs.readFileSync(path.join(captured.version_path, capturedBase.path), "utf8")).not.toContain("wrong near-collision rollout");
    const selectedFile = captured.manifest.files.find((file) => file.dependency_role === "selected_rollout")!;
    const providerTarget = path.join(tempRoot, "arbitrary-provider-target");
    const occupied = path.join(providerTarget, `${selectedFile.provider_relative_path}.zst`);
    const occupiedBytes = fs.readFileSync(`${source}.zst`);
    write(occupied, occupiedBytes);
    expect(() => new ConversationCustodyStore(custodyRoot).stageProviderRestore("conv-codex", path.join(tempRoot, "restore-stage"), providerTarget))
      .toThrowError(/provider collision/);
    expect(fs.readFileSync(occupied)).toEqual(occupiedBytes);
    expect(captured.manifest.restore.capability).toBe("partial");
  });

  it("captures Gemini session-addressable sidecars and filters project mapping", async () => {
    const geminiRoot = path.join(tempRoot, "home", ".gemini");
    const sessionId = "session-g";
    const projectRoot = path.join(geminiRoot, "tmp", "project-hash");
    const source = path.join(projectRoot, "chats", `${sessionId}.json`);
    write(source, JSON.stringify({ sessionId, messages: [] }));
    write(path.join(projectRoot, "tool-outputs", sessionId, "result.txt"), "tool output");
    write(path.join(projectRoot, "plans", `${sessionId}.json`), JSON.stringify({ sessionId, plan: [] }));
    write(path.join(projectRoot, "plans", `${sessionId}-near.json`), JSON.stringify({ sessionId: `${sessionId}-near`, plan: ["private near collision"] }));
    write(path.join(projectRoot, "chats", "other-session.json"), "private other chat");
    write(path.join(geminiRoot, "projects.json"), JSON.stringify({ projects: { "project-hash": "/work/project", other: "/private/other" } }));

    const captured = await new ConversationCustodyStore(custodyRoot).capture({ conversation_id: "conv-gemini", provider: "gemini", session_id: sessionId, source_path: source });
    expect(captured.manifest.files.map((file) => file.dependency_role)).toEqual(expect.arrayContaining(["chat", "tool_output", "plan", "project_root_mapping"]));
    expect(captured.manifest.files.some((file) => file.provider_relative_path.includes("other-session"))).toBe(false);
    expect(captured.manifest.files.some((file) => file.provider_relative_path.includes(`${sessionId}-near`))).toBe(false);
    const mapping = captured.manifest.files.find((file) => file.dependency_role === "project_root_mapping")!;
    expect(fs.readFileSync(path.join(captured.version_path, mapping.path), "utf8")).not.toContain("/private/other");
  });
});
