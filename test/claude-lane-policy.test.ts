import { expect, it } from "vitest";
import { describeAnthropicBilling } from "../src/claude-lane-policy.js";
it("preserves explicit billing metadata for historical Claude sessions", () => {
  expect(describeAnthropicBilling({})).toMatchObject({mode:"subscription",source:null});
  expect(describeAnthropicBilling({ANTHROPIC_API_KEY:"   "})).toMatchObject({mode:"subscription"});
  expect(describeAnthropicBilling({ANTHROPIC_API_KEY:"test"})).toMatchObject({mode:"api_key",source:"ANTHROPIC_API_KEY"});
  expect(describeAnthropicBilling({ANTHROPIC_AUTH_TOKEN:"test"})).toMatchObject({mode:"api_key",source:"ANTHROPIC_AUTH_TOKEN"});
});
