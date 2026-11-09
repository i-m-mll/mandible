import { describe, expect, it } from "vitest";
import { appHref, parseAppPath, type AppRoute } from "../src/app-routes.js";

describe("app route table", () => {
  it("round-trips entity refs through their path, keeping typed-ref punctuation literal", () => {
    const cases: Array<[AppRoute, string]> = [
      [{ kind: "entity", entity: "issue", ref: "mandible/abc1234" }, "/issue/mandible/abc1234"],
      [{ kind: "entity", entity: "artifact", ref: "artifact-series:abcdef1@3" }, "/artifact/artifact-series:abcdef1@3"],
      [{ kind: "entity", entity: "briefing", ref: "a b?c#d%e" }, "/briefing/a%20b%3Fc%23d%25e"],
      [{ kind: "view", tab: "briefing" }, "/briefing"],
      [{ kind: "startup" }, "/"],
    ];
    for (const [route, path] of cases) {
      const href = appHref(route, { sidebar: "hidden", agent_session: "s", empty: "" });
      expect(href).toBe(`${path}?sidebar=hidden&agent_session=s`);
      const url = new URL(href, "https://app.mandible.localhost:19420");
      expect(parseAppPath(url.pathname)).toEqual(route);
    }
  });
});
