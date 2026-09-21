import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { workspaceDir } from "./lib/template-dirs.js";
import { GUIDE_SPECIFIER_PREFIX } from "../src/core/dsl/adapter.js";

// A `guide` names a file `adapter show` resolves at run time, so nothing type-checks it. The
// bundled adapters take the konte-managed form only.
const GUIDE_FIELD_RE = /^\s*guide: (?:"([^"]+)"|\[([^\]]*)\]),$/gm;
const GUIDE_KEY_RE = /^\s*guide:/m;

function guideSpecifiers(source: string): string[] {
  const specifiers: string[] = [];
  for (const match of source.matchAll(GUIDE_FIELD_RE)) {
    if (match[1] !== undefined) specifiers.push(match[1]);
    else for (const item of (match[2] ?? "").matchAll(/"([^"]+)"/g)) specifiers.push(item[1] ?? "");
  }
  return specifiers;
}

function listAdapterSources(dir: string): string[] {
  const files: string[] = [];
  for (const entry of fs
    .readdirSync(dir, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name))) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...listAdapterSources(full));
    else if (entry.name.endsWith(".ts")) files.push(full);
  }
  return files;
}

function checkBundledGuides(): string[] {
  const adapterDir = path.join(workspaceDir, "adapters");
  const guideDir = path.join(workspaceDir, "dot.konte/guides");
  const problems: string[] = [];
  for (const file of listAdapterSources(adapterDir)) {
    const entry = path.relative(adapterDir, file);
    const source = fs.readFileSync(file, "utf-8");
    const specifiers = guideSpecifiers(source);
    if (specifiers.length === 0 && GUIDE_KEY_RE.test(source)) {
      problems.push(`${entry}: a \`guide\` field this check cannot read`);
      continue;
    }
    for (const specifier of specifiers) {
      if (!specifier.startsWith(GUIDE_SPECIFIER_PREFIX)) {
        problems.push(`${entry}: guide "${specifier}" must start with ${GUIDE_SPECIFIER_PREFIX}`);
        continue;
      }
      const guideFile = specifier.slice(GUIDE_SPECIFIER_PREFIX.length);
      if (!fs.existsSync(path.join(guideDir, guideFile))) {
        problems.push(
          `${entry}: guide "${specifier}" has no file at dot.konte/guides/${guideFile}`,
        );
      }
    }
  }
  return problems;
}

process.stdout.write("Checking bundled adapter guides...\n");
const guideProblems = checkBundledGuides();
if (guideProblems.length > 0) {
  for (const problem of guideProblems) {
    process.stderr.write(`  ${problem}\n`);
  }
  process.stderr.write("Guide check failed.\n");
  process.exit(1);
}

// One project, one pass: the workspace tsconfig includes the shared adapters and every video
// template under videos/, so this type-checks all of them together — the same way a real
// workspace is checked, and stricter than checking each video against the base in isolation.
const tsc = path.resolve(import.meta.dirname, "../node_modules/.bin/tsc");

process.stdout.write("Type-checking the workspace template...\n");
try {
  execFileSync(tsc, ["--project", path.join(workspaceDir, "tsconfig.json")], { stdio: "inherit" });
} catch {
  process.stderr.write("Template type-check failed.\n");
  process.exit(1);
}
process.stdout.write("Templates type-checked.\n");
