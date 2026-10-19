import { describe, expect, it } from "vitest";
import {
  MANDIBLE_INSTRUCTIONS_BEGIN,
  MANDIBLE_INSTRUCTIONS_END,
  diffManagedInstructions,
  installManagedInstructions,
  renderMandibleInstructionsFragment,
  renderManagedInstructionsBlock,
  withMandibleInstructionsFragment,
} from "../src/instructions/fragment.js";

describe("Mandible instructions fragment", () => {
  it("renders the contract-only interface fragment from the authored Markdown", () => {
    const fragment = renderMandibleInstructionsFragment();

    expect(fragment).toContain("# Mandible Interface Contract");
    expect(fragment).toContain("mandible issue heads <id>...");
    expect(fragment).toContain("mandible umbrella manifest refresh <umbrella>");
    expect(fragment).toContain("mandible briefing bundle replace <bundle-ref>");
    expect(fragment).toContain("mandible briefing group configure <group-ref>");
    expect(fragment).toContain("mandible briefing archive <briefing-ref>");
    expect(fragment).toContain("Commit messages have no issue-linking or closure semantics.");
    expect(fragment).toContain("## Authored Markdown References");
    expect(fragment).toContain("Authored ledger Markdown issue refs use `[issue:<id>]`");
    expect(fragment).toContain("Authored ledger Markdown comment refs use `[issue:<id>#<n>]`");
    expect(fragment).toContain("Do not write `[references:<id>]`, `[closes:<id>]`");
    expect(fragment).toContain("`[artifact:<short-id>]` names a logical artifact");
    expect(fragment).toContain("`mandible artifact format <ref> --as markdown`");
    expect(fragment).toContain("mandible artifact ingest");
    expect(fragment).toContain("must never emit legacy `[artifact:sha256:<hash>]`");
    expect(fragment).toContain("Authored ledger Markdown auth request refs use `[auth:<short-id>]`");
    expect(fragment).toContain("worker_status");
    expect(fragment).toContain("MANDIBLE_BASE=file:///path/to/spool");
    expect(fragment).not.toContain("YubiKey");
    expect(fragment).not.toContain("id_ed25519_agents");
  });

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
    expect(diffManagedInstructions("")).toContain("Mandible Interface Contract");

    const existingPrompt = "Project-specific prompt";
    const injected = withMandibleInstructionsFragment(existingPrompt);
    expect(injected).toContain(MANDIBLE_INSTRUCTIONS_BEGIN);
    expect(injected).toContain(existingPrompt);
    expect(withMandibleInstructionsFragment(injected)).toBe(injected);
  });
});
