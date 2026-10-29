import { LIVE_REFRESH_DEADLINE_MS, RefreshDeadlineError } from '../lib/coalesced-refresh';

export async function readWithDeadline<T>(load: (signal: AbortSignal) => Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  const controller = new AbortController();
  const abandon = () => controller.abort(signal.reason);
  signal.addEventListener('abort', abandon, { once: true });
  const failed = new Promise<never>((_resolve, reject) => {
    controller.signal.addEventListener('abort', () => reject(controller.signal.reason), { once: true });
  });
  const deadline = setTimeout(() => controller.abort(new RefreshDeadlineError(LIVE_REFRESH_DEADLINE_MS)), LIVE_REFRESH_DEADLINE_MS);
  try {
    return await Promise.race([load(controller.signal), failed]);
  } finally {
    clearTimeout(deadline);
    signal.removeEventListener('abort', abandon);
  }
}

