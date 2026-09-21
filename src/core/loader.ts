import { type Dirent, existsSync, readdirSync } from "node:fs";
import * as fs from "node:fs/promises";
import { createRequire } from "node:module";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as jsxRuntime from "react/jsx-runtime";
import * as jsxDevRuntime from "react/jsx-dev-runtime";
import {
  formatPatchAssetPath,
  listAssetPaths,
  listReferenceAssetPaths,
  parseAddress,
  patchSourceVariantIdOf,
} from "./address.js";
import type { Direction } from "./dsl/direction.js";
import * as dsl from "./dsl/index.js";
import type { PatchBuild, PatchBuildContext, PatchDefinition } from "./dsl/patch.js";
import { KonteError, errorMessage } from "./errors.js";
import { extractRefs } from "./graph.js";
import { STAGE_ENTRY_FILE, WORKSPACE_MARKER, stageEntryPath } from "./roots.js";
import { type Handoff, HandoffSchema } from "./types/handoff.js";
import {
  type AssetDefinition,
  AssetDefinitionSchema,
  type ReferenceDefinition,
  ReferenceDefinitionSchema,
  type AnimaticDefinition,
  AnimaticDefinitionSchema,
  type VideoDefinition,
  VideoDefinitionSchema,
} from "./types/index.js";

// A user file reaches anything under the workspace root with a `konte/workspace/<path>` specifier, so
// `konte/workspace/adapters/comfy/x.js` is `<root>/adapters/comfy/x.ts` however deep the importer sits
// (versus a `../../adapters/…` relative path). tsconfig `paths` maps it for the type-checker; resolve
// it here for the runtime, walking up from the importer to the workspace root (konte.config.json) and
// joining the remainder — `.js` is mapped to the `.ts` on disk, and an already-exact path (a non-source
// asset) is passed through. Returns null when no workspace root is found or nothing matches.
//
// The spelling is forced by what a COMPILED binary can resolve, and both halves are load-bearing:
//   - `konte/…`: a standalone binary applies neither the workspace's tsconfig `paths` nor its
//     package.json `imports`, so the alias only survives as a plugin shim — and onResolve is consulted
//     only for subpaths of a namespace registered via builder.module() (`konte`, just above). A bare
//     prefix (`@/…`, `#…`, `adapters/…`) never reaches this function in a binary; it resolves under
//     `bun run` purely via the workspace tsconfig, which is why dev is not evidence here.
//   - the extension: onResolve does not fire for an extensionless subpath either, so an import through
//     this alias MUST carry one.
const WORKSPACE_ALIAS_PREFIX = "konte/workspace/";
const WORKSPACE_ALIAS_EXTS = [".ts", ".tsx", ".js", ".jsx"];

