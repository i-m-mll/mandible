import fs from "node:fs";
import path from "node:path";
import type { Db } from "../../src/db.js";
import { CodexParser } from "../../src/parsers/codex.js";
import { ConversationSourceStore } from "../../src/conversations/source-store.js";
import { CURRENT_CONVERSATION_SOURCE_EPOCHS } from "../../src/conversations/source-types.js";

export async function nativeSearchSource(db: Db, rootPath: string, id: string, content: string): Promise<string> {
  const filePath = path.join(rootPath, ".codex", "sessions", `${id}.jsonl`);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, [
    { type: "session_meta", payload: { id } },
    { type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: content }] } },
  ].map(record => JSON.stringify(record)).join("\n") + "\n");
  const parsed = (await new CodexParser().parse(filePath))!;
  db.prepare("UPDATE conversations SET block_count = ?, source_path = ? WHERE id = ?").run(parsed.blocks.length, filePath, id);
  await new ConversationSourceStore(db).recordConversation({ conversationId: id, provider: "codex", nativeSessionId: id, filePath,
    blocks: parsed.blocks, ...CURRENT_CONVERSATION_SOURCE_EPOCHS });
  return filePath;
}
