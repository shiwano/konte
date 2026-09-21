import { execSync, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  analyzeWorkflow,
  extractHiddenSubgraphInputs,
  generateAdapterCode,
} from "../src/cli/commands/comfy.js";
import { ComfyUIHttpClient } from "../src/comfyui/http-client.js";
import {
  convertLitegraphToApi,
  findUnknownNodeTypes,
  flattenSubgraphs,
  type LitegraphWorkflow,
} from "../src/comfyui/convert.js";
import type { ComfyUIInputSpec, ComfyUINodeDefinition } from "../src/comfyui/types.js";

// Runs every Comfy-Org workflow template through `adapter comfy import`'s pipeline (convert,
// analyze, generate) against a live ComfyUI's /object_info, writing nothing. Each template runs in
// its own process under a timeout, so a hang is reported rather than stalling the run.
//
//   bun run check:comfy-templates [--no-update] [name-substring...]

const ROOT = path.resolve(import.meta.dirname, "..");
// Shared with sync-comfy-adapters, whose sparse checkout is the whole `templates/` directory.
const CLONE_DIR = path.join(ROOT, "vendor/comfy/.clones/github.com/Comfy-Org/workflow_templates");
const GIT_URL = "https://github.com/Comfy-Org/workflow_templates.git";
const TEMPLATES_DIR = path.join(CLONE_DIR, "templates");
const COMFYUI_URL = process.env.COMFYUI_URL ?? "http://127.0.0.1:8000";
const TIMEOUT_MS = 30_000;
const CONCURRENCY = Math.max(1, Math.min(8, os.availableParallelism()));

type Result =
  | { name: string; status: "ok"; outputs: string[] }
  | { name: string; status: "no-output" }
  | { name: string; status: "missing-nodes"; types: string[] }
  | { name: string; status: "not-a-workflow" }
  | { name: string; status: "fail"; stage: string; issues: string[] };

const WIDGET_TYPES = new Set(["INT", "FLOAT", "STRING", "BOOLEAN", "COMBO"]);

const UPLOAD_FLAGS = ["image_upload", "video_upload", "audio_upload", "file_upload"];
const FILENAME_RE = /\.[a-z][a-z0-9]*$/i;

// A combo whose choices are the server's files (models, uploads) or are filled in by the frontend
// lists whatever this ComfyUI happens to hold, so only a fixed choice list is checked.
function isComboValueValid(
  value: unknown,
  options: unknown,
  config: Record<string, unknown>,
): boolean {
  if (!["string", "number", "boolean"].includes(typeof value)) return false;
  if (!Array.isArray(options) || options.length === 0) return true;
  if (UPLOAD_FLAGS.some((flag) => config[flag] === true)) return true;
  if (FILENAME_RE.test(String(value)) || options.some((o) => FILENAME_RE.test(String(o)))) {
    return true;
  }
  return options.includes(value);
}

// A required widget the converted node lacks, or holds a value ComfyUI's validation would reject.
function widgetIssues(
  workflow: Record<string, { class_type: string; inputs: Record<string, unknown> }>,
  objectInfo: Record<string, ComfyUINodeDefinition>,
): string[] {
  const issues = new Set<string>();
  for (const node of Object.values(workflow)) {
    const required = objectInfo[node.class_type]?.input.required ?? {};
    for (const [field, def] of Object.entries(required) as [string, ComfyUIInputSpec][]) {
      const type = def[0];
      const isCombo = Array.isArray(type) || type === "COMBO";
      if (!isCombo && !(typeof type === "string" && WIDGET_TYPES.has(type))) continue;
      const config =
        typeof def[1] === "object" && def[1] !== null ? (def[1] as Record<string, unknown>) : {};
      if (config.forceInput === true) continue;

      const value = node.inputs[field];
      if (Array.isArray(value)) continue;
      const label = `${node.class_type}.${field}`;
      if (value === undefined) {
        issues.add(`${label} missing`);
        continue;
      }
      // ComfyUI's validation casts INT/FLOAT with int()/float(), so a numeric string passes.
      const ok = isCombo
        ? isComboValueValid(value, Array.isArray(type) ? type : config.options, config)
        : type === "INT" || type === "FLOAT"
          ? typeof value === "number" || (typeof value === "string" && !Number.isNaN(Number(value)))
          : type === "BOOLEAN"
            ? typeof value === "boolean"
            : typeof value === "string";
      if (!ok) {
        const shown = Array.isArray(type) ? "COMBO" : type;
        issues.add(`${label}: ${shown} = ${JSON.stringify(value)?.slice(0, 40)}`);
      }
    }
  }
  return [...issues];
}