function findWorkspaceRootSync(from: string): string | null {
  let dir = path.resolve(from);
  for (;;) {
    if (existsSync(path.join(dir, WORKSPACE_MARKER))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function resolveWorkspaceAlias(specifier: string, importer: string | undefined): string | null {
  const rest = specifier.slice(WORKSPACE_ALIAS_PREFIX.length);
  const from = importer
    ? path.dirname(importer.startsWith("file:") ? fileURLToPath(importer) : importer)
    : process.cwd();
  const workspaceRoot = findWorkspaceRootSync(from);
  if (!workspaceRoot) return null;
  const joined = path.join(workspaceRoot, rest);
  const base = joined.replace(/\.[jt]sx?$/, "");
  for (const ext of WORKSPACE_ALIAS_EXTS) {
    if (existsSync(base + ext)) return base + ext;
  }
  return existsSync(joined) ? joined : null;
}

// User project files have no node_modules; Bun's runtime transpiler injects
// react/jsx-(dev-)runtime imports for their JSX. Resolve those to konte's bundled React.
if (typeof Bun !== "undefined") {
  Bun.plugin({
    name: "konte-module",
    setup(builder) {
      builder.module("konte", () => ({
        exports: dsl,
        loader: "object",
      }));
      builder.module("react/jsx-runtime", () => ({
        exports: jsxRuntime,
        loader: "object",
      }));
      builder.module("react/jsx-dev-runtime", () => ({
        exports: jsxDevRuntime,
        loader: "object",
      }));
      builder.onResolve({ filter: /^konte\/workspace\// }, (args) => {
        const resolved = resolveWorkspaceAlias(args.path, args.importer);
        return resolved ? { path: resolved } : undefined;
      });
    },
  });
}

function withTrailingSep(p: string): string {
  return p.endsWith(path.sep) ? p : p + path.sep;
}

// `import()` resolves its argument as a URL, not a path: a POSIX absolute path happens to resolve,
// but a Windows one ("C:\…") parses as a URL scheme and throws ERR_UNSUPPORTED_ESM_URL_SCHEME. Every
// dynamic import of an on-disk user module goes through here. Bun keys its module registry by
// absolute path either way, so bustProjectModuleCache is unaffected.
export async function importModule(filePath: string): Promise<Record<string, unknown>> {
  return (await import(pathToFileURL(filePath).href)) as Record<string, unknown>;
}

// konte's own runtime lives under this directory. Never evict it, react, or builtins: user modules
// `import "konte"`, and re-evaluating the dsl would hand them a different singleton instance, so
// placeholder/identity checks would silently break. Resolved from the standard import.meta.url
// (import.meta.dir is Bun-only and absent under the test bundler); null when it can't be determined,
// which makes bustProjectModuleCache fall back to clearing only the project roots.
//
// Two layouts have to come out right, and only one of them is on disk:
//   - dev / test: this file is `<root>/src/core/loader.ts`, so "../.." is the checkout, carrying a
//     package.json.
//   - a compiled binary: konte is bundled under a virtual root and this file is `/$bunfs/root/konte`,
//     whose "../.." is the FILESYSTEM ROOT — a prefix every absolute path starts with, which would
//     protect the entire disk from eviction and pin every workspace adapter for the process's life.
//     The bundle's own directory is the right guard there, and it is what the registry keys use.
// A candidate with no parent is never taken — it protects everything, so whatever a stray
// `/package.json` on the host says, the filesystem root is not konte's package.
export function resolveKontePackageRoot(
  moduleUrl: string | undefined,
  isPackageDir: (dir: string) => boolean = (dir) => existsSync(path.join(dir, "package.json")),
): string | null {
  try {
    if (!moduleUrl) return null;
    const moduleDir = path.dirname(fileURLToPath(moduleUrl));
    const packageRoot = path.resolve(moduleDir, "../..");
    const root =
      path.dirname(packageRoot) !== packageRoot && isPackageDir(packageRoot)
        ? packageRoot
        : moduleDir;
    if (path.dirname(root) === root) return null;
    return withTrailingSep(root);
  } catch {
    return null;
  }
}

const KONTE_PACKAGE_ROOT: string | null = resolveKontePackageRoot(import.meta.url);

// The roots a reload must re-read: the video's own files (the definition entries) and the
// workspace's — `adapters/**` sits there, one level above the video root, and every definition
// imports it through `konte/workspace/…`.
export function projectRootPrefixes(videoRoot: string): string[] {
  const workspaceRoot = findWorkspaceRootSync(videoRoot);
  return workspaceRoot && workspaceRoot !== videoRoot
    ? [withTrailingSep(videoRoot), withTrailingSep(workspaceRoot)]
    : [withTrailingSep(videoRoot)];
}

// Whether a module registry key names a user file a reload must re-evaluate.
export function isProjectModule(
  filePath: string,
  projectPrefixes: readonly string[],
  kontePackageRoot: string | null,
): boolean {
  // Bare/builtin/object specifiers (`konte`, `react/jsx-runtime`, `node:*`) and dependencies are
  // never user code — leave them resolved.
  if (!path.isAbsolute(filePath) || filePath.includes(`${path.sep}node_modules${path.sep}`)) {
    return false;
  }
  // Workspace and video files always (this also covers a project nested under konte's own tree).
  if (projectPrefixes.some((prefix) => filePath.startsWith(prefix))) return true;
  // Anything else on disk is treated as user code too — e.g. a shared adapter imported from
  // outside the workspace — except konte's own runtime. If konte's root is unknown, stay
  // conservative and evict only the project roots.
  return kontePackageRoot !== null && !filePath.startsWith(kontePackageRoot);
}

// Bun keys its module cache by absolute file path, and a static `import "./reference"` inside a
// re-imported video.tsx is served from that cache — so re-importing the entry file alone (even
// with a fresh `?t=` query) does NOT pick up edits to transitively-imported files (reference.tsx,
// animatic.tsx, adapters, and shared modules a project imports from outside its own root). In a
// long-lived process (the MCP watcher) this renders edited definitions against a stale upstream —
// an asset added to reference.tsx "not found in definition", an edited adapter still hashing to
// the definition it had at daemon start.
// Evict every on-disk user module before a reload so the whole graph re-evaluates fresh on the next
// import; keep konte/react/node_modules so the dsl singleton and resolver stay intact.
//
// The cache is `require.cache`: deleting a key evicts the module at that path, ES modules included.
// Bun 1.4 removed the `Loader.registry` global this used to reach for, and an eviction that quietly
// found nothing turned every reload into the first load for the life of the daemon;
// loader-reload.test.ts runs the reload on the real Bun so a change like that fails there.
//
// Listing the cache is not enough to find what to delete: it names only modules that finished
// evaluating, and a module that failed to parse, link or evaluate stays registered with its error —
// every later import of it, or of anything importing it, fails the same way after the file is
// fixed. So the source files under the project roots are deleted by path whether listed or not,
// along with every key a previous reload saw (a shared module outside the roots that later broke).
const moduleCache: Record<string, unknown> = createRequire(import.meta.url).cache;

const SOURCE_FILE = /\.[cm]?[jt]sx?$/;
// Directories under a project root that hold no module a definition imports: dependencies, dot
// directories (`.git`, `.konte`), and a video's generated media.
const NON_SOURCE_DIRS = new Set(["node_modules", "assets", "dist", "review"]);

function listSourceFiles(dir: string, out: string[]): void {
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (entry.name.startsWith(".") || NON_SOURCE_DIRS.has(entry.name)) continue;
      listSourceFiles(path.join(dir, entry.name), out);
    } else if (SOURCE_FILE.test(entry.name)) {
      out.push(path.join(dir, entry.name));
    }
  }
}

const seenProjectModules = new Set<string>();

function bustProjectModuleCache(videoRoot: string): void {
  const prefixes = projectRootPrefixes(videoRoot);
  for (const key of Object.keys(moduleCache)) {
    if (isProjectModule(key.split("?")[0]!, prefixes, KONTE_PACKAGE_ROOT))
      seenProjectModules.add(key);
  }
  const onDisk: string[] = [];
  // A root inside another is walked as part of the outer one.
  for (const prefix of prefixes) {
    if (prefixes.some((other) => other !== prefix && prefix.startsWith(other))) continue;
    listSourceFiles(prefix, onDisk);
  }
  for (const key of new Set([...seenProjectModules, ...onDisk])) delete moduleCache[key];
}

let reloadLock: Promise<unknown> = Promise.resolve();

// Evict the project's stale modules, then re-import `filePath` — serialized process-wide.
// bustProjectModuleCache mutates the shared module registry, so two reloads in flight at once (e.g.
// video + animatic via Promise.all in the export worker) let one's eviction delete modules the
// other is mid-instantiation, and Bun throws "Requested module is not instantiated yet". Chaining
// keeps each evict+import atomic; a rejection never wedges the chain.
export function reloadFreshModule(filePath: string): Promise<Record<string, unknown>> {
  return underReloadLock(async () => {
    bustProjectModuleCache(path.dirname(filePath));
    return await importModule(filePath);
  });
}

function underReloadLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = reloadLock.then(fn);
  reloadLock = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

// `read` the file when it exists; null when it is absent. An existing but unloadable file throws —
// a validation error must never be swallowed as absence.
export async function loadIfPresent<T>(
  file: string,
  read: (file: string) => Promise<T>,
): Promise<T | null> {
  try {
    await fs.access(file);
  } catch {
    return null;
  }
  return read(file);
}

// Import a definition entry (fresh — evicting the project's modules first — or from the registry)
// and hand the module to its parser; a failed import is a LOAD_FAILED naming the file.
async function importDefinition<T>(
  filePath: string,
  label: string,
  fresh: boolean,
  parse: (mod: Record<string, unknown>, filePath: string) => T | Promise<T>,
): Promise<T> {
  let mod: Record<string, unknown>;
  try {
    mod = fresh ? await reloadFreshModule(filePath) : await importModule(filePath);
  } catch (err) {
    // Bun keeps the record of a module that threw during evaluation, and a SECOND import of it
    // RESOLVES — handing back a namespace whose bindings never initialized instead of re-throwing.
    // Every later load in the process then reports "Cannot access 'default' before initialization"
    // over whatever the definition actually said, and one swallowed first load is enough to set
    // that up (`loadIfPresent`, the read paths that `.catch(() => null)` a broken stage). The file
    // that threw poisons its importers too, so evict the whole project subtree: the next load
    // re-evaluates and says it again.
    await underReloadLock(async () => bustProjectModuleCache(path.dirname(filePath)));
    throw new KonteError(
      "LOAD_FAILED",
      `Failed to ${fresh ? "reload" : "load"} ${label} file "${filePath}": ${errorMessage(err)}`,
    );
  }
  return parse(mod, filePath);
}

// The default export of a stage entry, validated against its schema.
function parseDefaultExport<T>(
  mod: Record<string, unknown>,
  filePath: string,
  label: string,
  schema: {
    safeParse: (v: unknown) => { success: true; data: T } | { success: false; error: Error };
  },
): T {
  if (!("default" in mod)) {
    throw new KonteError("LOAD_FAILED", `${label} file "${filePath}" has no default export`);
  }
  const result = schema.safeParse(mod.default);
  if (!result.success) {
    throw new KonteError(
      "VALIDATION_FAILED",
      `${label} definition validation failed: ${result.error.message}`,
    );
  }
  return result.data;
}

function assertUnique(values: Iterable<string>, what: string, label: string): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) {
      throw new KonteError(
        "VALIDATION_FAILED",
        `Duplicate ${what} "${value}" in ${label.toLowerCase()} definition`,
      );
    }
    seen.add(value);
  }
}

