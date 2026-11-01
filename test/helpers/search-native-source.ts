import fs from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import type { Db } from "../../src/db.js";
import { CodexParser } from "../../src/parsers/codex.js";
import { ConversationSourceStore } from "../../src/conversations/source-store.js";
import { CURRENT_CONVERSATION_SOURCE_EPOCHS } from "../../src/conversations/source-types.js";

export async function nativeSearchSource(db: Db, rootPath: string, id: string, content: string | Array<{ role: "user" | "assistant"; text: string }>): Promise<string> {
  const filePath = path.join(rootPath, ".codex", "sessions", `${id}.jsonl`);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, [
    { type: "session_meta", payload: { id } },
    ...(typeof content === "string" ? [{ role: "assistant", text: content }] : content).map(message => ({ type: "response_item", payload: { type: "message", role: message.role, content: [{ type: message.role === "user" ? "input_text" : "output_text", text: message.text }] } })),
  ].map(record => JSON.stringify(record)).join("\n") + "\n");
  const parsed = (await new CodexParser().parse(filePath))!;
  db.prepare("UPDATE conversations SET block_count = ?, source_path = ? WHERE id = ?").run(parsed.blocks.length, filePath, id);
  await new ConversationSourceStore(db).recordConversation({ conversationId: id, provider: "codex", nativeSessionId: id, filePath,
    blocks: parsed.blocks, ...CURRENT_CONVERSATION_SOURCE_EPOCHS });
  const bytes = fs.readFileSync(filePath);
  db.prepare(`INSERT OR REPLACE INTO conversation_ingest_state
    (file_path, byte_offset, line_count, tail_hash, partial_line, updated_at)
    VALUES (?, ?, ?, ?, '', ?)`).run(filePath, bytes.length, bytes.toString().trimEnd().split("\n").length,
      createHash("sha256").update(bytes.subarray(Math.max(0, bytes.length - 4096))).digest("hex"), Date.now());
  return filePath;
}
