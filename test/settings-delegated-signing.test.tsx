import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/preact";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DelegatedSigningSection } from "../ui/src/views/settings";

function response(body: unknown): Promise<Response> {
  return Promise.resolve(new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  }));
}

const configured = {
  enabled: false,
  lease_id: null,
  enabled_until: null,
  remaining_ms: 0,
  duration_minutes: 60,
  signing: {
    provider: "yubikey-age",
    configured: true,
    public_key: "ssh-ed25519 AAAATEST delegated",
    public_key_path: "/tmp/delegated.pub",
    encrypted_passphrase_path: "/tmp/delegated.age",
    recipient_path: "/tmp/recipient.txt",
    missing_tools: [],
  },
};

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("delegated signing settings", () => {
  it("requires confirmation, removes key material, and refreshes visible status", async () => {
    const fetch = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe("/api/auth/clearances/signing");
      return response(init?.method === "DELETE"
        ? { ...configured.signing, configured: false, public_key: null }
        : configured.signing);
    });
    vi.stubGlobal("fetch", fetch);

    render(<DelegatedSigningSection />);
    const remove = await screen.findByRole("button", { name: "Remove" });
    fireEvent.click(remove);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("alertdialog")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Remove key material" }));
    await waitFor(() => expect(screen.getByText("Delegated signing material removed")).toBeTruthy());
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls[1]?.[1]).toMatchObject({ method: "DELETE" });
    expect(screen.getByRole("button", { name: "Set up" })).toBeTruthy();
  });
});
