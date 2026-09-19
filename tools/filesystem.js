// 1. readFile — Read file contents
// 2. writeFile — Create/replace files (requires approval)
// 3. deleteFile — Delete a file (requires approval)
// 4. listFiles — List directory entries
// 5. searchFiles — Regex search over filenames with depth/match limits, ignores node_modules, .git, etc.

import fs from "node:fs/promises";
import path from "node:path";

const ROOT = path.resolve(
  process.env.AGENT_WORKSPACE || "./workspace"
);

const IGNORED_DIRS = new Set([
  "node_modules",
  ".git",
  ".svn",
  ".hg",
  "dist",
  "build",
  ".next",
  ".nuxt",
  "coverage",
  ".cache",
  "__pycache__",
  ".pytest_cache",
  "vendor",
  ".venv",
  "venv",
]);

const DEFAULT_MAX_DEPTH = 10;
const DEFAULT_MAX_MATCHES = 100;
const MAX_FILES_SCANNED = 10000;

function resolvePath(filePath) {
  const resolved = path.resolve(ROOT, filePath);

  if (
    resolved !== ROOT &&
    !resolved.startsWith(ROOT + path.sep)
  ) {
    throw new Error("Path outside workspace");
  }

  return resolved;
}

export async function readFile({ path: filePath }) {
  const file = resolvePath(filePath);
  return fs.readFile(file, "utf8");
}

export async function writeFile({ path: filePath, content }) {
  const file = resolvePath(filePath);

  await fs.mkdir(path.dirname(file), {
    recursive: true,
  });

  await fs.writeFile(file, content, "utf8");

  return `Updated ${filePath}`;
}

export async function deleteFile({ path: filePath }) {
  const file = resolvePath(filePath);
  await fs.unlink(file);
  return `Deleted ${filePath}`;
}

export async function listFiles({ path: dirPath = "." } = {}) {
  const dir = resolvePath(dirPath);
  const entries = await fs.readdir(dir, { withFileTypes: true });

  return entries.map((entry) => ({
    name: entry.name,
    type: entry.isDirectory() ? "directory" : "file",
    path: path.join(dirPath, entry.name),
  }));
}

export async function searchFiles({
  pattern,
  path: dirPath = ".",
  maxDepth = DEFAULT_MAX_DEPTH,
  maxMatches = DEFAULT_MAX_MATCHES,
} = {}) {
  const dir = resolvePath(dirPath);
  const regex = new RegExp(pattern, "i");
  const results = [];
  let filesScanned = 0;

  async function walk(currentDir, depth) {
    if (depth > maxDepth) return;
    if (results.length >= maxMatches) return;
    if (filesScanned >= MAX_FILES_SCANNED) return;

    let entries;
    try {
      entries = await fs.readdir(currentDir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (results.length >= maxMatches) break;
      if (filesScanned >= MAX_FILES_SCANNED) break;

      if (IGNORED_DIRS.has(entry.name)) continue;

      const fullPath = path.join(currentDir, entry.name);
      const relativePath = path.relative(ROOT, fullPath);

      if (entry.isDirectory()) {
        await walk(fullPath, depth + 1);
      } else {
        filesScanned++;
        if (regex.test(entry.name)) {
          results.push(relativePath);
        }
      }
    }
  }

  await walk(dir, 0);

  return {
    matches: results,
    truncated: results.length >= maxMatches || filesScanned >= MAX_FILES_SCANNED,
    filesScanned,
  };
}
