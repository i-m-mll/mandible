import { nativeRevisionDiff } from "../platform-tools.js";
const [oldFile, newFile, oldLabel, newLabel] = process.argv.slice(2);
const result = nativeRevisionDiff(oldFile, newFile, oldLabel, newLabel);
if (result.ok) process.stdout.write(result.output);
else { console.error(result.message); process.exitCode = 1; }
