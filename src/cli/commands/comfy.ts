import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { Command } from "commander";
import { resolveComfyUIConfig } from "../../comfyui/config.js";
import {
  convertLitegraphToApi,
  templateModels,
  type LitegraphWorkflow,
  type SubgraphMeta,
  type TemplateModel,
} from "../../comfyui/convert.js";
import { ComfyUIHttpClient } from "../../comfyui/http-client.js";
import { ComfyUIManagerClient } from "../../comfyui/manager-client.js";
import type { ComfyUINodeDefinition } from "../../comfyui/types.js";
import { comfyGuideScaffold, generateAdapterCode } from "../../comfyui/adapter-codegen.js";
import {
  analyzeWorkflow,
  attachTemplateModels,
  collectClassTypes,
  extractHiddenSubgraphInputs,
  isLitegraphFormat,
  OUTPUT_NODE_CLASSES,
  pruneUnreachableNodes,
} from "../../comfyui/workflow-analyze.js";
import { KonteError } from "../../core/errors.js";
import { requireWorkspaceRoot } from "../context.js";
import { declareScope } from "../scope.js";
import { pathExists } from "../template-files.js";
import { registerComfyBuildCommand } from "./comfy-build.js";

// Fail fast when probing an unreachable ComfyUI instead of waiting out the
// client's default request timeout.
const COMFYUI_PING_TIMEOUT_MS = 5_000;

