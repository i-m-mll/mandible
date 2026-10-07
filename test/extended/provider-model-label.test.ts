import { expect, it } from 'vitest';
import { providerModelLabel } from '../../src/provider-run-option-catalog';
import { conversationRunOptions } from '../../src/conversation-control/runtime-options';

it('labels exact catalog and historical models without altering wire IDs or unknown distinctions', () => {
  expect(providerModelLabel('claude_code', 'claude-opus-5')).toBe('Opus 5');
  expect(providerModelLabel('claude_code', 'claude-opus-5-5')).toBe('Opus 5.5');
  expect(providerModelLabel('claude_code', 'claude-opus-5-private', 'Private Opus')).toBe('Private Opus');
  expect(providerModelLabel('codex', 'claude-opus-5')).toBe('claude-opus-5');
  const model = conversationRunOptions('claude_code', [{ value: 'claude-opus-5', label: 'claude-opus-5' }])[0];
  expect(model.choices).toEqual([{ value: 'claude-opus-5', label: 'Opus 5' }]);
});
