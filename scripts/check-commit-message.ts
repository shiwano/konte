// Checks a commit message against AGENTS.md's Commits section, from one of three sources:
//   --file <path>    the message git hands the commit-msg hook
//   --range <range>  every commit in a revision range
//   --pull-request   PR_TITLE / PR_BODY, the message a squash merge writes
import * as fs from "node:fs";
import { spawnSync } from "node:child_process";
import { checkCommitMessage, stripGitComments } from "./lib/commit-message.js";

const errors: string[] = [];

function git(...args: string[]): string | null {
  const result = spawnSync("git", args, { encoding: "utf8" });
  return result.status === 0 ? result.stdout : null;
}

function versionAt(revision: string): string | undefined {
  const text = git("show", `${revision}:package.json`);
  if (text === null) return undefined;
  try {
    const version = (JSON.parse(text) as { version?: unknown }).version;
    return typeof version === "string" ? version : undefined;
  } catch {
    return undefined;
  }
}

// `at` is the tree the commit holds, `before` the one it builds on.
function check(label: string, message: string, at: string, before: string): void {
  const options = { version: versionAt(at), previousVersion: versionAt(before) };
  for (const error of checkCommitMessage(message, options)) {
    errors.push(label === "" ? error : `${label}: ${error}`);
  }
}

const [mode, value] = process.argv.slice(2);
if (mode === "--file" && value !== undefined) {
  check("", stripGitComments(fs.readFileSync(value, "utf8")), "", "HEAD");
} else if (mode === "--range" && value !== undefined) {
  const revisions = git("log", "--format=%H", value);
  if (revisions === null) {
    console.error(`check-commit-message: cannot read the range ${value}`);
    process.exit(1);
  }
  for (const revision of revisions.split("\n").filter(Boolean)) {
    const message = git("show", "-s", "--format=%B", revision) ?? "";
    check(revision.slice(0, 7), message, revision, `${revision}^`);
  }
} else if (mode === "--pull-request") {
  const title = process.env.PR_TITLE ?? "";
  const body = (process.env.PR_BODY ?? "").trim();
  // The checkout is the pull request merged into its base, so the base is HEAD^1.
  check("", body === "" ? title : `${title}\n\n${body}`, "HEAD", "HEAD^1");
} else {
  console.error("usage: check-commit-message (--file <path> | --range <range> | --pull-request)");
  process.exit(2);
}

if (errors.length > 0) {
  for (const message of errors) console.error(`check-commit-message: ${message}`);
  console.error("check-commit-message: the format is AGENTS.md's Commits section");
  process.exit(1);
}
console.log("check-commit-message: ok");
