import type { Router } from "../../src/server.js";
import type { FullTextSearchPending } from "../../src/conversations/full-text-search-contract.js";
import { waitUntil } from "./wait-until.js";

export type SearchObserver = Pick<FullTextSearchPending, "search_id" | "observer_token">;

export async function settleConversationSearch(
  router: Router,
  input: Parameters<Router["invoke"]>[0],
  observer?: SearchObserver,
) {
  const target = new URL(input.url, "http://localhost");
  const observe = (pending: SearchObserver) => {
    target.searchParams.set("search_id", pending.search_id);
    target.searchParams.set("observer_token", pending.observer_token);
  };
  if (observer) observe(observer);
  return waitUntil(async () => {
    const result = await router.invoke({ ...input, url: target.pathname + target.search });
    if (result.status !== 202) return result;
    observe(result.body as SearchObserver);
    return undefined;
  }, `conversation search to settle: ${input.url}`);
}
