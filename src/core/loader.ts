import { type Dirent, existsSync, readdirSync } from "node:fs";
import * as fs from "node:fs/promises";
import { createRequire } from "node:module";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as jsxRuntime from "react/jsx-runtime";
import * as jsxDevRuntime from "react/jsx-dev-runtime";
import { listAddresses, listReferenceAddresses } from "./definition-addresses.js";
import type { Direction } from "./dsl/direction.js";
import * as dsl from "./dsl/index.js";
import type { PatchBuild, PatchBuildContext, PatchDefinition } from "./dsl/patch.js";
import { KonteError, errorMessage } from "./errors.js";
import { withSongVariants } from "./dsl/song-context.js";
import { readSongTakes, type SongVariant } from "./song-variant.js";
import { validatePatchChain } from "./patch-chain.js";
import { STAGE_ENTRY_FILE, VIDEO_MARKER, findWorkspaceRootSync, stageEntryPath } from "./roots.js";
import {
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
// long-lived process (the worker) this renders edited definitions against a stale upstream —
// an asset added to reference.tsx "not found in definition", an edited adapter still hashing to
// the definition it had at worker start.
// Evict every on-disk user module before a reload so the whole graph re-evaluates fresh on the next
// import; keep konte/react/node_modules so the dsl singleton and resolver stay intact.
//
// The cache is `require.cache`: deleting a key evicts the module at that path, ES modules included.
// Bun 1.4 removed the `Loader.registry` global this used to reach for, and an eviction that quietly
// found nothing turned every reload into the first load for the life of the worker;
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
// a job watcher's and an export render's) let one's eviction delete modules the
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

// The video a definition file belongs to: the nearest directory above it holding a state file.
function videoRootOf(filePath: string): string | null {
  let dir = path.dirname(filePath);
  for (let depth = 0; depth < 3; depth++) {
    if (existsSync(path.join(dir, VIDEO_MARKER))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

// The video's song takes, for `defineDirection` to place its lyrics with, and their reading. No
// state (a fresh video, a test fixture) is no take.
async function songVariantsFor(filePath: string): Promise<{
  videoRoot: string | null;
  variants: ((address: string) => SongVariant | null) | null;
  reading: string;
}> {
  const videoRoot = videoRootOf(filePath);
  const takes = videoRoot ? await readSongTakes(videoRoot) : null;
  return { videoRoot, variants: takes?.variants ?? null, reading: takes?.reading ?? "" };
}

// The song reading each video's modules were last evaluated under. A cached module placed its lyrics
// and lead with the takes of its evaluation, so a reading that moved since re-evaluates them.
const evaluatedReading = new Map<string, string>();

let definitionLock: Promise<unknown> = Promise.resolve();

// One definition import at a time, process-wide, each under the song takes of its own video: the
// worker loads several videos in one process, and a module evaluates against whatever takes are
// current while it does.
function underDefinitionLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = definitionLock.then(fn);
  definitionLock = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

// Import a definition entry (fresh — evicting the project's modules first — or from the registry)
// and hand the module to its parser. A failed import names the project file that threw; a
// KonteError keeps its code, anything else is a LOAD_FAILED.
async function importDefinition<T>(
  filePath: string,
  label: string,
  fresh: boolean,
  parse: (mod: Record<string, unknown>, filePath: string) => T | Promise<T>,
): Promise<T> {
  let mod: Record<string, unknown>;
  try {
    const { videoRoot, variants, reading } = await songVariantsFor(filePath);
    const moved =
      videoRoot !== null &&
      evaluatedReading.has(videoRoot) &&
      evaluatedReading.get(videoRoot) !== reading;
    mod = await underDefinitionLock(() =>
      withSongVariants(variants, () =>
        fresh || moved ? reloadFreshModule(filePath) : importModule(filePath),
      ),
    );
    if (videoRoot !== null) evaluatedReading.set(videoRoot, reading);
  } catch (err) {
    // Bun keeps the record of a module that threw during evaluation, and a SECOND import of it
    // RESOLVES — handing back a namespace whose bindings never initialized instead of re-throwing.
    // Every later load in the process then reports "Cannot access 'default' before initialization"
    // over whatever the definition actually said, and one swallowed first load is enough to set
    // that up (`loadIfPresent`, the read paths that `.catch(() => null)` a broken stage). The file
    // that threw poisons its importers too, so evict the whole project subtree: the next load
    // re-evaluates and says it again.
    await underReloadLock(async () => bustProjectModuleCache(path.dirname(filePath)));
    const origin = err instanceof Error ? thrownIn(err, path.dirname(filePath)) : null;
    const where =
      origin && origin !== filePath
        ? `"${origin}" (imported by ${label} file "${filePath}")`
        : `${label} file "${filePath}"`;
    if (err instanceof KonteError) {
      throw new KonteError(err.code, `${where}: ${err.headline}`, err.items);
    }
    throw new KonteError(
      "LOAD_FAILED",
      `Failed to ${fresh ? "reload" : "load"} ${where}: ${errorMessage(err)}`,
    );
  }
  return parse(mod, filePath);
}

// The user file whose evaluation threw `err`: its innermost stack frame that `isProjectModule` counts
// as user code, outside the generated `.konte/` module. Null where no frame is, or the stack cannot be
// read.
function thrownIn(err: Error, videoRoot: string): string | null {
  const prefixes = projectRootPrefixes(videoRoot);
  let stack: string;
  try {
    stack = String(err.stack ?? "");
  } catch {
    return null;
  }
  for (const line of stack.split("\n")) {
    const file = /^\s*at (?:.*\()?(.+?):\d+(?::\d+)?\)?$/.exec(line)?.[1];
    if (!file) continue;
    const at = file.startsWith("file://") ? fileURLToPath(file) : file;
    if (at.includes(`${path.sep}.konte${path.sep}`)) continue;
    if (isProjectModule(at, prefixes, KONTE_PACKAGE_ROOT)) return at;
  }
  return null;
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
  assertUnique(listAddresses(video, "video"), "address", "Video");
  return video;
}

export type LoadOptions = { reload?: boolean };

// Imported at use: what the frame's definition hashes reaches back into the loader.
async function withFrameHashes(video: VideoDefinition): Promise<VideoDefinition> {
  if (!video.thumbnail?.frame) return video;
  const { withThumbnailFrameHashes } = await import("./thumbnail-frame.js");
  return withThumbnailFrameHashes(video);
}

export async function loadVideoDefinition(
  filePath: string,
  opts?: LoadOptions,
): Promise<VideoDefinition> {
  return withFrameHashes(
    await importDefinition(filePath, "video", opts?.reload === true, parseVideoModule),
  );
}

function parseReferenceModule(mod: Record<string, unknown>, filePath: string): ReferenceDefinition {
  const parsed = parseDefaultExport(mod, filePath, "Reference", ReferenceDefinitionSchema);
  const reference: ReferenceDefinition = {
    shots: [],
    topLevelAssets: parsed.topLevelAssets,
    exposedAssetNames: parsed.exposedAssetNames,
    prompts: parsed.prompts,
  };
  assertUnique(listReferenceAddresses(reference), "address", "Reference");
  return reference;
}

export async function loadReferenceDefinition(
  filePath: string,
  opts?: LoadOptions,
): Promise<ReferenceDefinition> {
  return importDefinition(filePath, "reference", opts?.reload === true, parseReferenceModule);
}

// reference.tsx is a required entry. Absent file => REFERENCE_NOT_FOUND; an existing but invalid
// file throws its own validation error.
export async function loadReference(
  videoRoot: string,
  opts?: LoadOptions,
): Promise<ReferenceDefinition> {
  const filePath = stageEntryPath(videoRoot, "reference");
  if (!existsSync(filePath)) {
    throw new KonteError(
      "REFERENCE_NOT_FOUND",
      `No ${STAGE_ENTRY_FILE.reference} found in the video root. ` +
        `Create it with \`defineReference(direction, { references: () => ({}) })\`.`,
    );
  }
  return loadReferenceDefinition(filePath, opts);
}

function parseAnimaticModule(mod: Record<string, unknown>, filePath: string): AnimaticDefinition {
  const animatic = parseDefaultExport(mod, filePath, "Animatic", AnimaticDefinitionSchema);
  assertUnique(
    animatic.shots.map((s) => s.id),
    "shot ID",
    "Animatic",
  );
  assertUnique(listAddresses(animatic, "animatic"), "address", "Animatic");
  return animatic;
}

export async function loadAnimaticDefinition(
  filePath: string,
  opts?: LoadOptions,
): Promise<AnimaticDefinition> {
  return importDefinition(filePath, "animatic", opts?.reload === true, parseAnimaticModule);
}

// animatic.tsx is a required entry. Absent file => ANIMATIC_NOT_FOUND; an existing but invalid file
// throws its own validation error.
export async function loadAnimatic(
  videoRoot: string,
  opts?: LoadOptions,
): Promise<AnimaticDefinition> {
  const filePath = stageEntryPath(videoRoot, "animatic");
  if (!existsSync(filePath)) {
    throw new KonteError(
      "ANIMATIC_NOT_FOUND",
      `No ${STAGE_ENTRY_FILE.animatic} found in the video root. ` +
        `Create it with \`defineAnimatic(direction, { timeline: () => ({ shots: [] }) })\`.`,
    );
  }
  return loadAnimaticDefinition(filePath, opts);
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

export async function loadDirectionDefinition(
  filePath: string,
  opts?: LoadOptions,
): Promise<Direction> {
  return importDefinition(filePath, "direction", opts?.reload === true, parseDirectionModule);
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
  return validatePatchChain(filePath, built, ctx);
}

export async function reloadPatchDefinition(
  filePath: string,
  ctx: PatchBuildContext,
): Promise<PatchBuild> {
  return importDefinition(filePath, "patch", true, (mod, file) => parsePatchModule(mod, file, ctx));
}
