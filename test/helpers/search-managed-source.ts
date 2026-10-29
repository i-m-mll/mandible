import type { Db } from "../../src/db.js";
import { serializeManagedNormalizedRecords, writeManagedNormalizedSource, MANAGED_NORMALIZED_SOURCE_EPOCHS, type ManagedNormalizedBlockRecord } from "../../src/conversations/managed-normalized-source.js";
import { ConversationSourceStore } from "../../src/conversations/source-store.js";
export async function managedSearchSource(db: Db, rootPath: string, id: string, content: string, blockId = `block-${id}`): Promise<string> {
  const records: ManagedNormalizedBlockRecord[] = [{ format: "mandible-normalized-block/1", id: blockId, conversation_id: id, type: "assistant_message", role: "assistant", content, position: 0, timestamp: null, parent_id: null, metadata_json: "{}", dag_uuid: null, dag_parent_uuid: null }];
  const serialized = serializeManagedNormalizedRecords(records);
  const written = writeManagedNormalizedSource({ rootPath, conversationId: id, bytes: serialized.bytes, contentHash: serialized.contentHash });
  await new ConversationSourceStore(db).recordManagedNormalizedSource({
    ...written, conversationId: id, provider: "codex", nativeSessionId: id, expectedContentHash: serialized.contentHash, ...MANAGED_NORMALIZED_SOURCE_EPOCHS,
    blocks: records.map((record, index) => ({ id: record.id, type: record.type, role: record.role, position: record.position, timestamp: null, parentId: null, dagUuid: null, dagParentUuid: null, recordOffset: serialized.ranges[index].offset, recordLength: serialized.ranges[index].length, recordHash: serialized.ranges[index].hash, recordOrdinal: index })),
  });
  return written.filePath;
}
