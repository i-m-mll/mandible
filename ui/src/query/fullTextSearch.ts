import {
  FULL_TEXT_SEARCH_RETRY_MS,
  type FullTextSearchPending,
  type FullTextSearchResponse,
  type FullTextSearchTerminal,
} from "../../../src/conversations/full-text-search-contract";

export type SearchObserver = Pick<FullTextSearchPending, 'search_id' | 'observer_token'>;
export type SearchSnapshot = Pick<Extract<FullTextSearchResponse<object>, { state: 'complete' }>, 'search_id' | 'snapshot_id'>;
export type SearchReadOptions = {
  signal?: AbortSignal;
  onPending?: (pending: FullTextSearchPending) => void;
  snapshot?: SearchSnapshot;
};

export class FullTextSearchError extends Error {
  constructor(readonly result: FullTextSearchTerminal) {
    super(result.state === "incomplete"
      ? "Some chats could not be searched. Retry to search them again."
      : "These search results need to be refreshed. Refresh to search the current chats.");
    this.name = "FullTextSearchError";
  }
}

export function isFullTextSearchTerminal(value: object): value is FullTextSearchTerminal {
  return 'state' in value && (value.state === 'incomplete' || value.state === 'superseded' || value.state === 'expired');
}

function wait(ms: number, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      reject(signal?.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", abort, { once: true });
  });
}

/** Keep the transport union out of result caches: only completed data may be published. */
export async function readFullTextSearch<Result extends object>(
  request: (observer?: SearchObserver) => Promise<Result | FullTextSearchResponse<Result>>,
  release: (observer: SearchObserver) => Promise<void>,
  options: SearchReadOptions = {},
): Promise<Result | FullTextSearchTerminal> {
  let observer: SearchObserver | undefined;
  let previousProgress = "";
  let unchanged = 0;
  try {
    for (;;) {
      options.signal?.throwIfAborted();
      const result = await request(observer);
      if (!("state" in result)) {
        options.signal?.throwIfAborted();
        return result;
      }
      const search = result as FullTextSearchResponse<Result>;
      if (search.state === 'pending') observer = { search_id: search.search_id, observer_token: search.observer_token };
      options.signal?.throwIfAborted();
      if (search.state !== 'pending') return search;
      options.onPending?.(search);
      const progress = JSON.stringify([search.phase, search.progress]);
      unchanged = progress === previousProgress ? unchanged + 1 : 0;
      previousProgress = progress;
      const paced = Math.max(FULL_TEXT_SEARCH_RETRY_MS, search.retry_after_ms);
      await wait(Math.max(paced, Math.min(5_000, FULL_TEXT_SEARCH_RETRY_MS * 2 ** unchanged)), options.signal);
    }
  } finally {
    if (observer) await release(observer);
  }
}
