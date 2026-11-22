import fs from "node:fs";
import path from "node:path";

/** Keep copied fixture repositories free of background Git maintenance. */
export function configureFixtureGit(repo: string, name: string, email: string, disableHooks = false): void {
  fs.appendFileSync(path.join(repo, ".git", "config"), `
[user]
    name = ${name}
    email = ${email}
[commit]
    gpgsign = false
[maintenance]
    auto = false
${disableHooks ? "[core]\n    hooksPath = /dev/null\n" : ""}`);
}
