// Refuses new mutable module state in the DSL: a top-level `let`, or a collection constructed empty.
// One process evaluates many definitions (the MCP daemon, a test run), so a fact one build leaves
// in module state is read by the next. Carry it on the value instead (`markPanel`,
// `withSongSpan`). State scoped to one build, or keyed by an object one build owns, is listed in
// ALLOWED.
import * as fs from "node:fs";
import * as path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const DSL = path.join(ROOT, "src", "core", "dsl");

const ALLOWED = new Set([
  "clip-length-collect.ts:sink",
  "direction.ts:declarationsByInput",
  "image-input-collect.ts:readers",
  "image-input-collect.ts:seen",
  "image-input-collect.ts:sink",
  "panel-collect.ts:sink",
  "pin-collect.ts:seen",
  "pin-collect.ts:sink",
  "prompt-collect.ts:script",
  "prompt-collect.ts:seen",
  "prompt-collect.ts:sink",
  "respell.ts:sink",
  "shot-context.ts:currentContext",
  "shot-context.ts:currentPatchContext",
  "shot-context.ts:currentPlatePoolContext",
  "shot-context.ts:currentReferenceContext",
  "shot-context.ts:currentTimelineContext",
  "song-context.ts:current",
]);

const STATE =
  /^(?:let (\w+)|(?:export )?const (\w+)(?:: [^=]+)? = new (?:Map|WeakMap|Set|WeakSet)(?:<.*>)?\(\))/;

function listSources(dir: string, out: string[]): void {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== "__tests__") listSources(full, out);
    } else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
      out.push(full);
    }
  }
}

const files: string[] = [];
listSources(DSL, files);

const errors: string[] = [];
for (const file of files.sort()) {
  const lines = fs.readFileSync(file, "utf8").split("\n");
  for (const [i, line] of lines.entries()) {
    const match = STATE.exec(line);
    if (!match) continue;
    const name = match[1] ?? match[2]!;
    if (ALLOWED.has(`${path.relative(DSL, file)}:${name}`)) continue;
    errors.push(`${path.relative(ROOT, file)}:${i + 1}: module state "${name}"`);
  }
}

if (errors.length > 0) {
  for (const message of errors) console.error(`check-module-state: ${message}`);
  console.error(
    "check-module-state: carry the fact on the value it describes (markPanel, withSongSpan), or " +
      "list build-scoped state in ALLOWED in scripts/check-module-state.ts",
  );
  process.exit(1);
}
console.log("check-module-state: ok");
