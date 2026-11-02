import type { SourceBackedConversationBlock } from './source-types.js';
import type { ActivityItem } from '../parsers/types.js';
import { displayChatItem, isEmptyCompletionMetadata } from '../presentation/model.js';
import { presentReasoning } from '../presentation/activity-presentation.js';

export function projectDisplayBlock(row: SourceBackedConversationBlock): SourceBackedConversationBlock & { details_loaded?: false } {
  let metadata: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(row.metadata_json);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      metadata = { ...(parsed as Record<string, unknown>) };
    }
  } catch {
    throw new Error(`block ${row.id} has invalid metadata and cannot be safely projected`);
  }
  const item = metadata.chat_item;
  const activity = item && typeof item === "object" && !Array.isArray(item)
    && (item as Record<string, unknown>).type === "activity";
  const targeted = row.type === "tool_use" || row.type === "tool_result" || row.type === "thinking" || activity;
  if (!targeted) return row;
  const reasoningSummary = row.type === "thinking" && metadata.source_event_type === "reasoning_summary";
  const reasoningLines = reasoningSummary
    ? row.content.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
    : [];
  if (reasoningSummary) metadata.display_has_body = presentReasoning([row.content]).hasBody;
  if (activity && (item as ActivityItem).provenance.source_event_type === 'task_complete') {
    metadata.display_has_body = !isEmptyCompletionMetadata(displayChatItem(item as ActivityItem, metadata) as ActivityItem, false, metadata.token_usage ?? metadata.usage_telemetry);
  }
  delete metadata.display_completion_parts;
  delete metadata.tool_input;
  delete metadata.tool_output;
  if (item && typeof item === "object" && !Array.isArray(item)) {
    const compactItem = { ...(item as Record<string, unknown>) };
    delete compactItem.input;
    delete compactItem.output;
    if (reasoningSummary) {
      compactItem.parts = reasoningLines.length > 0 ? [{ type: "text", text: reasoningLines[0] }] : [];
    } else if (row.type === "thinking") {
      compactItem.parts = [];
    } else if (row.type === "tool_use" || row.type === "tool_result" || activity) {
      compactItem.parts = [];
    }
    metadata.chat_item = compactItem;
  }

  const content = reasoningSummary
    ? (reasoningLines[0] ?? "")
    : row.type === "tool_use"
      ? (typeof metadata.tool_name === "string" ? metadata.tool_name : "Tool call")
      : row.type === "tool_result"
        ? ""
        : row.type === "thinking" ? "Thought" : "";
  return {
    id: row.id,
    conversation_id: row.conversation_id,
    type: row.type,
    role: row.role,
    content,
    position: row.position,
    timestamp: row.timestamp,
    parent_id: row.parent_id,
    metadata_json: JSON.stringify(metadata),
    dag_uuid: row.dag_uuid,
    dag_parent_uuid: row.dag_parent_uuid,
    locator: row.locator,
    details_loaded: false,
  };
}
