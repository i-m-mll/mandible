import { establishTestClientAccess } from './helpers/local-client-access';
import { authMainInstance, bindAuthUiOperations } from './helpers/auth-ui-fixture';
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/preact";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DelegatedSigningSection } from "../ui/src/views/settings";
import { __resetBrowserSessionForTests } from "../ui/src/client-auth-token";

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

beforeEach(async () => {
  await establishTestClientAccess();
  bindAuthUiOperations();
});

afterEach(() => {
  cleanup();
  __resetBrowserSessionForTests();
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

    render(<DelegatedSigningSection instance={authMainInstance} />);
    const remove = await screen.findByRole("button", { name: "Remove" });
    fireEvent.click(remove);
    expect(fetch.mock.calls.some(([input]) => String(input) === "/api/auth/clearances/signing")).toBe(true);
    expect(screen.getByRole("alertdialog")).toBeTruthy();
    expect(fetch.mock.calls.some(([, init]) => init?.method === "DELETE")).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: "Remove key material" }));
    await waitFor(() => expect(screen.getByText("Delegated signing material removed")).toBeTruthy());
    expect(fetch.mock.calls.find(([input, init]) =>
      String(input) === "/api/auth/clearances/signing" && init?.method === "DELETE")?.[1])
      .toMatchObject({ method: "DELETE", credentials: "same-origin" });
    const removal = fetch.mock.calls.find(([, init]) => init?.method === "DELETE")?.[1];
    expect(new Headers(removal?.headers).get("X-Mandible-CSRF")).toBe("test-csrf");
    expect(screen.getByRole("button", { name: "Set up" })).toBeTruthy();
  });
});
