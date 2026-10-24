import { AUTH_MERGE_REVIEW } from "./helpers/auth-queue-fixtures.js";
// @vitest-environment node
import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { beforeEach, afterEach, expect, it } from "vitest";
import { AuthQueue } from "../src/auth-queue.js";
import { authRequestSnapshot } from "../src/auth-request-snapshot.js";
import { createSpace } from "../src/ledger/spaces.js";
import { recordArtifactVersion } from "../src/provider-artifacts.js";
import { addCredential } from "../src/users/store.js";
import { commitOnBranch, configureSigningCredential, createAuthCheckRepo, createLedgerIssue, createLedgerProject, createMigratedDb, createNoopHookManager, git, registerWorkRepo } from "./helpers/auth-queue-fixtures.js";
import { publishTestCandidate } from "./helpers/auth-delivery-fixtures.js";
import type { AuthRequestInput } from "../src/types.js";

let db: ReturnType<typeof createMigratedDb>, repo: string, queue: AuthQueue, operatorId: string, credentialId: string;
let publication: string, issue: string, project: string;
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const original = Array.from({ length: 40 }, (_, i) => `line ${i}`).join("\n") + "\n";
const source = original.replace("line 4\n", "published line 4\n");
const makeQueue = () => new AuthQueue({ db, backgroundMaintenance: false, hookManager: createNoopHookManager(), executor: async () => new Promise(() => {}) });

beforeEach(() => {
  repo = createAuthCheckRepo(); db = createMigratedDb();
  process.env.MANDIBLE_ARTIFACT_DIR = path.join(repo, ".git", "artifacts");
  fs.writeFileSync(path.join(repo, "doc.md"), original);
  git(repo, ["add", "doc.md"]); git(repo, ["commit", "-m", "Document base"]);
  operatorId = configureSigningCredential(db, repo, "ssh_key").operatorId;
  fs.appendFileSync(path.join(repo, ".git", "info", "exclude"), "\n.mandible-test-signing-key*\n");
  registerWorkRepo(db, repo);
  const registered = createLedgerProject(db, repo); project = registered.project.id;
  issue = createLedgerIssue(db, project, "publication-guard").id;
  const space = createSpace(db, { project_id: project, title: "Document", default_renderer: "document" });
  commitOnBranch(repo, "feature/publication", { "doc.md": source });
  const head = git(repo, ["rev-parse", "feature/publication"]);
  const snapshot = recordArtifactVersion(db, { source_kind: "managed", custody_mode: "managed", content: source, series_key: `publication:${space.id}` });
  const version = recordArtifactVersion(db, { project, commit: head, path: "doc.md", source_kind: "tracked_repo", custody_mode: "git" });
  publication = randomUUID();
  db.prepare(`INSERT INTO space_publications (id,space_id,source_revision,snapshot_ref,content,repo_id,path,expected_destination_sha256,expected_destination_mode,issue_id,message,branch,worktree,commit_sha,version_ref,state,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'committed',?)`).run(publication,space.id,hash(source),snapshot.artifact_version.id,source,registered.checkout.id,"doc.md",hash(original),"100644",issue,"Publish document","feature/publication",repo,head,version.artifact_version.id,Date.now());
  credentialId = addCredential(db,operatorId,{ type:"api_token",fingerprint:`publication-${randomUUID()}` }).id;
  db.prepare(`INSERT INTO work_units(id,issue_id,ledger_issue_id,repo_id,branch,kind,state,created_at,activated_at,owner_user_id,owner_credential_id,custody_generation)
    VALUES (?,?,?,?,?,'solo','committed',1,1,?,?,1)`).run(randomUUID(),issue,issue,registered.project.project_key,"feature/publication",operatorId,credentialId);
  queue = makeQueue();
});
afterEach(async () => { (await queue.dispose()); db.close(); delete process.env.MANDIBLE_ARTIFACT_DIR; fs.rmSync(repo,{ recursive:true,force:true }); });

async function submit(patch: Partial<AuthRequestInput> = {}) {
  return (await queue.submit({ ...AUTH_MERGE_REVIEW,  type:"merge",command:"mandible auth merge feature/publication --into main",title:"Publish document",cwd:repo,repo:path.basename(repo),head_branch:"feature/publication",base_branch:"main",merge_head_sha:git(repo,["rev-parse","feature/publication"]),space_publication_id:publication,issue_references:[issue],requester_evidence_method:"api_token",requester_credential_id:credentialId,require_delivery_custody:true,...patch },operatorId));
}
async function advance(changes: Record<string,string>, modeChange = false) {
  commitOnBranch(repo,"feature/sibling",changes);
  if (modeChange) {
    git(repo,["checkout","feature/sibling"]); fs.chmodSync(path.join(repo,"doc.md"),0o755);
    git(repo,["add","doc.md"]); git(repo,["commit","--amend","--no-edit"]); git(repo,["checkout","main"]);
  }
  const sibling = (await queue.submit({ ...AUTH_MERGE_REVIEW, type:"merge",command:"mandible auth merge feature/sibling --into main",title:"Sibling",cwd:repo,repo:path.basename(repo),head_branch:"feature/sibling",base_branch:"main",merge_head_sha:git(repo,["rev-parse","feature/sibling"])}));
  await queue.approveWithOperatorProof(sibling.id,operatorId);
  const result = publishTestCandidate(repo,(await queue.getRequest(sibling.id))!);
  expect((await queue.setResult(sibling.id,0,result.output)).exit_code).toBe(0);
  (await queue.dispose()); queue = makeQueue();
  return result.mergeSha;
}

