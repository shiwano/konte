import * as fs from "node:fs/promises";
import * as path from "node:path";
import { z } from "zod";
import { writeFileAtomic } from "../core/atomic-write.js";
import { KonteError, errorMessage } from "../core/errors.js";
import { COMFY_CLOUD_ORIGIN, readJson, sendIdempotent, toHttpError } from "./http.js";

const CACHE_FILE = path.join(".konte", "comfycloud.json");
const CACHE_TTL_MS = 60 * 60 * 1000;
const ASSET_PAGE_LIMIT = 500;

const CacheSchema = z.object({
  nodes: z
    .object({ fetchedAt: z.number(), classes: z.array(z.string()) })
    .nullable()
    .default(null),
  // `models/<folder>/<filename>` → whether Cloud's index holds it.
  models: z
    .record(z.string(), z.object({ fetchedAt: z.number(), present: z.boolean() }))
    .default({}),
});
type Cache = z.infer<typeof CacheSchema>;

const AssetRowSchema = z
  .object({ name: z.string().optional(), file_path: z.string().nullable().optional() })
  .passthrough();
const AssetPageSchema = z
  .object({ assets: z.array(AssetRowSchema), has_more: z.boolean().optional() })
  .passthrough();

/**
 * What Comfy Cloud has installed: its node classes (`/api/object_info`) and its models
 * (`/api/assets`). Both answers are workspace-wide and kept an hour in `.konte/comfycloud.json`;
 * a stale "present" is caught by Cloud itself, which fails the job on `node_errors`.
 *
 * `object_info`'s COMBO choices lag the model index, so models are never read from there.
 */
export class ComfyCloudCatalog {
  private readonly cachePath: string;
  private readonly apiKey: string;
  private readonly now: () => number;
  private cache: Cache | null = null;
  private nodes: Promise<Set<string>> | null = null;
  private readonly modelLookups = new Map<string, Promise<boolean>>();

  constructor(workspaceRoot: string, apiKey: string, now: () => number = Date.now) {
    this.cachePath = path.join(workspaceRoot, CACHE_FILE);
    this.apiKey = apiKey;
    this.now = now;
  }

  nodeClasses(): Promise<Set<string>> {
    this.nodes ??= this.loadNodeClasses();
    return this.nodes;
  }

  /** Whether Cloud holds `models/<relative>`, e.g. `diffusion_models/x.safetensors`. */
  hasModel(relative: string): Promise<boolean> {
    let lookup = this.modelLookups.get(relative);
    if (!lookup) {
      lookup = this.lookupModel(relative);
      this.modelLookups.set(relative, lookup);
    }
    return lookup;
  }

  private async readCache(): Promise<Cache> {
    if (this.cache) return this.cache;
    try {
      const parsed = CacheSchema.safeParse(JSON.parse(await fs.readFile(this.cachePath, "utf-8")));
      this.cache = parsed.success ? parsed.data : { nodes: null, models: {} };
    } catch {
      this.cache = { nodes: null, models: {} };
    }
    return this.cache;
  }

  // Merged into what is on disk now, so two runs filling different
  // models both keep their answers.
  private async writeCache(update: (cache: Cache) => void): Promise<void> {
    const cache = await this.readCache();
    update(cache);
    try {
      await fs.mkdir(path.dirname(this.cachePath), { recursive: true });
      await writeFileAtomic(this.cachePath, `${JSON.stringify(cache)}\n`);
    } catch {
      // A cache konte cannot write is only a slower next run.
    }
  }

  private fresh(fetchedAt: number): boolean {
    return this.now() - fetchedAt < CACHE_TTL_MS;
  }

  private async loadNodeClasses(): Promise<Set<string>> {
    const cache = await this.readCache();
    if (cache.nodes && this.fresh(cache.nodes.fetchedAt)) return new Set(cache.nodes.classes);

    const what = "Comfy Cloud node index";
    let classes: string[];
    try {
      const res = await sendIdempotent(`${COMFY_CLOUD_ORIGIN}/api/object_info`, {
        auth: { scheme: "x-api-key", key: this.apiKey },
      });
      if (!res.ok) throw await toHttpError(res, what);
      const body = await readJson<unknown>(res, what);
      if (typeof body !== "object" || body === null) {
        throw new KonteError("COMFY_API_ERROR", `${what} is not an object`);
      }
      classes = Object.keys(body);
    } catch (err) {
      throw unavailable(what, err);
    }
    await this.writeCache((c) => {
      c.nodes = { fetchedAt: this.now(), classes };
    });
    return new Set(classes);
  }

  private async lookupModel(relative: string): Promise<boolean> {
    const filePath = `models/${relative}`;
    const cache = await this.readCache();
    const cached = cache.models[filePath];
    if (cached && this.fresh(cached.fetchedAt)) return cached.present;

    const what = "Comfy Cloud model index";
    const filename = relative.slice(relative.lastIndexOf("/") + 1);
    let present = false;
    try {
      for (let offset = 0; ; offset += ASSET_PAGE_LIMIT) {
        const query = new URLSearchParams({
          include_tags: "models",
          name_contains: filename,
          limit: String(ASSET_PAGE_LIMIT),
          offset: String(offset),
        });
        const res = await sendIdempotent(`${COMFY_CLOUD_ORIGIN}/api/assets?${query}`, {
          auth: { scheme: "x-api-key", key: this.apiKey },
        });
        if (!res.ok) throw await toHttpError(res, what);
        const parsed = AssetPageSchema.safeParse(await readJson<unknown>(res, what));
        if (!parsed.success)
          throw new KonteError("COMFY_API_ERROR", `${what} has an unexpected shape`);
        if (parsed.data.assets.some((row) => row.file_path === filePath)) {
          present = true;
          break;
        }
        if (!parsed.data.has_more) break;
      }
    } catch (err) {
      throw unavailable(what, err);
    }
    await this.writeCache((c) => {
      c.models[filePath] = { fetchedAt: this.now(), present };
    });
    return present;
  }
}

function unavailable(what: string, err: unknown): KonteError {
  if (err instanceof KonteError && err.code !== "COMFY_API_ERROR") return err;
  return new KonteError(
    "COMFY_CLOUD_UNAVAILABLE",
    `Could not read ${what}, so whether an adapter runs on comfycloud is unknown: ${errorMessage(err)}`,
  );
}
