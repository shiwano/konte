import { existsSync } from "node:fs";
import * as path from "node:path";
import { loadWorkflow, parameterizeWorkflow } from "../comfyui/workflow.js";
import { modelPathSegments } from "../comfyui/model-destination.js";
import { KonteError } from "../core/errors.js";
import { stableStringify } from "../core/stable-stringify.js";
import type {
  ComfyAssetDefinition,
  ComfyModelDeclaration,
  ComfyTarget,
  KonteConfig,
} from "../core/types/index.js";
import { ComfyCloudCatalog } from "./cloud-catalog.js";

export const COMFY_API_KEY_ENV = "COMFY_API_KEY";
const DEFAULT_TARGETS: readonly ComfyTarget[] = ["comfyui", "comfycloud"];

export function comfyApiKey(): string | null {
  const key = process.env[COMFY_API_KEY_ENV] ?? "";
  return key === "" ? null : key;
}

/** The name `comfy.adapters` keys an adapter by: its workflow file without `.json`. */
export function comfyAdapterName(workflow: string): string {
  return workflow.replace(/\.json$/, "");
}

export function deploymentNameOf(target: ComfyTarget): string | null {
  return target.startsWith("comfyapi:") ? target.slice("comfyapi:".length) : null;
}

export function comfyCandidates(adapterName: string, config: KonteConfig): ComfyTarget[] {
  const adapters = config.comfy?.adapters ?? {};
  return [...((adapters[adapterName] ?? adapters["*"] ?? DEFAULT_TARGETS) as ComfyTarget[])];
}

/** An adapter key in `comfy.adapters` that names no workflow under `adapters/comfy/`. */
export function assertComfyAdapterKeys(workspaceRoot: string, config: KonteConfig): void {
  const unknown = Object.keys(config.comfy?.adapters ?? {}).filter(
    (key) =>
      key !== "*" && !existsSync(path.join(workspaceRoot, "adapters", "comfy", `${key}.json`)),
  );
  if (unknown.length > 0) {
    throw new KonteError(
      "VALIDATION_FAILED",
      `comfy.adapters in konte.config.json names ${unknown.map((k) => `"${k}"`).join(", ")}, ` +
        `which no workflow under adapters/comfy/ is called — key an adapter by its workflow file ` +
        `name without .json, or "*" for the default`,
    );
  }
}

export type ComfyRoute =
  | { kind: "routed"; target: ComfyTarget }
  // No candidate can run it; one reason per candidate tried.
  | { kind: "unroutable"; reasons: string[] };

type RouteSubject = {
  workflow: string;
  models: readonly ComfyModelDeclaration[];
  prunedNodes?: readonly string[];
  prunedPassThroughs?: Readonly<Record<string, string>>;
};

/**
 * Picks where each comfy asset runs: the first of its adapter's `comfy.adapters` candidates that
 * can. A route is never part of the definition hash — moving a take to another target does not
 * age it.
 *
 * One router per command; answers are memoized per workflow, pruning and models, which is all a
 * route depends on.
 */
export class ComfyRouter {
  private readonly workspaceRoot: string;
  private readonly config: KonteConfig;
  private catalog: ComfyCloudCatalog | null = null;
  private readonly memo = new Map<string, Promise<ComfyRoute>>();

  constructor(
    workspaceRoot: string,
    config: KonteConfig,
    opts: { catalog?: ComfyCloudCatalog } = {},
  ) {
    this.workspaceRoot = workspaceRoot;
    this.config = config;
    this.catalog = opts.catalog ?? null;
    assertComfyAdapterKeys(workspaceRoot, config);
  }

  static subjectKey(subject: RouteSubject): string {
    return stableStringify({
      workflow: subject.workflow,
      models: subject.models.map(modelPathSegments),
      prunedNodes: [...(subject.prunedNodes ?? [])].sort(),
      prunedPassThroughs: subject.prunedPassThroughs ?? {},
    });
  }

  /** Where this built definition runs. */
  route(def: ComfyAssetDefinition): Promise<ComfyRoute> {
    return this.routeSubject({
      workflow: def.workflow,
      models: def.models ?? [],
      prunedNodes: def.prunedNodes,
      prunedPassThroughs: def.prunedPassThroughs,
    });
  }

  /**
   * Where a whole adapter — every branch, every model — runs, which is what decides whether a
   * deployment's Build carries it.
   */
  routeAdapter(workflow: string, models: readonly ComfyModelDeclaration[]): Promise<ComfyRoute> {
    return this.routeSubject({ workflow, models });
  }

  private routeSubject(subject: RouteSubject): Promise<ComfyRoute> {
    const key = ComfyRouter.subjectKey(subject);
    let route = this.memo.get(key);
    if (!route) {
      route = this.resolve(subject);
      this.memo.set(key, route);
    }
    return route;
  }

  private async resolve(subject: RouteSubject): Promise<ComfyRoute> {
    const reasons: string[] = [];
    for (const target of comfyCandidates(comfyAdapterName(subject.workflow), this.config)) {
      const reason = await this.unusableReason(target, subject);
      if (reason !== null) {
        reasons.push(`${target}: ${reason}`);
        continue;
      }
      return { kind: "routed", target };
    }
    return { kind: "unroutable", reasons };
  }

  private async unusableReason(target: ComfyTarget, subject: RouteSubject): Promise<string | null> {
    if (target === "comfyui") {
      return (this.config.comfy?.comfyui?.url ?? "") === "" ? "comfy.comfyui.url is not set" : null;
    }
    const key = comfyApiKey();
    if (key === null) return `${COMFY_API_KEY_ENV} is not set`;
    if (target !== "comfycloud") return null;
    return this.cloudGap(subject, key);
  }

  // What Comfy Cloud lacks to run this graph, or null when it has everything.
  private async cloudGap(subject: RouteSubject, key: string): Promise<string | null> {
    this.catalog ??= new ComfyCloudCatalog(this.workspaceRoot, key);
    const workflow = await loadWorkflow(
      path.join(this.workspaceRoot, "adapters", "comfy", subject.workflow),
    );
    const pruned = parameterizeWorkflow(
      workflow,
      {},
      0,
      {},
      subject.prunedNodes,
      subject.prunedPassThroughs,
    );
    const classes = await this.catalog.nodeClasses();
    const missingNodes = [...new Set(Object.values(pruned).map((node) => node.class_type))].filter(
      (type) => !classes.has(type),
    );
    const missingModels: string[] = [];
    for (const model of subject.models) {
      const relative = modelPathSegments(model).join("/");
      if (!(await this.catalog.hasModel(relative))) missingModels.push(model.filename);
    }
    const gaps = [
      ...(missingNodes.length > 0 ? [`no node ${missingNodes.join(", ")}`] : []),
      ...(missingModels.length > 0 ? [`no model ${missingModels.join(", ")}`] : []),
    ];
    return gaps.length > 0 ? gaps.join("; ") : null;
  }
}
