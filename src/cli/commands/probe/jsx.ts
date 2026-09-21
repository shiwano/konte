import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { Command } from "commander";
import {
  addressToCacheSegments,
  assertValidAddressScope,
  getAssetEntryByAddress,
  isPatchAddress,
  listAssetPaths,
  matchesAddressScope,
  parseAddress,
} from "../../../core/address.js";
import { applyResolutionDefinitions } from "../../../core/definition-hashes.js";
import { computeDefinitionHash } from "../../../core/definition-hash.js";
import { KonteError } from "../../../core/errors.js";
import { asJsxStillInputs, renderJsxStill } from "../../../core/jsx-still.js";
import { requireFileWithinRoot } from "../../../core/path-containment.js";
import { parsePlaceholder } from "../../../core/dsl/shot-context.js";
import { StateManager } from "../../../core/state/index.js";
import { assertTailwindClasses } from "../../../core/tailwind-classes.js";
import type { AssetDefinition, LocalAssetDefinition } from "../../../core/types/index.js";
import { requireVideoRoot } from "../../context.js";
import { loadStageDefinitions } from "../../load-definition.js";

// `render` is the one local operation `jsxImage` produces, and the only adapter that produces it.
function isJsxRender(entry: AssetDefinition): entry is LocalAssetDefinition {
  return entry.kind === "local" && entry.operation === "render";
}

// Digit runs compared numerically, so an unpadded shot.2 precedes shot.10 (as in `contact-sheet`).
function compareNatural(a: string, b: string): number {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });
}

interface DeclaredAssets {
  /** Every `jsxImage`, in stage then declaration order. */
  jsx: Map<string, LocalAssetDefinition>;
  /** Every address the stage files declare, whatever its kind — what tells a wrong kind from no such address. */
  all: Set<string>;
}

async function listDeclaredAssets(videoRoot: string): Promise<DeclaredAssets> {
  const { reference, animatic, video } = await loadStageDefinitions(videoRoot);
  const jsx = new Map<string, LocalAssetDefinition>();
  const all = new Set<string>();
  for (const [stage, definition] of [
    ["reference", reference],
    ["animatic", animatic],
    ["video", video],
  ] as const) {
    if (!definition) continue;
    for (const address of listAssetPaths(definition, stage)) {
      all.add(address);
      const entry = getAssetEntryByAddress(definition, address);
      if (isJsxRender(entry)) jsx.set(address, entry);
    }
  }
  return { jsx, all };
}

// `#` marks a name konte owns rather than the author (a composition, a stem, a `#delivery`
// derivative) — always a real leaf, never a stage file's asset.
function notJsx(address: string, declared: DeclaredAssets): KonteError {
  if (isPatchAddress(address)) {
    return new KonteError(
      "INVALID_ASSET_TYPE",
      `"${address}" is a patch step — \`probe jsx\` reads the stage definitions, so generate it instead`,
    );
  }
  if (declared.all.has(address) || address.includes("#")) {
    return new KonteError(
      "INVALID_ASSET_TYPE",
      `"${address}" is not a jsxImage asset — \`probe jsx\` renders jsxImage assets only`,
    );
  }
  return new KonteError("ADDRESS_NOT_FOUND", `No asset declared at "${address}"`);
}

/** The addresses `args` select, in argument order, each argument sorted within itself. */
function selectAddresses(args: readonly string[], declared: DeclaredAssets): string[] {
  const { jsx } = declared;
  const selected: string[] = [];
  const seen = new Set<string>();
  const take = (address: string) => {
    if (seen.has(address)) return;
    seen.add(address);
    selected.push(address);
  };

  for (const arg of args) {
    let isFullAddress = true;
    try {
      parseAddress(arg);
    } catch {
      isFullAddress = false;
    }

    if (isFullAddress) {
      if (!jsx.has(arg)) throw notJsx(arg, declared);
      take(arg);
      continue;
    }

    assertValidAddressScope(arg);
    const under = [...jsx.keys()].filter((address) => matchesAddressScope(address, arg));
    if (under.length === 0) {
      throw new KonteError("ADDRESS_NOT_FOUND", `No jsxImage asset under scope "${arg}"`);
    }
    for (const address of under.sort(compareNatural)) take(address);
  }
  return selected;
}

// Everything that determines the picture. An unresolved ref is keyed as such, so the tile is
// replaced the moment its upstream lands.
function cacheKey(assetDef: LocalAssetDefinition, refFingerprints: Record<string, string>): string {
  return createHash("sha256")
    .update(JSON.stringify([computeDefinitionHash(assetDef), refFingerprints]))
    .digest("hex")
    .slice(0, 12);
}

// One still per address: a superseded key is a previous edit's picture that nothing will ask for
// again.
//
// A sibling NEWER than the one just written is not superseded — it is a concurrent run that resolved
// its inputs differently, and deleting it would strand the path that run printed.
async function pruneSuperseded(dir: string, keep: string): Promise<void> {
  const own = await fs.stat(path.join(dir, keep)).catch(() => null);
  if (!own) return;
  const entries = await fs.readdir(dir).catch(() => [] as string[]);
  await Promise.all(
    entries.map(async (entry) => {
      if (entry === keep || !entry.endsWith(".png")) return;
      const file = path.join(dir, entry);
      const other = await fs.stat(file).catch(() => null);
      if (!other || other.mtimeMs > own.mtimeMs) return;
      await fs.rm(file, { force: true });
    }),
  );
}