function checkOne(file: string, objectInfo: Record<string, ComfyUINodeDefinition>): Result {
  const name = path.basename(file, ".json");
  const raw = fs.readFileSync(file, "utf-8");
  const read = () => JSON.parse(raw) as LitegraphWorkflow;
  const data = read();
  if (typeof data !== "object" || data === null || !Array.isArray(data.nodes)) {
    return { name, status: "not-a-workflow" };
  }

  let stage = "flatten";
  try {
    const types = findUnknownNodeTypes(flattenSubgraphs(read()).workflow, objectInfo);
    if (types.length > 0) return { name, status: "missing-nodes", types };

    stage = "convert";
    const converted = convertLitegraphToApi(read(), objectInfo);
    stage = "analyze";
    const analysis = analyzeWorkflow(converted.workflow, converted.subgraphMeta, objectInfo);
    stage = "generate";
    generateAdapterCode(
      name,
      `${name}.json`,
      analysis,
      extractHiddenSubgraphInputs(analysis, converted.subgraphMeta),
      [],
      `./${name}.md`,
    );

    stage = "validate";
    const issues = widgetIssues(converted.workflow, objectInfo);
    if (issues.length > 0) return { name, status: "fail", stage, issues };
    const outputs = Object.values(analysis.outputs).map((o) => o.type);
    return outputs.length > 0 ? { name, status: "ok", outputs } : { name, status: "no-output" };
  } catch (e) {
    const err = e as Error & { code?: string };
    const msg = `${err.code ? `[${err.code}] ` : ""}${err.message.split("\n")[0]}`;
    return { name, status: "fail", stage, issues: [msg] };
  }
}

function runChild(file: string, objectInfoPath: string): Promise<Result> {
  const name = path.basename(file, ".json");
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      [import.meta.filename, "--one", file, "--object-info", objectInfoPath],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => (stdout += d));
    child.stderr.on("data", (d: Buffer) => (stderr += d));
    const timer = setTimeout(() => child.kill("SIGKILL"), TIMEOUT_MS);
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (signal === "SIGKILL") {
        resolve({
          name,
          status: "fail",
          stage: "timeout",
          issues: [`no result in ${TIMEOUT_MS}ms`],
        });
        return;
      }
      try {
        resolve(JSON.parse(stdout) as Result);
      } catch {
        const detail = stderr.trim().split("\n")[0] ?? `exit ${code}`;
        resolve({ name, status: "fail", stage: "crash", issues: [detail] });
      }
    });
  });
}

async function runAll(files: string[], objectInfoPath: string): Promise<Result[]> {
  const results: Result[] = [];
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < files.length) {
      const file = files[next++]!;
      results.push(await runChild(file, objectInfoPath));
      if (process.stdout.isTTY) process.stdout.write(`\r  ${results.length}/${files.length}`);
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  if (process.stdout.isTTY) process.stdout.write("\n");
  return results.sort((a, b) => a.name.localeCompare(b.name));
}

