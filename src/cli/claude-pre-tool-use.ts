import { claudePreToolUseProjection } from "../claude-execution-context.js";
import fs from "node:fs";
const input = fs.readFileSync(0, "utf8");
try { process.stdout.write(`${JSON.stringify(claudePreToolUseProjection(JSON.parse(input)))}\n`); }
catch { process.stdout.write("{}\n"); }
