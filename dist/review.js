import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { promises as fs } from "node:fs";
import path from "node:path";
import { html as diffHtml, parse as diffParse } from "diff2html";
import { marked } from "marked";
const execFileAsync = promisify(execFile);
const CO_AUTHOR_PATTERN = /^Co-Authored-By:\s*(.+?)(?:\s*<.+>)?$/i;
const normalizePath = (value) => value.replace(/^a\//, "").replace(/^b\//, "");
const runGit = async (repoPath, args) => {
    const { stdout } = await execFileAsync("git", args, {
        cwd: repoPath,
        maxBuffer: 20 * 1024 * 1024,
    });
    return stdout;
};
const readFileIfExists = async (filePath) => {
    try {
        return await fs.readFile(filePath, "utf8");
    }
    catch (error) {
        if (error.code === "ENOENT") {
            return null;
        }
        throw error;
    }
};
const readGitFile = async (repoPath, ref, fileName) => {
    try {
        const output = await runGit(repoPath, ["show", `${ref}:${fileName}`]);
        return output;
    }
    catch (error) {
        const err = error;
        if (typeof err.message === "string" && err.message.includes("Path")) {
            return null;
        }
        return null;
    }
};
const readGitNotes = async (repoPath, ref) => {
    try {
        const output = await runGit(repoPath, ["notes", "show", ref]);
        return output;
    }
    catch (error) {
        return null;
    }
};
const extractCoAuthors = (body) => {
    const authors = new Set();
    for (const line of body.split(/\r?\n/)) {
        const match = line.match(CO_AUTHOR_PATTERN);
        if (!match) {
            continue;
        }
        const name = match[1].trim();
        if (name.length > 0) {
            authors.add(name);
        }
    }
    return Array.from(authors);
};
const mapDiffFiles = (diffFiles) => diffFiles.map((file) => {
    const newName = typeof file.newName === "string" ? file.newName : "";
    const oldName = typeof file.oldName === "string" ? file.oldName : "";
    const filePath = normalizePath(newName || oldName);
    const additions = typeof file.addedLines === "number" ? file.addedLines : 0;
    const deletions = typeof file.deletedLines === "number" ? file.deletedLines : 0;
    const blocks = Array.isArray(file.blocks) ? file.blocks : [];
    return {
        path: filePath,
        additions,
        deletions,
        hunks: blocks,
    };
});
export const getDiff = async (repoPath, base, head) => {
    const diffArgs = ["diff", `${base}...${head}`];
    const statArgs = ["diff", "--stat", `${base}...${head}`];
    const [raw, stat] = await Promise.all([
        runGit(repoPath, diffArgs),
        runGit(repoPath, statArgs),
    ]);
    const jsonFiles = diffParse(raw, {
        diffStyle: "word",
        matching: "lines",
    });
    const html = diffHtml(raw, {
        outputFormat: "line-by-line",
        drawFileList: true,
        matching: "lines",
    });
    return {
        raw,
        stat: stat.trim(),
        files: mapDiffFiles(jsonFiles),
        html,
    };
};
export const getSpec = async (repoPath, branch) => {
    if (branch) {
        const noteContent = await readGitNotes(repoPath, branch);
        if (noteContent !== null) {
            return {
                source: "git-notes",
                raw: noteContent,
                html: marked.parse(noteContent),
            };
        }
    }
    const candidates = ["COMMIT_MSG.txt", "README_COMMIT.md"];
    for (const candidate of candidates) {
        const filePath = path.join(repoPath, candidate);
        const content = await readFileIfExists(filePath);
        if (content !== null) {
            return {
                source: candidate,
                raw: content,
                html: marked.parse(content),
            };
        }
        if (branch) {
            const gitContent = await readGitFile(repoPath, branch, candidate);
            if (gitContent !== null) {
                return {
                    source: candidate,
                    raw: gitContent,
                    html: marked.parse(gitContent),
                };
            }
        }
    }
    return {
        source: "",
        raw: "",
        html: "",
    };
};
export const getCommitLog = async (repoPath, base, head) => {
    const format = [
        "%H",
        "%h",
        "%an",
        "%ad",
        "%s",
        "%B",
    ].join("%x1f");
    const logArgs = [
        "log",
        "--date=iso-strict",
        `--pretty=format:${format}%x1e`,
        `${base}...${head}`,
    ];
    const output = await runGit(repoPath, logArgs);
    const records = output.split("\x1e").filter((entry) => entry.trim().length > 0);
    const commits = records.map((record) => {
        const [hash, shortHash, author, date, subject, body] = record.split("\x1f");
        const fullBody = body ?? "";
        return {
            hash: hash ?? "",
            short_hash: shortHash ?? "",
            message: subject ?? "",
            author: author ?? "",
            date: date ?? "",
            co_authors: extractCoAuthors(fullBody),
        };
    });
    return {
        commits,
        total: commits.length,
    };
};