function parseVideoModule(mod: Record<string, unknown>, filePath: string): VideoDefinition {
  const video = parseDefaultExport(mod, filePath, "Video", VideoDefinitionSchema);
  assertUnique(
    video.shots.map((s) => s.id),
    "shot ID",
    "Video",
  );
  assertUnique(listAssetPaths(video, "video"), "asset path", "Video");
  return video;
}

export async function reloadVideoDefinition(filePath: string): Promise<VideoDefinition> {
  return importDefinition(filePath, "video", true, parseVideoModule);
}

function parseReferenceModule(mod: Record<string, unknown>, filePath: string): ReferenceDefinition {
  const parsed = parseDefaultExport(mod, filePath, "Reference", ReferenceDefinitionSchema);
  const reference: ReferenceDefinition = {
    shots: [],
    topLevelAssets: parsed.topLevelAssets,
    exposedAssetNames: parsed.exposedAssetNames,
    prompts: parsed.prompts,
    waivers: parsed.waivers,
  };
  assertUnique(listReferenceAssetPaths(reference), "asset path", "Reference");
  return reference;
}

export async function loadReferenceDefinition(filePath: string): Promise<ReferenceDefinition> {
  return importDefinition(filePath, "reference", false, parseReferenceEntry);
}

function parseReferenceEntry(mod: Record<string, unknown>, filePath: string): ReferenceDefinition {
  return parseReferenceModule(mod, filePath);
}