export function registerComfyCommand(program: Command): void {
  const comfy = program
    .command("comfy")
    .description("Manage ComfyUI adapters and their Comfy API deployments");
  registerComfyBuildCommand(comfy);

  const importCmd = comfy
    .command("import <source>")
    .description("Import a ComfyUI workflow and generate an adapter")
    .option("--name <name>", "Name for the workflow adapter")
    .option("--no-adapter", "Skip adapter generation")
    .action(async (source: string, opts: { name?: string; adapter: boolean }) => {
      const workspaceRoot = requireWorkspaceRoot();
      const sourcePath = path.resolve(source);

      // `--name` becomes the adapter's filename (adapters/comfy/<name>.{json,ts}); reject
      // anything that isn't a single path segment so it can't escape the adapters dir.
      if (
        opts.name !== undefined &&
        (opts.name.length === 0 ||
          opts.name.includes("/") ||
          opts.name.includes("\\") ||
          opts.name !== path.basename(opts.name) ||
          opts.name === "." ||
          opts.name === "..")
      ) {
        throw new KonteError(
          "WORKFLOW_IMPORT_FAILED",
          `Invalid --name "${opts.name}": must be a plain filename with no path separators`,
        );
      }

      let rawJson: string;
      try {
        rawJson = await fs.readFile(sourcePath, "utf-8");
      } catch {
        throw new KonteError("WORKFLOW_IMPORT_FAILED", `Cannot read source file: ${sourcePath}`);
      }

      let data: unknown;
      try {
        data = JSON.parse(rawJson);
      } catch {
        throw new KonteError(
          "WORKFLOW_IMPORT_FAILED",
          `Invalid JSON in source file: ${sourcePath}`,
        );
      }

      // A native ComfyUI workflow is in litegraph format and must be converted to
      // API format (which needs `/object_info` from a running server) before the
      // backend can run it. An already-API-format file is used as-is, offline —
      // but it carries no subgraph metadata, so it gets no hidden-input hints.
      let apiWorkflow: unknown;
      let workflowJson: string;
      let subgraphMeta: SubgraphMeta | null = null;
      // cnr_ids of the custom node packs this workflow uses, scaffolded (commented-out) into
      // the adapter. Only resolvable on the litegraph path, where ComfyUI (and its Manager)
      // are reachable; best-effort, so a Manager that lacks the mapping API just yields none.
      let nodePacks: string[] = [];
      // An `object_info`-declared combo's choices live only on the server, absent from the
      // workflow JSON — so they're only recoverable on the litegraph path, where the server
      // is reachable. (A `JsonExtractString`-selected enum is the exception: those choices
      // are in the workflow JSON, so `analyzeWorkflow` recovers them on either path.)
      let objectInfo: Record<string, ComfyUINodeDefinition> | undefined;
      let modelSources = new Map<string, TemplateModel>();

      if (isLitegraphFormat(data)) {
        const config = await resolveComfyUIConfig(workspaceRoot);
        const client = new ComfyUIHttpClient(config.baseUrl, { headers: config.headers });
        if (!(await client.ping(COMFYUI_PING_TIMEOUT_MS))) {
          throw new KonteError(
            "WORKFLOW_IMPORT_FAILED",
            `Cannot reach ComfyUI at ${config.baseUrl} to convert the litegraph workflow. ` +
              `Start ComfyUI and run \`konte doctor\` to verify the connection, or export the ` +
              `workflow as API format (Save (API Format) in ComfyUI) and import that instead.`,
          );
        }
        objectInfo = await client.getObjectInfo();
        const converted = convertLitegraphToApi(data as LitegraphWorkflow, objectInfo);
        apiWorkflow = converted.workflow;
        subgraphMeta = converted.subgraphMeta;
        modelSources = templateModels(data as LitegraphWorkflow);
        workflowJson = `${JSON.stringify(converted.workflow, null, 2)}\n`;

        try {
          const managerClient = new ComfyUIManagerClient(config.baseUrl, client);
          const classToPack = await managerClient.resolveClassToPack(
            collectClassTypes(converted.workflow, objectInfo),
          );
          nodePacks = [...new Set(classToPack.values())].sort();
        } catch {
          // Manager unavailable or no mapping API — skip the nodes scaffold (best-effort).
        }
      } else {
        apiWorkflow = data;
        workflowJson = rawJson;
      }

      const pruned = pruneUnreachableNodes(apiWorkflow, objectInfo);
      if (pruned !== apiWorkflow) {
        apiWorkflow = pruned;
        workflowJson = `${JSON.stringify(pruned, null, 2)}\n`;
      }

      const analysis = opts.adapter
        ? analyzeWorkflow(apiWorkflow, subgraphMeta ?? undefined, objectInfo)
        : undefined;
      if (analysis) attachTemplateModels(analysis.models, modelSources);
      if (analysis && Object.keys(analysis.outputs).length === 0) {
        throw new KonteError(
          "WORKFLOW_IMPORT_FAILED",
          `No image, video or audio output node found in ${sourcePath}. ` +
            `Recognized output nodes: ${OUTPUT_NODE_CLASSES.join(", ")}.`,
        );
      }

      const baseName = opts.name ?? path.basename(source, ".json");
      const adapterDir = path.join(workspaceRoot, "adapters", "comfy");
      await fs.mkdir(adapterDir, { recursive: true });

      const workflowDest = path.join(adapterDir, `${baseName}.json`);
      await fs.writeFile(workflowDest, workflowJson, "utf-8");
      console.log(`Workflow saved: adapters/comfy/${baseName}.json`);

      if (!analysis) {
        return;
      }

      const hiddenInputs = subgraphMeta ? extractHiddenSubgraphInputs(analysis, subgraphMeta) : {};
      const guideFile = `${baseName}.md`;
      const adapterCode = generateAdapterCode(
        baseName,
        `${baseName}.json`,
        analysis,
        hiddenInputs,
        nodePacks,
        `./${guideFile}`,
      );

      const adapterPath = path.join(adapterDir, `${baseName}.ts`);
      await fs.writeFile(adapterPath, adapterCode, "utf-8");
      console.log(`Adapter generated: adapters/comfy/${baseName}.ts`);

      // A TODO the author fills (like the description marker). Never clobber a hand-written one.
      const guidePath = path.join(adapterDir, guideFile);
      if (!(await pathExists(guidePath))) {
        await fs.writeFile(guidePath, comfyGuideScaffold(baseName), "utf-8");
        console.log(`Guide scaffolded: adapters/comfy/${guideFile}`);
      }
    });

  // Adapters are workspace-wide, shared by every video. The type-check is skipped because the
  // adapter this command is about to write is exactly what would make it pass.
  declareScope(importCmd, { scope: "workspace", skipTypeCheck: true });
}
