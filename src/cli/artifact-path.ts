import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { classifyLocalSymlink } from "../provider-artifacts.js";

const [operation, ...args] = process.argv.slice(2);
const absolute = (input: string) => path.resolve(input === "~" ? os.homedir() : input.startsWith("~/") ? path.join(os.homedir(), input.slice(2)) : input);
if (operation === "abs") console.log(absolute(args[0]));
else if (operation === "real") console.log(fs.realpathSync(absolute(args[0])));
else if (operation === "rel") console.log(path.relative(args[1], args[0]).split(path.sep).join("/"));
else if (operation === "symlink") console.log(JSON.stringify(classifyLocalSymlink(args[0], args[1], { inside_worktree: Boolean(args[2]), repo_root: args[2] || null })));
else if (operation === "batch") {
  const [cwd, commit, project, artifact_id, custody_mode, role, issue, dryRun, , , ...paths] = args;
  console.log(JSON.stringify({ paths: commit ? paths : paths.map(absolute), cwd, dry_run: dryRun === "1",
    ...Object.fromEntries(Object.entries({ commit, project, artifact_id, custody_mode, role, issue }).filter(([, value]) => value)),
  }));
} else throw new Error(`Unknown artifact path operation: ${operation}`);
