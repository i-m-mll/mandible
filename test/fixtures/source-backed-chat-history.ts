export const SOURCE_BACKED_HISTORY_BLOCK_COUNT = 751;
export const SOURCE_BACKED_HISTORY_SESSION_ID = 'source-backed-history-session';

type JsonRecord = Record<string, unknown>;

function timestamp(ordinal: number): string {
  return new Date(Date.UTC(2026, 8, 14, 1, 0, ordinal)).toISOString();
}

export function sourceBackedHistoryRecords(): JsonRecord[] {
  const rows: JsonRecord[] = [{
    type: 'session_meta',
    timestamp: timestamp(0),
    payload: {
      id: SOURCE_BACKED_HISTORY_SESSION_ID,
      cwd: '/tmp/source-backed-history',
      model_provider: 'openai',
    },
  }];

  // A Codex function call normalizes to two readable blocks (tool use plus its
  // activity record), so 750 provider rows deliberately produce 751 blocks.
  for (let position = 0; position < SOURCE_BACKED_HISTORY_BLOCK_COUNT - 1; position += 1) {
    if (position === 120) {
      rows.push({
        type: 'turn_context',
        timestamp: timestamp(position),
        payload: { turn_id: 'hidden-provider-bookkeeping', cwd: '/tmp/source-backed-history' },
      });
    }
    if (position === 360) {
      rows.push({
        type: 'event_msg',
        timestamp: timestamp(position),
        payload: { type: 'token_count', info: { total_token_usage: { total_tokens: 1234 } } },
      });
    }
    if (position === 420) {
      rows.push({
        type: 'response_item',
        timestamp: timestamp(position),
        payload: {
          type: 'function_call',
          call_id: 'source-backed-tool-call',
          name: 'read_history_fixture',
          arguments: JSON.stringify({ position }),
        },
      });
      continue;
    }
    if (position === 421) {
      rows.push({
        type: 'response_item',
        timestamp: timestamp(position),
        payload: {
          type: 'function_call_output',
          call_id: 'source-backed-tool-call',
          output: 'source-backed tool result',
        },
      });
      continue;
    }

    const role = position === 590 || position === 591
      ? 'assistant'
      : position % 2 === 0 ? 'user' : 'assistant';
    rows.push({
      type: 'response_item',
      timestamp: timestamp(position),
      payload: {
        type: 'message',
        role,
        content: [{
          type: role === 'user' ? 'input_text' : 'output_text',
          text: position === 0
            ? 'FIRST SOURCE BACKED PROMPT'
            : position === SOURCE_BACKED_HISTORY_BLOCK_COUNT - 2
              ? 'LATEST SOURCE BACKED RESPONSE'
              : `readable source block ${String(position).padStart(3, '0')}`,
        }],
      },
    });
  }
  return rows;
}

export function sourceBackedHistoryJsonl(): string {
  return `${sourceBackedHistoryRecords().map((row) => JSON.stringify(row)).join('\n')}\n`;
}