export async function reloadReferenceDefinition(filePath: string): Promise<ReferenceDefinition> {
  return importDefinition(filePath, "reference", true, parseReferenceEntry);
}

// reference.tsx is a required entry. Absent file => REFERENCE_NOT_FOUND; an existing but invalid
// file throws its own validation error.
export async function loadReference(
  videoRoot: string,
  opts?: { reload?: boolean },
): Promise<ReferenceDefinition> {
  const filePath = stageEntryPath(videoRoot, "reference");
  if (!existsSync(filePath)) {
    throw new KonteError(
      "REFERENCE_NOT_FOUND",
      `No ${STAGE_ENTRY_FILE.reference} found in the video root — every video holds a shared pool. ` +
        `Create it with \`defineReference(direction, () => ({}))\`.`,
    );
  }
  return opts?.reload ? reloadReferenceDefinition(filePath) : loadReferenceDefinition(filePath);
}

function parseAnimaticModule(mod: Record<string, unknown>, filePath: string): AnimaticDefinition {
  const animatic = parseDefaultExport(mod, filePath, "Animatic", AnimaticDefinitionSchema);
  assertUnique(
    animatic.shots.map((s) => s.id),
    "shot ID",
    "Animatic",
  );
  assertUnique(listAssetPaths(animatic, "animatic"), "asset path", "Animatic");
  return animatic;
}

export async function loadAnimaticDefinition(filePath: string): Promise<AnimaticDefinition> {
  return importDefinition(filePath, "animatic", false, parseAnimaticModule);
}

export async function reloadAnimaticDefinition(filePath: string): Promise<AnimaticDefinition> {
  return importDefinition(filePath, "animatic", true, parseAnimaticModule);
}