interface JsxStillResult {
  address: string;
  path: string;
  cached: boolean;
  unresolved: string[];
}

export function registerProbeJsxCommand(program: Command): void {
  program
    .command("jsx <addressOrScope...>")
    .description("Render a jsxImage asset straight from its definition, with no job and no variant")
    .option("--force", "Re-render even if a matching still is cached")
    .addHelpText(
      "after",
      `
Renders the picture a jsxImage asset would produce and prints its path — Read it to judge a layout:
a corner radius, a band height, where a line wraps. Nothing is written to state: no variant is
registered, no job is created, nothing goes stale, and no accept is touched. A jsxImage is
deterministic and costs no spend.

Takes one or more (in any mix) of an address naming a jsxImage asset, or an address-scope that
renders every jsxImage under it. A non-jsxImage address is rejected rather than skipped; a scope
that holds none errors.

An upstream the tree references (<Image src={…}>) is resolved the way every read surface resolves —
accepted, else the newest take, stale included. One with nothing to resolve to is drawn as a
labelled placeholder tile and reported on stderr.

Stills are cached under .konte/cache/jsx/ by definition and resolved inputs, so re-running an
untouched address costs nothing; --force re-renders anyway.

Examples:
  konte probe jsx video:shot.01.card        One asset, rendered now
  konte probe jsx animatic:timeline.logo  A timeline-level jsxImage
  konte probe jsx video                     Every jsxImage in the video stage
  konte probe jsx reference video:shot.01   Two scopes, in the order written`,
    )
    .action(async (addressOrScopes: string[], opts: { force?: boolean }) => {
      const videoRoot = requireVideoRoot();
      const declared = await listDeclaredAssets(videoRoot);
      const addresses = selectAddresses(addressOrScopes, declared);

      const manager = await StateManager.load(videoRoot);
      await applyResolutionDefinitions({ videoRoot, state: manager.getState() });

      await assertTailwindClasses(
        addresses.map((address) => ({
          label: address,
          html: asJsxStillInputs(declared.jsx.get(address)!.inputs).html,
        })),
      );

      const results: JsxStillResult[] = [];
      for (const address of addresses) {
        const assetDef = declared.jsx.get(address)!;
        const inputs = asJsxStillInputs(assetDef.inputs);

        // Resolved once for the cache key and reused as the renderer's answer, so the still on disk
        // is always the one its key describes.
        const files = new Map<string, string | null>();
        const fingerprints: Record<string, string> = {};
        for (const placeholder of inputs.refs ?? []) {
          const refAddress = parsePlaceholder(placeholder);
          if (!refAddress) continue;
          const resolved = manager.resolveReference(refAddress, { includeStale: true });
          const file = resolved ? await requireFileWithinRoot(videoRoot, resolved.file) : null;
          // A file gone missing since state recorded it is unresolved: containment passes a path
          // with no link to follow, and the capture would symlink a dangling name into the page and
          // render a broken layer with nothing said.
          const stat = file === null ? null : await fs.stat(file).catch(() => null);
          if (!resolved || file === null || stat === null) {
            files.set(placeholder, null);
            fingerprints[refAddress] = "unresolved";
            continue;
          }
          files.set(placeholder, file);
          // This command writes nothing, so it never runs the `file`-asset sync that moves a
          // `file` take's content hash — an edit in place would otherwise leave the key still, and
          // hand back the picture from before it.
          fingerprints[refAddress] =
            `${resolved.outputHash ?? resolved.variantId}:${stat.size}:${stat.mtimeMs}`;
        }

        const key = cacheKey(assetDef, fingerprints);
        const dir = path.join(
          videoRoot,
          ".konte",
          "cache",
          "jsx",
          ...addressToCacheSegments(address),
        );
        const outputFile = path.join(dir, `${key}.png`);
        const unresolved = [...files.entries()]
          .filter(([, file]) => file === null)
          .map(([placeholder]) => parsePlaceholder(placeholder)!);

        if (!opts.force && existsSync(outputFile)) {
          results.push({ address, path: outputFile, cached: true, unresolved });
          continue;
        }

        await renderJsxStill({
          inputs,
          outputFile,
          videoRoot,
          resolveRef: async (placeholder) => files.get(placeholder) ?? null,
        });
        await pruneSuperseded(dir, `${key}.png`);
        results.push({ address, path: outputFile, cached: false, unresolved });
      }

      // The still is the judgment: paths alone on stdout, so the caller can pipe or Read them.
      for (const result of results) console.log(result.path);

      const rendered = results.filter((r) => !r.cached).length;
      console.error(
        `${results.length} still(s), ${rendered} rendered, ${results.length - rendered} cached`,
      );
      for (const result of results) {
        if (result.unresolved.length === 0) continue;
        console.error(`unresolved in ${result.address}: ${result.unresolved.join(", ")}`);
      }
    });
}
