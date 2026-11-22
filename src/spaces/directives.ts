import { BLOCK_TYPES, type BlockType } from "./serialize.js";

export const SPACE_DIRECTIVE_NAMES = {
  heading: 'space-heading',
  paragraph: 'space-paragraph',
  reference: 'reference',
  artifact_embed: 'artifact',
  issue_embed: 'issue',
  comment_embed: 'comment',
  todo: 'todo',
} satisfies Record<BlockType, string>;

export const SPACE_DIRECTIVE_TYPES = new Map<string, BlockType>(BLOCK_TYPES.map(type => [SPACE_DIRECTIVE_NAMES[type], type]));
export const SPACE_FRAME_NAMES = new Set(SPACE_DIRECTIVE_TYPES.keys());