it("atomically binds frozen source/destination and retains same-publication supersession history", async () => {
  const request = (await submit());
  expect((await queue.getRequest(request.id))?.space_publication_id).toBe(publication);
  expect(db.prepare("SELECT auth_request_id,state FROM space_publications WHERE id=?").get(publication)).toEqual({auth_request_id:request.id,state:"submitted"});
  const snapshot = JSON.parse(authRequestSnapshot(db,request.id));
  expect(snapshot.publication).toMatchObject({id:publication,source_revision:hash(source),expected_destination_sha256:hash(original),expected_destination_mode:"100644"});
  expect(() => db.prepare("UPDATE auth_requests SET space_publication_id=NULL WHERE id=?").run(request.id)).toThrow("immutable");
  const replacement = (await submit({space_publication_id:undefined,supersedes_request_id:request.id,expected_revision:1,expected_custody_generation:1,title:"Replacement"}));
  expect(replacement.space_publication_id).toBe(publication);
  expect((await queue.getRequest(request.id))?.space_publication_id).toBe(publication);
  expect(JSON.parse(authRequestSnapshot(db,request.id)).publication).toEqual(snapshot.publication);
  expect(db.prepare("SELECT auth_request_id FROM space_publications WHERE id=?").get(publication)).toEqual({auth_request_id:replacement.id});
});

it.each(["bytes", "mode"])("rejects same-path clean signed target %s advancement before refresh or proof", async (kind) => {
  const request = (await submit());
  const base = await advance(kind === "bytes" ? {"doc.md":original.replace("line 34\n","sibling line 34\n")} : {"unrelated.txt":"mode fixture\n"},kind === "mode");
  expect((await queue.checkMergeIndependence({request_id:request.id,cwd:repo,repo:path.basename(repo),head_branch:"feature/publication",base_branch:"main"})).status).toBe("clean");
  const background = queue as unknown as { revalidatePendingMergeRequestsSerialized(request: unknown): Promise<void> };
  await background.revalidatePendingMergeRequestsSerialized(queue.listHistory().find(row => row.head_branch === "feature/sibling")!);
  expect((await queue.getRequest(request.id))?.error).toContain("Destination changed");
  const before = (await queue.getRequest(request.id))!;
  const repin = queue as unknown as { repinMergeCandidate(request:unknown,base:string,fingerprint:null):Promise<unknown> };
  await expect(repin.repinMergeCandidate(before,base,null)).rejects.toThrow("Destination changed");
  await expect(queue.approveWithOperatorProof(request.id,operatorId)).rejects.toThrow("Destination changed");
  expect((await queue.getRequest(request.id))).toMatchObject({status:"pending",merge_candidate_pin_sha:before.merge_candidate_pin_sha});
  expect(git(repo,["rev-parse","main"])).toBe(base);
});

it("allows unrelated signed base advancement and freezes the refreshed exact publication candidate", async () => {
  const request = (await submit());
  const base = await advance({"unrelated.txt":"independent\n"});
  const approved = await queue.approveWithOperatorProof(request.id,operatorId);
  expect(approved).toMatchObject({status:"executing",merge_preflight_base_sha:base,space_publication_id:publication});
  expect(git(repo,["show",`${approved.merge_candidate_tree_sha}:doc.md`])).toBe(source.trim());
  expect(git(repo,["show",`${approved.merge_candidate_tree_sha}:unrelated.txt`])).toBe("independent");
});

it("rolls back request and publication together when atomic binding fails", async () => {
  db.exec("CREATE TRIGGER refuse_publication_binding BEFORE UPDATE OF auth_request_id ON space_publications BEGIN SELECT RAISE(ABORT,'binding unavailable'); END");
  await expect((async () => (await submit())())).rejects.toThrow("binding unavailable");
  expect(db.prepare("SELECT count(*) AS n FROM auth_requests").get()).toEqual({n:0});
  expect(db.prepare("SELECT state,auth_request_id FROM space_publications WHERE id=?").get(publication)).toEqual({state:"committed",auth_request_id:null});
  expect(git(repo,["for-each-ref","--format=%(refname)","refs/mandible/auth-candidates"])).toBe("");
});
