import { describe, expect, it } from "vitest";
import {
  MANDIBLE_INSTRUCTIONS_BEGIN,
  MANDIBLE_INSTRUCTIONS_END,
  installManagedInstructions,
  renderManagedInstructionsBlock,
  withMandibleInstructionsFragment,
} from "../src/instructions/fragment.js";

describe("Mandible instructions fragment", () => {
  it("installs and replaces the marked section idempotently", () => {
    const block = renderManagedInstructionsBlock("# Replacement\n");
    const first = installManagedInstructions("prefix\n", block);

    expect(first.changed).toBe(true);
    expect(first.content).toContain(MANDIBLE_INSTRUCTIONS_BEGIN);
    expect(first.content).toContain("# Replacement");
    expect(first.content).toContain(MANDIBLE_INSTRUCTIONS_END);

    const second = installManagedInstructions(first.content, block);
    expect(second.changed).toBe(false);

    const replacement = installManagedInstructions(first.content, renderManagedInstructionsBlock("# New\n"));
    expect(replacement.content).toContain("# New");
    expect(replacement.content).not.toContain("# Replacement");
  });

  it("reports drift and injects the fragment into SDK system prompts once", () => {

    const existingPrompt = "Project-specific prompt";
    const injected = withMandibleInstructionsFragment(existingPrompt);
    expect(injected).toContain(MANDIBLE_INSTRUCTIONS_BEGIN);
    expect(injected).toContain(existingPrompt);
    expect(withMandibleInstructionsFragment(injected)).toBe(injected);
  });
});
