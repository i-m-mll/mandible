import { artifactRepo } from "./helpers/artifact-repo-fixtures.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openArtifactExternally } from "../src/artifact-open.js";
import { type Db } from "../src/db.js";
import { recordArtifactVersion } from "./helpers/artifact-http-write-fixtures.js";
import { insertRawLedgerCheckout, insertRawLedgerProject, migratedMemoryDb } from "./helpers/ledger-fixtures.js";

let tempDir = "";
let db: Db;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-artifact-open-"));
  process.env.MANDIBLE_ARTIFACT_DIR = path.join(tempDir, "managed");
  db = migratedMemoryDb();
});

afterEach(() => {
  vi.restoreAllMocks();
  db.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
  delete process.env.MANDIBLE_ARTIFACT_DIR;
});

describe("artifact external open", () => {

  it("opens tracked repo material only through its registered checkout locator", async () => {
    const repoRoot = path.join(tempDir, "checkout");
    const trackedPath = path.join(repoRoot, "results", "report.md");
    artifactRepo(repoRoot, { "results/report.md": "tracked material\n" });
    const projectId = insertRawLedgerProject(db, { name: "repo", projectKey: "repo" });
    insertRawLedgerCheckout(db, { projectId, name: "repo", root: repoRoot });
    const saved=recordArtifactVersion(db,{source_kind:'tracked_repo',path:trackedPath,custody_mode:'git'});
    fs.writeFileSync(trackedPath,'changed checkout');
    db.prepare('UPDATE artifact_version SET metadata_json=? WHERE id=?').run(JSON.stringify({filename:'../../escaped.md'}),saved.version.id);
    const opener = vi.fn(async () => undefined);

    await expect(openArtifactExternally(db, saved.version.id, opener))
      .resolves.toMatchObject({ ok: true });
    expect(opener.mock.calls[0][0]).not.toBe(trackedPath);
    expect(fs.readFileSync(opener.mock.calls[0][0],'utf8')).toBe('tracked material\n');
    const opened=opener.mock.calls[0][0];
    expect(path.basename(opened)).toBe('escaped.md');
    expect(fs.realpathSync(path.dirname(path.dirname(opened)))).toBe(fs.realpathSync(os.tmpdir()));
    fs.rmSync(path.dirname(opened),{recursive:true});
    const victim=path.join(tempDir,'victim');fs.writeFileSync(victim,'keep');
    const originalOpen=fs.openSync;
    const spy=vi.spyOn(fs,'openSync').mockImplementation((filename,flags,mode)=>{
      if (typeof flags === 'number' && (flags & fs.constants.O_EXCL)) fs.symlinkSync(victim,filename);
      return originalOpen(filename,flags,mode);
    });
    opener.mockClear();
    expect(await openArtifactExternally(db,saved.version.id,opener)).toMatchObject({ok:false,status:409});
    spy.mockRestore();
    expect(opener).not.toHaveBeenCalled();
    expect(fs.readFileSync(victim,'utf8')).toBe('keep');

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
