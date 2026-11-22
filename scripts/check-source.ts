// Refuses source patterns a refactor removed. Comments are not read. An existing exception is listed
// in the rule's `allowed` by file.
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { parseSync } from "oxc-parser";

const ROOT = path.resolve(import.meta.dirname, "..");

interface Rule {
  name: string;
  pattern: RegExp;
  within: (file: string) => boolean;
  allowed: readonly string[];
  message: string;
}

const anywhere = () => true;
const under = (dir: string) => (file: string) => file.startsWith(dir);

// A primitive whose callers all go through the files listed, its definition included.
function entryPoint(symbol: string, allowed: readonly string[], message: string): Rule {
  return {
    name: `entry-point:${symbol}`,
    pattern: new RegExp(`\\b${symbol}\\b`),
    within: anywhere,
    allowed,
    message,
  };
}

const RULES: readonly Rule[] = [
  {
    name: "bare-error",
    pattern: /\bnew Error\(/,
    within: (file) =>
      !file.startsWith("src/pages/") && !file.startsWith("src/core/dsl/composition/"),
    allowed: [
      "src/core/agent-settings.ts",
      "src/core/assert.ts",
      "src/core/concurrency.ts",
      "src/core/download.ts",
      "src/core/exec-file.ts",
      "src/core/jsx-html.ts",
      "src/core/pending-jobs.ts",
      "src/core/tool-cache.ts",
      "src/core/update-check.ts",
    ],
    message:
      "throw a KonteError with a code; a bare Error reaches the user as LOAD_FAILED or as a bug in konte",
  },
  {
    name: "double-cast",
    pattern: /\bas\s+unknown\s+as\b/,
    within: anywhere,
    allowed: ["src/core/dsl/stage-define.ts", "src/core/web-stream.ts"],
    message:
      "type the value (a `Pick` of what is read, a typed module declaration) or cast once with `as`",
  },
  {
    name: "os-tmpdir",
    pattern: /\btmpdir\(/,
    within: anywhere,
    allowed: ["src/core/exec-file.ts", "src/backends/run-comfy-node-activate-job.ts"],
    message:
      "a write-restricted sandbox writes only the workspace: use makeWorkTmpDir from src/core/exec-file.ts",
  },
  {
    name: "cli-stderr-notice",
    pattern: /\bconsole\.warn\(/,
    within: under("src/cli/commands/"),
    allowed: ["src/cli/commands/job/cancel.ts", "src/cli/commands/review/show.ts"],
    message: "print a notice on stdout beside the lines it explains; refuse with a KonteError",
  },
  {
    name: "ui-em-dash",
    pattern: /—|&mdash;|&#8212;|\\u2014/,
    within: under("src/pages/"),
    allowed: [],
    message: "UI text carries no em dash",
  },
  {
    name: "state-path-literal",
    pattern: /"konte\.state\.json"|"jobs\.db"|"\.konte",\s*"(?:logs|cache|tmp)"/,
    within: anywhere,
    allowed: [
      "src/core/roots.ts",
      "src/core/job-manager.ts",
      "src/core/exec-file.ts",
      "src/core/video-cache.ts",
      "src/worker/worker-log.ts",
      "src/cli/commands/doctor/state.ts",
    ],
    message:
      "name the path through its owner (VIDEO_MARKER, JOBS_DB_FILE, videoCacheDir, makeWorkTmpDir)",
  },
  entryPoint(
    "checkDirection",
    ["src/core/direction.ts", "src/core/checks.ts", "src/core/seam-doc.ts"],
    "check the direction through loadCheckContext / directionCheckOf, so every surface computes the same waiver coverage",
  ),
  entryPoint(
    "assertSpendAllowed",
    ["src/backends/backend-policy.ts", "src/cli/spend-plan.ts"],
    "gate a spend through prepareSpend (src/cli/spend-plan.ts), which also registers prerequisite jobs",
  ),
  entryPoint(
    "saveReviewRecord",
    ["src/core/review-record.ts", "src/cli/commands/preview/review-shared.ts"],
    "save a review through persistReview (src/cli/commands/preview/review-shared.ts)",
  ),
  entryPoint(
    "commitAccept",
    [
      "src/core/accept-commit.ts",
      "src/cli/commands/asset-ops/accept.ts",
      "src/cli/commands/preview/review-shared.ts",
      "src/cli/commands/preview/reel-submit.ts",
    ],
    "accept through applyAccept (CLI) or applyAddressReview / the reel submit (review)",
  ),
  entryPoint(
    "fetchWithRetry",
    [
      "src/core/http-retry.ts",
      "src/core/download.ts",
      "src/core/clip-download.ts",
      "src/core/update-check.ts",
      "src/backends/http-util.ts",
      "src/comfyui/http-client.ts",
      "src/fal/http-client.ts",
      "src/comfy-api/http.ts",
      "src/comfy-api/build-definition.ts",
    ],
    "send through the vendor's client (ComfyUIHttpClient, the fal client, src/comfy-api/http.ts), which maps a 401 and applies the timeout",
  ),
];

const SOURCE = /\.tsx?$/;
const SKIPPED = [
  /\/__tests__\//,
  /\.test\.tsx?$/,
  /\.d\.ts$/,
  /^src\/cli\/templates\//,
  /\/generated\//,
];

const files = execFileSync(
  "git",
  ["ls-files", "-z", "--cached", "--others", "--exclude-standard", "src"],
  {
    cwd: ROOT,
    encoding: "utf8",
  },
)
  .split("\0")
  .filter((file) => SOURCE.test(file) && !SKIPPED.some((skip) => skip.test(file)))
  .filter((file) => fs.existsSync(path.join(ROOT, file)));

for (const rule of RULES) {
  for (const file of rule.allowed) {
    if (!files.includes(file)) {
      console.error(
        `check-source: ${rule.name} allows ${file}, which is not a checked source file`,
      );
      process.exit(1);
    }
  }
}

// The text with every comment blanked, newlines kept.
function withoutComments(file: string, text: string): string {
  const { comments } = parseSync(file, text);
  let out = "";
  let at = 0;
  for (const comment of comments) {
    out +=
      text.slice(at, comment.start) + text.slice(comment.start, comment.end).replace(/[^\n]/g, " ");
    at = comment.end;
  }
  return out + text.slice(at);
}

const errors: string[] = [];
const unused = new Map(RULES.map((rule) => [rule, new Set(rule.allowed)]));
for (const file of files) {
  const rules = RULES.filter((rule) => rule.within(file));
  if (rules.length === 0) continue;
  const text = withoutComments(file, fs.readFileSync(path.join(ROOT, file), "utf8"));
  for (const rule of rules) {
    const hits = [...text.matchAll(new RegExp(rule.pattern.source, "g"))].map(
      (match) => text.slice(0, match.index).split("\n").length,
    );
    if (hits.length === 0) continue;
    if (rule.allowed.includes(file)) {
      unused.get(rule)!.delete(file);
      continue;
    }
    for (const line of hits) errors.push(`${file}:${line}: ${rule.name}: ${rule.message}`);
  }
}
for (const [rule, files] of unused) {
  for (const file of files) {
    errors.push(`${file}: ${rule.name} no longer occurs; remove it from the rule's allowed list`);
  }
}

if (errors.length > 0) {
  for (const error of errors) console.error(`check-source: ${error}`);
  process.exit(1);
}
console.log("check-source: ok");