function updateClone(): void {
  if (fs.existsSync(path.join(CLONE_DIR, ".git"))) {
    console.log("Updating Comfy-Org/workflow_templates...");
    execSync(`git -C ${CLONE_DIR} fetch --depth 1 origin`, { stdio: "inherit" });
    execSync(`git -C ${CLONE_DIR} reset --hard origin/HEAD`, { stdio: "inherit" });
  } else {
    console.log("Cloning Comfy-Org/workflow_templates (sparse, shallow)...");
    fs.mkdirSync(path.dirname(CLONE_DIR), { recursive: true });
    execSync(`git clone --depth 1 --filter=blob:none --sparse ${GIT_URL} ${CLONE_DIR}`, {
      stdio: "inherit",
    });
  }
  // sync-comfy-adapters narrows the checkout to the directories its templates live in.
  execSync(`git -C ${CLONE_DIR} sparse-checkout add templates`, { stdio: "inherit" });
}

function report(results: Result[]): boolean {
  const by = <S extends Result["status"]>(status: S) =>
    results.filter((r): r is Extract<Result, { status: S }> => r.status === status);
  const ok = by("ok");
  const noOutput = by("no-output");
  const missing = by("missing-nodes");
  const failed = by("fail");

  console.log(
    `\n${results.length} files: ${ok.length} ok, ${noOutput.length} no output, ` +
      `${missing.length} missing nodes, ${by("not-a-workflow").length} not a workflow, ` +
      `${failed.length} failed`,
  );

  if (missing.length > 0) {
    const counts = new Map<string, number>();
    for (const r of missing) for (const t of r.types) counts.set(t, (counts.get(t) ?? 0) + 1);
    console.log("\nNode types this ComfyUI does not serve (templates using each):");
    for (const [type, n] of [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))) {
      console.log(`  ${String(n).padStart(3)}  ${type}`);
    }
  }

  if (noOutput.length > 0) {
    console.log("\nNo image, video or audio output (import refuses these):");
    console.log(`  ${noOutput.map((r) => r.name).join(", ")}`);
  }

  if (failed.length > 0) {
    console.log("\nFailed:");
    for (const r of failed) {
      console.log(`  ${r.name} (${r.stage})`);
      for (const issue of r.issues) console.log(`    ${issue}`);
    }
  }
  return failed.length === 0;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args[0] === "--one") {
    const objectInfo = JSON.parse(fs.readFileSync(args[3]!, "utf-8"));
    process.stdout.write(JSON.stringify(checkOne(args[1]!, objectInfo)));
    return;
  }

  const noUpdate = args.includes("--no-update");
  const filters = args.filter((a) => !a.startsWith("--"));

  if (!noUpdate) updateClone();
  if (!fs.existsSync(TEMPLATES_DIR)) {
    console.error(`Error: ${TEMPLATES_DIR} does not exist; run without --no-update.`);
    process.exit(1);
  }
  const commit = execSync(`git -C ${CLONE_DIR} log -1 --format="%h %cs"`).toString().trim();

  const client = new ComfyUIHttpClient(COMFYUI_URL);
  if (!(await client.ping())) {
    console.error(`Error: ComfyUI server is not reachable at ${COMFYUI_URL}`);
    process.exit(1);
  }
  const objectInfo = await client.getObjectInfo();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "konte-comfy-templates-"));
  const objectInfoPath = path.join(tmp, "object_info.json");
  fs.writeFileSync(objectInfoPath, JSON.stringify(objectInfo));

  const files = fs
    .readdirSync(TEMPLATES_DIR)
    .filter((f) => f.endsWith(".json"))
    .filter((f) => filters.length === 0 || filters.some((s) => f.includes(s)))
    .sort()
    .map((f) => path.join(TEMPLATES_DIR, f));

  console.log(
    `Checking ${files.length} templates (workflow_templates ${commit}) against ` +
      `${COMFYUI_URL} (${Object.keys(objectInfo).length} node types)...`,
  );
  try {
    const passed = report(await runAll(files, objectInfoPath));
    process.exitCode = passed ? 0 : 1;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

await main();
