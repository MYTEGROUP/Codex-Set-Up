#!/usr/bin/env node
/* ===========================================================================
 *  gitHistoryExtractor.js
 *  Recursively discover Git repos, let user pick branches & commits, and
 *  copy their diffs to the clipboard (plus optional stdout).
 *
 *  Usage (interactive):
 *      node GITTOOLS/gitHistoryExtractor.js
 *
 *  Usage (headless):
 *      node GITTOOLS/gitHistoryExtractor.js --yes --repos api,web --branches main --stdout
 * ---------------------------------------------------------------------------
 *  © 2025 Myte Group • MIT License
 * ==========================================================================*/

const fs               = require("fs");
const path             = require("path");
const { execFileSync, spawnSync } = require("child_process");
const processArgs      = require("minimist")(process.argv.slice(2));
const clipboardy       = require("clipboardy");
const inquirer         = require("@inquirer/prompts");
const whichSync        = require("which").sync;

// ---------- Helpers ---------------------------------------------------------
const REPO_ROOT           = path.resolve(__dirname, "..");
const MAX_DEFAULT_COMMITS = 6;
const COLOR_RESET         = "\x1b[0m",
      COLOR_GREEN         = "\x1b[32m",
      COLOR_YELLOW        = "\x1b[33m";

/**
 * Return true if a diff header path matches any pattern we want to ignore.
 */
function shouldIgnoreDiff(filePath) {
  const IGNORED_PATTERNS = [
    /^node_modules\//,            // dependency dir
    /\.node$/,                    // compiled binary modules
    /package-lock\.json$/,        // npm lockfile
    /npm-shrinkwrap\.json$/,      // npm shrinkwrap
    /yarn\.lock$/,                // yarn lockfile
    /\.pnpm-lock\.ya?ml$/,        // pnpm lockfile
    /\.DS_Store$/,                // macOS system file
    /\.log$/,                     // log files
    /\.env$/,                     // env configs
    /^\.vscode\//,                // VSCode settings
    /^\.idea\//                   // JetBrains IDE settings
  ];
  return IGNORED_PATTERNS.some(re => re.test(filePath));
}

function run(repoDir, args, opts = {}) {
  try {
    return execFileSync("git", ["-C", repoDir, ...args], {
      encoding: "utf8",
      stdio: ["pipe", "pipe", "ignore"],
      ...opts,
    }).trimEnd();
  } catch {
    return "";
  }
}

function patchPaths(diff, prefix = "") {
  if (!prefix) return diff;
  return diff
    .replace(/^diff --git a\/(.+?) b\/(.+?)$/gm, (_, a, b) =>
      `diff --git ${prefix}${a} ${prefix}${b}`)
    .replace(/^--- a\/(.+)$/gm, (_, a) => `--- ${prefix}${a}`)
    .replace(/^\+\+\+ b\/(.+)$/gm, (_, b) => `+++ ${prefix}${b}`);
}

function copyToClipboard(text) {
  try {
    clipboardy.writeSync(text);
    return true;
  } catch {
    if (process.platform === "darwin" && whichSync("pbcopy", { nothrow: true })) {
      return spawnSync("pbcopy",   { input: text }).status === 0;
    }
    if (process.platform === "win32") {
      return spawnSync("clip",     { input: text, shell: true }).status === 0;
    }
    if (whichSync("xclip", { nothrow: true })) {
      return spawnSync("xclip -sel clip", { input: text, shell: true }).status === 0;
    }
    return false;
  }
}

