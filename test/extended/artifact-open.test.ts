import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openArtifactExternally } from "../../src/artifact-open.js";
import { openDb, type Db } from "../../src/db.js";
import { recordArtifactVersion } from "../../src/provider-artifacts.js";

let tempDir = "";
let db: Db;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-artifact-open-"));
  process.env.MANDIBLE_ARTIFACT_DIR = path.join(tempDir, "managed");
  db = openDb(path.join(tempDir, "mandible.db"));
});

afterEach(() => {
  db.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
  delete process.env.MANDIBLE_ARTIFACT_DIR;
});

describe("artifact external open", () => {
  it("opens managed artifact custody through the injected default-app seam", async () => {
    const recorded = recordArtifactVersion(db, {
      source_kind: "managed",
      series_key: "managed:test-report",
      logical_name: "report.txt",
      content: "managed material\n",
      media_type: "text/plain",
    });
    const opener = vi.fn(async () => undefined);

    await expect(openArtifactExternally(db, recorded.artifact.id, opener)).resolves.toEqual({
      ok: true,
      artifact_id: recorded.artifact.id,
    });
    expect(opener).toHaveBeenCalledOnce();
    expect(fs.readFileSync(opener.mock.calls[0][0], "utf8")).toBe("managed material\n");
  });

  it("opens stored input bytes after the original path changes",async()=>{
    const input=path.join(tempDir,'input.txt');fs.writeFileSync(input,'saved material');
    const saved=recordArtifactVersion(db,{source_kind:'local_only',path:input,custody_mode:'managed'});
    fs.writeFileSync(input,'new material');
    const opener=vi.fn(async()=>undefined);
    expect(await openArtifactExternally(db,saved.version.id,opener)).toMatchObject({ok:true});
    expect(opener.mock.calls[0][0]).not.toBe(input);
    expect(fs.readFileSync(opener.mock.calls[0][0],'utf8')).toBe('saved material');
  });

  it("opens tracked repo material only through its registered checkout locator", async () => {
    const repoRoot = path.join(tempDir, "checkout");
    const trackedPath = path.join(repoRoot, "results", "report.md");
    fs.mkdirSync(path.dirname(trackedPath), { recursive: true });
    fs.writeFileSync(trackedPath, "tracked material\n");
    db.prepare(
      `INSERT INTO ledger_projects (id, display_name, created_at, updated_at)
       VALUES ('prj_repo', 'repo', 1, 1)`,
    ).run();
    db.prepare(
      `INSERT INTO ledger_project_checkouts (id, project_id, work_repo_id, root, name, created_at, updated_at)
       VALUES ('checkout_repo', 'prj_repo', 'repo', ?, 'repo', 1, 1)`,
    ).run(repoRoot);
    const git=(args:string[])=>execFileSync('git',['-C',repoRoot,...args],{stdio:'pipe'});
    git(['init','-b','main']);git(['config','user.name','Test']);git(['config','user.email','test@example.invalid']);git(['config','commit.gpgsign','false']);git(['add','.']);git(['commit','-m','save']);
    const saved=recordArtifactVersion(db,{source_kind:'tracked_repo',path:trackedPath,custody_mode:'git'});
    fs.writeFileSync(trackedPath,'changed checkout');
    const opener = vi.fn(async () => undefined);

    await expect(openArtifactExternally(db, saved.version.id, opener))
      .resolves.toMatchObject({ ok: true });
    expect(opener.mock.calls[0][0]).not.toBe(trackedPath);
    expect(fs.readFileSync(opener.mock.calls[0][0],'utf8')).toBe('tracked material\n');
  });

  it("rejects unavailable and non-file material without invoking the OS", async () => {
    const missing=recordArtifactVersion(db,{source_kind:'managed',series_key:'missing',content:'missing'});
    fs.unlinkSync(new URL(missing.artifact.uri));
    const directory=recordArtifactVersion(db,{source_kind:'managed',series_key:'directory',content:'directory'});
    const directoryPath=new URL(directory.artifact.uri);fs.unlinkSync(directoryPath);fs.mkdirSync(directoryPath);
    const opener = vi.fn(async () => undefined);

    await expect(openArtifactExternally(db, missing.version.id, opener))
      .resolves.toMatchObject({ ok: false, status: 409 });
    await expect(openArtifactExternally(db, directory.version.id, opener)).resolves.toMatchObject({
      ok: false,
      status: 409,
      reason: "stored artifact is not a regular file",
    });
    expect(opener).not.toHaveBeenCalled();
  });
});
