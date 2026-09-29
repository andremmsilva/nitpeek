/**
 * Files changed by shell commands.
 *
 * Agents often edit with `sed -i`, `python3 - <<EOF`, `cp`, redirections or
 * scripts instead of the Edit tool, and those leave no diff in the transcript.
 * For each Bash call we collect the files it could have touched (paths in the
 * command, resolved against the working directory and any `cd`, the files
 * already in the review, and the repository's modified files) and keep those
 * whose modification time falls inside the command's run.
 */

import { execFileSync } from "node:child_process";
import { statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fromText, MAX_FILE, type Snapshot } from "./snapshot.js";

/** Slack around the command's start/end timestamps (transcript vs file clock rounding). */
export const WINDOW_SLACK = 1500;

const unquote = (text: string) => text.replace(/^(["'])(.*)\1$/, "$2");
const expandHome = (path: string) => (path === "~" ? homedir() : path.startsWith("~/") ? join(homedir(), path.slice(2)) : path);

/** Absolute paths a command may have written, before checking the disk. */
export function shellPaths(command: string, cwd: string): string[] {
  const bases = [cwd];
  for (const match of command.matchAll(/(?:^|&&|\|\||;|\n|\()\s*(?:builtin\s+)?cd\s+("[^"\n]+"|'[^'\n]+'|[^\s;&|()]+)/g)) {
    bases.push(resolve(bases.at(-1)!, expandHome(unquote(match[1]))));
  }
  for (const match of command.matchAll(/\bgit\s+-C\s+("[^"\n]+"|'[^'\n]+'|\S+)/g)) bases.push(resolve(cwd, expandHome(unquote(match[1]))));
  const found = new Set<string>();
  let tokens = 0;
  for (const match of command.matchAll(/"([^"\n]{1,400})"|'([^'\n]{1,400})'|([^\s"'`<>|;&(){}=,\[\]]+)/g)) {
    if (++tokens > 600) break;
    const token = (match[1] ?? match[2] ?? match[3]).replace(/^[>@]+/, "").replace(/[:.]+$/, "");
    if (!token || token.startsWith("-") || token.includes("://") || /[$*?\\]/.test(token) || token.length > 300) continue;
    if (!token.includes("/") && !/\.[A-Za-z][\w-]{0,9}$/.test(token)) continue;
    const path = expandHome(token);
    if (isAbsolute(path)) found.add(resolve(path));
    else for (const base of bases) found.add(resolve(base, path));
  }
  return [...found];
}

/** Modified and untracked files of the repository containing `root`, cached briefly. */
let statusCache: { root: string; at: number; files: string[] } | undefined;
export function repositoryChanges(root: string): string[] {
  if (statusCache?.root === root && Date.now() - statusCache.at < 5000) return statusCache.files;
  let files: string[] = [];
  try {
    const top = execFileSync("git", ["-C", root, "rev-parse", "--show-toplevel"], { encoding: "utf8", timeout: 2000, stdio: ["ignore", "pipe", "ignore"] }).trim();
    const status = execFileSync("git", ["-C", top, "status", "--porcelain", "-z", "-uall"], { encoding: "utf8", timeout: 3000, maxBuffer: 8 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] });
    files = status.split("\0").filter(Boolean).map(line => line.slice(3)).filter(Boolean).slice(0, 5000).map(path => join(top, path));
  } catch {}
  statusCache = { root, at: Date.now(), files };
  return files;
}

/** Scratch space and byproducts: temp folders, logs, Claude's own task outputs. */
const TEMP = [tmpdir(), "/tmp/", "/private/tmp/", "/var/folders/", "/private/var/folders/"].map(p => p.endsWith("/") ? p : p + "/");
export const isNoise = (path: string, project: string) => (!path.startsWith(project + "/") && TEMP.some(t => path.startsWith(t))) || /\.(log|out|output|pid|lock|swp|tmp)$|\/(\.DS_Store|__pycache__\/.*|node_modules\/.*)$/.test(path)
  || path.startsWith(join(homedir(), ".claude") + "/") && !path.includes("/memory/");

/** Files among `candidates` whose content changed while the command ran. */
export function touchedDuring(candidates: Iterable<string>, start: number, end: number, project: string): { path: string; created: boolean }[] {
  const touched: { path: string; created: boolean }[] = [];
  for (const path of new Set(candidates)) {
    if (path.includes("/.git/") || isNoise(path, project)) continue;
    try {
      const stat = statSync(path);
      if (!stat.isFile() || stat.size > MAX_FILE) continue;
      if (stat.mtimeMs < start - WINDOW_SLACK || stat.mtimeMs > end + WINDOW_SLACK) continue;
      touched.push({ path, created: stat.birthtimeMs >= start - WINDOW_SLACK });
    } catch {}
  }
  return touched;
}

/** The file as committed before `at`, when it is tracked by git. */
export function committedBefore(path: string, at: number): Snapshot | null {
  try {
    const options = { cwd: dirname(path), encoding: "utf8" as const, timeout: 2000, maxBuffer: 4 * MAX_FILE, stdio: ["ignore", "pipe", "ignore"] as ["ignore", "pipe", "ignore"] };
    const commit = execFileSync("git", ["log", "-1", "--format=%H", `--before=@${Math.floor(at / 1000)}`, "--", basename(path)], options).trim();
    if (!commit) return null;
    return fromText(execFileSync("git", ["show", `${commit}:./${basename(path)}`], options));
  } catch { return null; }
}
