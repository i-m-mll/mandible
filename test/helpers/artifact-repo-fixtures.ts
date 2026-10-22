import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { testRuntimeRoot } from "./runtime-isolation.js";

const templates = new Map<string, string>();

/** Copy immutable repository bytes; every caller owns its refs, index, config and objects. */
export function artifactRepo(root: string, files: Record<string, string> = {}): void {
  const entries = Object.entries(files).sort(([a], [b]) => a.localeCompare(b));
  const key = JSON.stringify(entries);
  let template = templates.get(key);
  if (!template) {
    template = fs.mkdtempSync(path.join(testRuntimeRoot, "artifact-repo-template-"));
    if (entries.length) {
      artifactRepo(template);
      for (const [name, bytes] of entries) {
        const filename = path.join(template, name);
        fs.mkdirSync(path.dirname(filename), { recursive: true });
        fs.writeFileSync(filename, bytes);
      }
      git(template, ["add", "."]);
      git(template, ["commit", "-qm", "Artifact fixture"]);
    } else {
      git(template, ["init", "-q", "-b", "main", "--template="]);
      fs.appendFileSync(path.join(template, ".git", "config"), `
[user]
    name = Artifact Test
    email = artifact-test@example.invalid
[commit]
    gpgsign = false
[core]
    hooksPath = /dev/null
`);
    }
    templates.set(key, template);
  }
  fs.cpSync(template, root, { recursive: true });
}

function git(root: string, args: string[]): void {
  execFileSync("git", ["--no-optional-locks", "-C", root, ...args], {
    timeout: 10_000, stdio: "pipe", env: { ...process.env, GIT_CONFIG_COUNT: "0" },
  });
}