// ---------- 1) Discover Git repos ------------------------------------------
function discoverRepos() {
  const repos = [];
  if (fs.existsSync(path.join(REPO_ROOT, ".git"))) {
    repos.push({ name: "Root", dir: "" });
  }
  for (const entry of fs.readdirSync(REPO_ROOT, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (processArgs.exclude && entry.name.match(processArgs.exclude)) continue;
    const subdir = path.join(REPO_ROOT, entry.name);
    if (fs.existsSync(path.join(subdir, ".git"))) {
      repos.push({ name: entry.name, dir: entry.name });
    }
  }
  if (!repos.length) {
    console.error("❌  No Git repositories found under", REPO_ROOT);
    process.exit(2);
  }
  return repos;
}

// ---------- 2) Interactive / non-interactive selections --------------------
async function choose(items, message, multi = false, argValue) {
  if (argValue) {
    const wanted = argValue.split(",").map(s => s.trim());
    return items.filter(it => wanted.includes(it.value || it));
  }
  if (!process.stdout.isTTY) {
    console.error("❌  Terminal not interactive and no CLI override for", message);
    process.exit(2);
  }
  const promptType = multi ? inquirer.checkbox : inquirer.select;
  return promptType({
    message,
    choices: items.map(it => typeof it === "string" ? { name: it, value: it } : it),
    pageSize: 20,
  });
}

// ---------- 3) Main flow ----------------------------------------------------
(async () => {
  const allRepos = discoverRepos();

  // 3.1 Repo selection
  const repoChoices   = allRepos.map(r => ({ name: r.name, value: r }));
  const selectedRepos = await choose(repoChoices, "Select repos:", true, processArgs.repos);

  // 3.2 Fetch remotes
  await Promise.all(selectedRepos.map(r =>
    new Promise(res => {
      run(path.join(REPO_ROOT, r.dir), ["fetch", "--all", "--prune", "--quiet"]);
      res();
    })
  ));

  // 3.3 Branch selection
  const branchSelections = {};
  for (const repo of selectedRepos) {
    const repoPath   = path.join(REPO_ROOT, repo.dir);
    const branchesRaw = run(repoPath, [
      "for-each-ref",
      "--format=%(refname:short)%09%(HEAD)%09%(upstream:short)",
      "refs/heads"
    ]);
    const choices = branchesRaw.split("\n").filter(Boolean).map(line => {
      const [name, headMark, upstream] = line.split("\t");
      let label = (headMark === "*" ? `${COLOR_GREEN}${name}${COLOR_RESET}` : name);
      if (upstream) {
        const [ahead, behind] = run(repoPath, [
          "rev-list", "--left-right", "--count", `${name}...${upstream}`
        ]).split("\t");
        if (+ahead)  label += `${COLOR_YELLOW} ↑${ahead}${COLOR_RESET}`;
        if (+behind) label += `${COLOR_YELLOW} ↓${behind}${COLOR_RESET}`;
      }
      return { name: label, value: name };
    });
    branchSelections[repo.dir] = await choose(choices, `Branches in ${repo.name}:`, true, processArgs.branches);
  }

  // 3.4 Commit selection & diff aggregation
  let totalDiff = "";

  for (const repo of selectedRepos) {
    const repoPath = path.join(REPO_ROOT, repo.dir);
    const prefix   = repo.dir ? repo.dir.replace(/\\/g, "/") + "/" : "";

    let repoSection  = `\n====================\nRepository: ${repo.name}\n====================\n`;
    let hasRepoDiffs = false;

    for (const branch of branchSelections[repo.dir]) {
      const limit  = processArgs.limit || MAX_DEFAULT_COMMITS;
      const logRaw = run(repoPath, [
        "log", branch, `-n${limit}`,
        "--pretty=format:%h%x09%ad%x09%s", "--date=short"
      ]);
      if (!logRaw) continue;

      const commits = logRaw.split("\n").map(l => {
        const [sha, date, subject] = l.split("\t");
        return { sha, label: `[${sha}]  ${date}  ${subject}` };
      });
      const commitChoices = commits.map(c => ({ name: c.label, value: c.sha }));
      const selectedSHAs  = await choose(commitChoices, `Commits in ${repo.name}/${branch}:`, true, processArgs.commits);

      for (const sha of selectedSHAs) {
        // get commit info and raw diff
        const commitInfoRaw = run(repoPath, [
          "log", "-1", "--pretty=format:%h %ad %an: %s", "--date=short", sha
        ]);
        const rawDiff = run(repoPath, [
          "show", "--patch", "--find-renames", "--binary", "--color=never", sha
        ], { maxBuffer: 1024 * 1024 * 50 });

        // patch file paths
        const patched = patchPaths(rawDiff, prefix);

        // filter out ignored-file-only commits
        const hasRelevantChanges = !patched
          .split("\n")
          .filter(line => line.startsWith("diff --git"))
          .every(line => {
            const match = line.match(/^diff --git [ab]\/(.+?) [ab]\/(.+)$/);
            return match && shouldIgnoreDiff(match[1]);
          });

        if (hasRelevantChanges) {
          repoSection += `\n------------------------------------------\nCommit: ${commitInfoRaw}\n------------------------------------------\n`;
          repoSection += `DIFF=\n${patched}\n\n`;
          hasRepoDiffs = true;
        }
      }
    }

    if (hasRepoDiffs) {
      totalDiff += repoSection;
    }
  }

  if (!totalDiff) {
    console.log("No diffs selected.  Goodbye!");
    process.exit(1);
  }

  // 3.5 Confirm (unless --yes)
  if (!processArgs.yes && process.stdout.isTTY) {
    const ok = await inquirer.confirm({ message: "Copy diffs to clipboard?", default: true });
    if (!ok) process.exit(1);
  }

  const copied = copyToClipboard(totalDiff);
  if (!copied) console.error("⚠️  Could not copy to clipboard – printing below.");

  if (!processArgs.quiet || !copied) {
    process.stdout.write(totalDiff);
  }

  process.exit(copied ? 0 : 1);
})();
