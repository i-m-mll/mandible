// @vitest-environment node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, expect, it } from "vitest";
import { HelperOperatorSigner, resolveApprovalHelperPath } from "../src/operator-signing/signer.js";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-helper-adapter-"));
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

/** A helper that records its request and environment, then prints `reply` and exits `code`. */
function helper(reply: string, code = 0): { signer: HelperOperatorSigner; request: () => unknown; env: () => string } {
  const name = `helper-${Math.random().toString(36).slice(2)}`;
  const file = path.join(dir, name);
  fs.writeFileSync(file, `#!/bin/sh\ncat > "${file}.in"\nenv > "${file}.env"\nprintf '%s' '${reply}'\nexit ${code}\n`, { mode: 0o700 });
  return { signer: new HelperOperatorSigner(file), request: () => JSON.parse(fs.readFileSync(`${file}.in`, "utf8")), env: () => fs.readFileSync(`${file}.env`, "utf8") };
}

const request = { key: "/keys/a.key", namespace: "git", message: Buffer.from("challenge"), reason: "approve merging x into main" };

it("speaks the helper contract and passes no environment", async () => {
  const h = helper('{"result":"signed","signature":"SIG"}');
  expect(await h.signer.sign(request)).toEqual({ result: "signed", signature: "SIG" });
  expect(h.request()).toEqual({ op: "sign", key: "/keys/a.key", namespace: "git", message: Buffer.from("challenge").toString("base64"), reason: "approve merging x into main" });
  expect(h.env()).not.toMatch(/^HOME=/m);
});

it("maps closed-set results and turns anything else into failed", async () => {
  expect(await helper('{"result":"cancelled"}').signer.sign(request)).toEqual({ result: "cancelled" });
  expect(await helper('{"result":"no_interactive_session"}').signer.sign(request)).toEqual({ result: "no_interactive_session" });
  expect(await helper('{"result":"failed","detail":"enclave error"}').signer.sign(request)).toEqual({ result: "failed", detail: "enclave error" });
  expect(await helper('{"result":"approved"}').signer.sign(request)).toMatchObject({ result: "failed" });
  expect(await helper('not json').signer.sign(request)).toMatchObject({ result: "failed" });
  expect(await helper('{"result":"signed","signature":"SIG"}', 64).signer.sign(request)).toMatchObject({ result: "failed" });
  expect(await helper('{"result":"status","keys":[{"key":"/k","state":"sleepy"}]}').signer.status(["/k"])).toMatchObject({ result: "failed" });
  expect(await new HelperOperatorSigner(null).sign(request)).toMatchObject({ result: "failed" });
});

it("kills the helper and reports cancelled when the caller aborts", async () => {
  const file = path.join(dir, "slow");
  fs.writeFileSync(file, "#!/bin/sh\nsleep 30\n", { mode: 0o700 });
  const controller = new AbortController();
  const pending = new HelperOperatorSigner(file).sign(request, controller.signal);
  setTimeout(() => controller.abort(), 50);
  expect(await pending).toEqual({ result: "cancelled" });
});

it("finds the helper only at an absolute configured path", () => {
  expect(resolveApprovalHelperPath({ MANDIBLE_APPROVAL_HELPER: "/opt/helper" })).toBe("/opt/helper");
  expect(resolveApprovalHelperPath({ MANDIBLE_APPROVAL_HELPER: "relative/helper" })).toBeNull();
});
