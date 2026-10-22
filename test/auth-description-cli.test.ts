// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { runCli, scratchDir, startStubDaemon } from "./helpers/cli-process.js";

const cleanups: Array<() => unknown> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

describe("command approval Description authoring", () => {
  it("submits explanatory Markdown from message/file without merge-only fields", async () => {
    const bodies: Record<string, unknown>[] = [];
    const stub = await startStubDaemon(({ method, url, body }) => {
      if (method === "POST" && url === "/api/auth/request") {
        bodies.push(body as Record<string, unknown>);
        return { status: 201, body: { request_id: "description-request", status: "pending" } };
      }
      return { body: {} };
    });
    cleanups.push(() => stub.close());
    const cwd = scratchDir("description-command");
    const text = "# Load reviewed configuration\n\nRestart the private service once.\n\nPreserve its existing data.";
    const file = path.join(cwd, "description.md");
    fs.writeFileSync(file,text);
    for (const authoring of [["--message",text],["--message-file",file]]) {
      const result = await runCli(["auth","request","--type","config-change","--command","echo exact-private-action",
        "--cwd",cwd,"--repo","mandible","--title","Load configuration","--issue","2ca1df1",...authoring,"--no-watch"], { cwd, env: stub.env });
      expect(result.status, result.stderr).toBe(0);
    }
    expect(bodies).toHaveLength(2);
    for (const body of bodies) {
      expect(body.commit_message).toBe(text);
      expect(body.canonical_message).toBe(false);
      expect(body.verification).toBeNull();
      expect(body.command).toBe("echo exact-private-action");
      expect(body.diff_summary).toBe("");
    }
  });

  it("refuses missing/blank Description and merge-only flags before transport", async () => {
    let submitted = 0;
    const stub = await startStubDaemon(({url}) => { if(url === "/api/auth/request")submitted++; return {body:{}}; });
    cleanups.push(() => stub.close());
    const cwd = scratchDir("description-refusal");
    const base=["auth","request","--type","config-change","--command","echo private","--cwd",cwd,"--repo","mandible",
      "--title","Private","--issue","2ca1df1","--no-watch"];
    for (const flags of [[],["--message"," \n "],["--message","Explain action","--verification","ok"],
      ["--message","Explain action","--handoff","next"],["--message","Explain action","--dirty-policy","stash"]]) {
      const result=await runCli([...base,...flags],{cwd,env:stub.env});
      expect(result.status,result.stderr).not.toBe(0);
    }
    expect(submitted).toBe(0);
  });
});
