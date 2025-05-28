// GITTOOLS/gitDiffClipboard.js
// Dynamically collects git diffs (incl. untracked file contents) from all subrepos and root,
// filters out noise (lock files, node_modules, etc), and copies to clipboard.
// Run from repo root:  node GITTOOLS/gitDiffClipboard.js

const { execSync, spawnSync } = require("child_process");
const path = require("path");
const fs   = require("fs");

// --------------------------------------------
// 1. Discover all git repos in root and 1-level subdirs
// --------------------------------------------
const REPO_ROOT = path.resolve(__dirname, "..");
const PROJECTS = [];

// Include root if it's a git repo
if (fs.existsSync(path.join(REPO_ROOT, ".git"))) {
  PROJECTS.push({ name: "Root", dir: "" });
}
// Include subdirs with .git
for (const entry of fs.readdirSync(REPO_ROOT, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  if ([".git", "node_modules", ".next", ".vscode", ".idea"].includes(entry.name)) continue;
  const subdir = path.join(REPO_ROOT, entry.name);
  if (fs.existsSync(path.join(subdir, ".git"))) {
    PROJECTS.push({ name: entry.name, dir: entry.name });
  }
}

// --------------------------------------------
// 2. Helper functions
// --------------------------------------------
const IGNORED_PATTERNS = [
  /^node_modules\//,
  /\.node$/,
  /package-lock\.json$/,
  /yarn\.lock$/,
  /pnpm-lock\.ya?ml$/,
  /\.DS_Store$/,
  /\.log$/,
  /\.env$/,
  /^\.vscode\//,
  /^\.idea\//,
  /\.gitignore$/,
  /\.eslint/,
/^\.next\//,
/^dist\//,
/^out\//,
];

function shouldIgnore(filePath) {
  return IGNORED_PATTERNS.some((re) => re.test(filePath));
}

const run = (cmd, opts = {}) => {
  try {
    return execSync(cmd, { encoding: "utf8", stdio: ["pipe", "pipe", "ignore"], ...opts }).trim();
  } catch {
    return "";
  }
};

function patchPaths(diff, prefix = "") {
  if (!diff) return "";
  return diff
    .replace(/^diff --git a\/(.+?) b\/(.+?)$/gm, (_, a, b) =>
      `diff --git ${prefix}${a} ${prefix}${b}`
    )
    .replace(/^--- a\/(.+)$/gm, (_, a) => `--- ${prefix}${a}`)
    .replace(/^\+\+\+ b\/(.+)$/gm, (_, b) => `+++ ${prefix}${b}`);
}

// --------------------------------------------
// 3. Gather diffs for each repo
// --------------------------------------------
(async () => {
  const clipboardy = await import("clipboardy").then((m) => m.default ?? m).catch(() => null);
  let output = "";

  for (const { name, dir } of PROJECTS) {
    const repoPath = path.join(REPO_ROOT, dir);
    const prefix   = dir ? dir.replace(/\\/g, "/") + "/" : "";

    run(`git -C "${repoPath}" fetch --all --prune --quiet`);

    // Figure out upstream branch for diffing
    let upstream = run(`git -C "${repoPath}" rev-parse --abbrev-ref --symbolic-full-name @{u}`);
    if (!upstream) {
      upstream = run(
        `git -C "${repoPath}" symbolic-ref refs/remotes/origin/HEAD`
      ).replace(/^refs\/remotes\//, "");
    }

    // Get diffs
    const unstaged = run(`git -C "${repoPath}" diff`);
    const staged   = run(`git -C "${repoPath}" diff --cached`);
    const unpushed = upstream ? run(`git -C "${repoPath}" diff ${upstream}..HEAD`) : "";

    // Filter out ignored files from diffs
    function filterDiff(diff) {
      // Only include diffs that are not for ignored files
      return diff.split(/^diff --git /gm).filter(block => {
        if (!block.trim()) return false;
        // First line after split is like "a/path b/path\n..."
        const match = block.match(/^a\/(.+?) b\/(.+?)\n/);
        if (match && (shouldIgnore(match[1]) || shouldIgnore(match[2]))) return false;
        return true;
      }).map((block, idx) => idx === 0 ? block : "diff --git " + block).join("");
    }

    const pUnstaged = patchPaths(filterDiff(unstaged), prefix);
    const pStaged   = patchPaths(filterDiff(staged),   prefix);
    const pUnpushed = patchPaths(filterDiff(unpushed), prefix);

    output += `### ${name} (${dir || "."})\n\n`;
    if (pUnpushed) output += `# 🆚 Remote vs HEAD (${upstream})\n${pUnpushed}\n\n`;
    if (pStaged)   output += `# ✔️ Staged changes\n${pStaged}\n\n`;
    if (pUnstaged) output += `# ✏️ Unstaged changes\n${pUnstaged}\n\n`;

    // Untracked files
    const untrackedList = run(
      `git -C "${repoPath}" ls-files --others --exclude-standard`
    ).split("\n").filter(Boolean)
    .filter(file => !shouldIgnore(file));

    if (untrackedList.length) {
      output += `# 🆕 Untracked files (full contents below)\n`;
      for (const file of untrackedList) {
        const filePath = path.join(repoPath, file);
        // Show as diff, or just include raw content if not a text file
        if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
          const diffNew = run(`git diff --no-index /dev/null "${filePath}"`);
          output += patchPaths(diffNew, prefix);
        }
      }
      output += "\n";
    }

    if (!pUnpushed && !pStaged && !pUnstaged && untrackedList.length === 0) {
      output += "_No local changes – working tree clean_\n\n";
    }
  }

  // 4. Copy to clipboard (cross-platform)
  let copied = false;
  if (clipboardy) {
    try {
      clipboardy.writeSync(output);
      copied = true;
      console.log("✔️ Git diffs copied to clipboard.\n");
    } catch {}
  }
  if (!copied && process.platform === "win32") {
    try {
      spawnSync("clip", { input: output, encoding: "utf8", shell: true });
      copied = true;
      console.log("✔️ Git diffs copied to clipboard (Windows).\n");
    } catch {}
  }
  if (!copied) {
    console.warn("⚠️ Couldn’t copy to clipboard – printing below.\n");
  }
  console.log(output);
})();