// animatic.tsx is a required entry. Absent file => ANIMATIC_NOT_FOUND; an existing but invalid file
// throws its own validation error.
export async function loadAnimatic(
  videoRoot: string,
  opts?: { reload?: boolean },
): Promise<AnimaticDefinition> {
  const filePath = stageEntryPath(videoRoot, "animatic");
  if (!existsSync(filePath)) {
    throw new KonteError(
      "ANIMATIC_NOT_FOUND",
      `No ${STAGE_ENTRY_FILE.animatic} found in the video root — every video develops a board. ` +
        `Create it with \`defineAnimatic(direction, { timeline: () => ({ shots: [] }) })\`.`,
    );
  }
  return opts?.reload ? reloadAnimaticDefinition(filePath) : loadAnimaticDefinition(filePath);
}

const HANDOFF_FILENAME_RE = /\.json$/;

/**
 * Returns the newest `*.json` handoff file for the active review stream, or null when
 * none exists. Handoffs nest per stream under `<reviewDir>/<stage>/handoffs/`, so only
 * that directory is read. The file's own `stage` is still verified — a hand-edited file
 * disagreeing with its location is skipped, not shown under the wrong stream — and an
 * invalid file is skipped so a mid-edit file doesn't mask an earlier valid one.
 */
export async function findLatestHandoff(
  reviewDir: string,
  stage: "animatic" | "video" | "reference" | "direction",
): Promise<{ path: string; handoff: Handoff } | null> {
  const dir = path.join(reviewDir, stage, "handoffs");
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return null;
  }

  const files = entries
    .filter((e) => HANDOFF_FILENAME_RE.test(e))
    .sort()
    .reverse();

  for (const file of files) {
    const filePath = path.join(dir, file);
    try {
      const handoff = await loadHandoff(filePath);
      if (handoff.stage === stage) return { path: filePath, handoff };
    } catch {
      continue;
    }
  }

  return null;
}

/** Loads a handoff JSON file. Throws on missing/unparsable/invalid file. */
export async function loadHandoff(filePath: string): Promise<Handoff> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await fs.readFile(filePath, "utf-8"));
  } catch (err) {
    throw new KonteError(
      "LOAD_FAILED",
      `Failed to load handoff "${filePath}": ${errorMessage(err)}`,
    );
  }

  const result = HandoffSchema.safeParse(parsed);
  if (!result.success) {
    throw new KonteError("VALIDATION_FAILED", `Handoff validation failed: ${result.error.message}`);
  }

  return result.data;
}

// direction.ts defines the direction (a `sequence` root node — a lens over shots, or over sub-sequences).
// It has no Zod schema — the types are enforced at type-check time (which gates every spend command)
// and its structural validity is checked by `validateDirectionStructure`/the gate — so loading only
// confirms the default export is shaped like a Direction before handing it on.
function parseDirectionModule(mod: Record<string, unknown>, filePath: string): Direction {
  const def = mod.default;
  if (!def || typeof def !== "object") {
    throw new KonteError("LOAD_FAILED", `Direction file "${filePath}" has no default export`);
  }
  const d = def as Record<string, unknown>;
  const root = d.sequence as Record<string, unknown> | undefined;
  if (
    !root ||
    typeof root !== "object" ||
    typeof root.lens !== "string" ||
    (!Array.isArray(root.shots) && !Array.isArray(root.sequences))
  ) {
    throw new KonteError(
      "VALIDATION_FAILED",
      `Direction file "${filePath}" must export a defineDirection(...) result`,
    );
  }
  return def as Direction;
}

export async function loadDirectionDefinition(filePath: string): Promise<Direction> {
  return importDefinition(filePath, "direction", false, parseDirectionModule);
}

// Cache-busting reload for the preview watcher: re-import direction.ts after an on-disk edit so the
// live review reflects the new direction (and its recomputed acceptance hash).
export async function reloadDirectionDefinition(filePath: string): Promise<Direction> {
  return importDefinition(filePath, "direction", true, parseDirectionModule);
}

