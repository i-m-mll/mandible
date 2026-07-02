import type { JSX } from 'preact/jsx-runtime';
import { ChatSurface } from '../../chat/ChatSurface';
import type { StreamRendererProps } from './types';

export function StreamRenderer(props: StreamRendererProps): JSX.Element {
  return <ChatSurface {...props} />;
}
