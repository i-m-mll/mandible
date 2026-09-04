import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import {
  DEFAULT_CHAT_BOTTOM_SHELF_PREFERENCE,
  parseChatBottomShelfPreference,
  type ChatBottomShelfPreference,
} from '../../../src/contracts';
import {
  getUserChatBottomShelfSetting,
  updateUserChatBottomShelfSetting,
} from '../api';

export type ChatBottomShelfPreferenceState = {
  ready: boolean;
  error: string | null;
};

export function useChatBottomShelfPreference(): [
  ChatBottomShelfPreference,
  (next: ChatBottomShelfPreference | ((current: ChatBottomShelfPreference) => ChatBottomShelfPreference)) => void,
  ChatBottomShelfPreferenceState,
] {
  const [preference, setPreference] = useState<ChatBottomShelfPreference>({
    ...DEFAULT_CHAT_BOTTOM_SHELF_PREFERENCE,
  });
  const [state, setState] = useState<ChatBottomShelfPreferenceState>({ ready: false, error: null });
  const desiredRef = useRef(preference);
  const writeQueueRef = useRef(Promise.resolve());
  const activeRef = useRef(true);

  useEffect(() => {
    activeRef.current = true;
    void getUserChatBottomShelfSetting()
      .then((snapshot) => {
        if (!activeRef.current) return;
        const loaded = snapshot.value ?? { ...DEFAULT_CHAT_BOTTOM_SHELF_PREFERENCE };
        desiredRef.current = loaded;
        setPreference(loaded);
        setState({ ready: true, error: null });
      })
      .catch(() => {
        if (!activeRef.current) return;
        setState({
          ready: false,
          error: 'Saved Chat shelf preferences are unavailable. No preference was changed.',
        });
      });
    return () => { activeRef.current = false; };
  }, []);

  const update = useCallback((next: ChatBottomShelfPreference | ((current: ChatBottomShelfPreference) => ChatBottomShelfPreference)) => {
    if (!state.ready) return;
    const candidate = typeof next === 'function' ? next(desiredRef.current) : next;
    const normalized = parseChatBottomShelfPreference(candidate);
    if (!normalized) return;
    desiredRef.current = normalized;
    setPreference(normalized);
    writeQueueRef.current = writeQueueRef.current
      .then(() => updateUserChatBottomShelfSetting(normalized))
      .then((snapshot) => {
        if (!activeRef.current || !snapshot.value) return;
        if (JSON.stringify(desiredRef.current) === JSON.stringify(normalized)) {
          desiredRef.current = snapshot.value;
          setPreference(snapshot.value);
        }
        setState({ ready: true, error: null });
      })
      .catch(() => {
        if (activeRef.current) setState((current) => ({ ...current, error: 'Could not save Chat shelf preferences.' }));
      });
  }, [state.ready]);

  return [preference, update, state];
}