// A patch file exports a definePatch(...) result, whose `build` is called with the source
// variant's address to produce the AssetDefinition that will be submitted. Like direction.ts this
// carries no Zod schema — the shape is a single method, and the workspace type-check already
// covers the file.
function parsePatchModule(
  mod: Record<string, unknown>,
  filePath: string,
  ctx: PatchBuildContext,
): PatchBuild {
  if (!("default" in mod)) {
    throw new KonteError("LOAD_FAILED", `Patch file "${filePath}" has no default export`);
  }
  const def = mod.default as Partial<PatchDefinition> | undefined;
  if (!def || typeof def !== "object" || typeof def.build !== "function") {
    throw new KonteError(
      "PATCH_INVALID",
      `Patch file "${filePath}" must export a definePatch(...) result`,
    );
  }
  let built: PatchBuild;
  try {
    built = def.build(ctx);
  } catch (err) {
    throw new KonteError(
      "PATCH_INVALID",
      `Patch file "${filePath}" failed to build: ${errorMessage(err)}`,
    );
  }

  const assets: Record<string, AssetDefinition> = {};
  for (const [name, raw] of Object.entries(built.assets)) {
    const parsed = AssetDefinitionSchema.safeParse(raw);
    if (!parsed.success) {
      throw new KonteError(
        "PATCH_INVALID",
        `Patch file "${filePath}" produced an invalid asset definition for "${name}": ${parsed.error.message}`,
      );
    }
    if (parsed.data.kind === "file") {
      throw new KonteError(
        "PATCH_INVALID",
        `Patch file "${filePath}" cannot use a file adapter (asset "${name}")`,
      );
    }
    assets[name] = parsed.data;
  }

  // The returned step is the correction's output. A step consuming it would be spend beyond the
  // take, and is unreachable from the output — which the closure check below would report as
  // "nothing consumes it", the wrong way round for the author who wrote the chain.
  const outputAddress = formatPatchAssetPath(ctx.stage, ctx.sourceVariantId, built.outputName);
  for (const [name, def] of Object.entries(assets)) {
    if (name === built.outputName) continue;
    if (extractRefs(def).includes(outputAddress)) {
      throw new KonteError(
        "PATCH_INVALID",
        `Patch file "${filePath}" feeds its returned step "${built.outputName}" into "${name}" — the returned step is the correction's output, so nothing else may consume it`,
      );
    }
  }

  // Everything the chain generates must be what the correction is built from, walked back from the
  // returned step. A step outside that closure is spend nothing consumes; and a `source` reference
  // that only such a step makes would let an unrelated generation be recorded as derived from that
  // take, giving the lineage (and so the review UI's "before") a relationship that never existed.
  const reachable = new Set<string>([built.outputName]);
  const queue = [built.outputName];
  while (queue.length > 0) {
    const def = assets[queue.pop()!];
    if (!def) continue;
    for (const ref of extractRefs(def)) {
      const parsed = patchStepNameOf(ref, ctx);
      if (parsed === null || reachable.has(parsed)) continue;
      reachable.add(parsed);
      queue.push(parsed);
    }
  }
  const unreachable = Object.keys(assets).filter((name) => !reachable.has(name));
  if (unreachable.length > 0) {
    throw new KonteError(
      "PATCH_INVALID",
      `Patch file "${filePath}" declares ${unreachable.map((n) => `"${n}"`).join(", ")}, which the returned step "${built.outputName}" never consumes — a step nothing builds on is spend with no output`,
    );
  }

  // A patch that never wires `source` into the chain behind its output is not a correction of that
  // take, however much of `source` its other declarations mention.
  const consumesSource = [...reachable].some((name) => {
    const def = assets[name];
    return def !== undefined && extractRefs(def).includes(ctx.sourceAddress);
  });
  if (!consumesSource) {
    throw new KonteError(
      "PATCH_INVALID",
      `Patch file "${filePath}" never passes \`source\` to an adapter — a patch must consume the variant it patches`,
    );
  }
  return {
    assets,
    outputName: built.outputName,
    ...(built.prompts ? { prompts: built.prompts } : {}),
  };
}

// The step name a ref points at, when it points at a step of this same patch; null otherwise.
function patchStepNameOf(ref: string, ctx: PatchBuildContext): string | null {
  if (patchSourceVariantIdOf(ref) !== ctx.sourceVariantId) return null;
  const parsed = parseAddress(ref);
  return parsed.kind === "patch" && parsed.stage === ctx.stage ? parsed.assetName : null;
}

export async function reloadPatchDefinition(
  filePath: string,
  ctx: PatchBuildContext,
): Promise<PatchBuild> {
  return importDefinition(filePath, "patch", true, (mod, file) => parsePatchModule(mod, file, ctx));
}

export async function loadVideoDefinition(filePath: string): Promise<VideoDefinition> {
  return importDefinition(filePath, "video", false, parseVideoModule);
}
