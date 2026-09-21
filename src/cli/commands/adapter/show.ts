import type { Command } from "commander";
import { loadAdapterCatalog, type AdapterCatalogEntry } from "../../../core/adapter-catalog.js";
import type { AdapterMetaInput } from "../../../core/dsl/adapter.js";
import { KonteError } from "../../../core/errors.js";
import { requireWorkspaceRoot } from "../../context.js";
import { declareScope } from "../../scope.js";
import { renderTable } from "../../table.js";
import { backendPolicy, isExemptAdapter } from "./list.js";

const ADAPTERS_PREFIX = "adapters.";

// How `adapter list`/`show` labels an entry: a prebuilt one as `adapters.<name>`, a workspace one
// by its bare export name.
function entryLabel(entry: AdapterCatalogEntry): string {
  return entry.importFrom === "konte" ? `${ADAPTERS_PREFIX}${entry.name}` : entry.name;
}

// What the adapter wraps (its `ref`) — a ComfyUI workflow filename, a fal endpoint id, a local
// op name. Reduce it to the bare token a human types: drop any path and a
// trailing `.json`, so `adapter show` resolves an adapter by what it wraps, not only its export name.
function refAlias(ref: string): string {
  return ref.slice(ref.lastIndexOf("/") + 1).replace(/\.json$/, "");
}

// `show` is read-only, so a query that names several adapters isn't a conflict to resolve — it just
// prints them all. Export names are preferred; a bare `ref` can front sibling adapters (a model's
// t2v and i2v), so the ref fallback legitimately returns more than one.
function resolveEntries(entries: AdapterCatalogEntry[], name: string): AdapterCatalogEntry[] {
  // `konte adapter list` prints a prebuilt adapter as `adapters.<name>` and a workspace one as the
  // bare name, so the `adapters.` prefix is the disambiguator between a prebuilt and a workspace
  // adapter that share a name — honour it, and match a bare name across both.
  const prebuiltOnly = name.startsWith(ADAPTERS_PREFIX);
  const wanted = prebuiltOnly ? name.slice(ADAPTERS_PREFIX.length) : name;
  const byName = entries.filter(
    (entry) => entry.name === wanted && (!prebuiltOnly || entry.importFrom === "konte"),
  );
  if (byName.length > 0) return byName;

  // No export-name match. An `adapters.` query is explicitly for an export name, so don't reach for
  // the ref. Otherwise fall back to the `ref` (path and `.json` stripped) so an adapter resolves by
  // what it wraps, not only its export name.
  if (!prebuiltOnly) {
    const wantedRef = refAlias(name);
    const byRef = entries.filter((entry) => refAlias(entry.meta.ref) === wantedRef);
    if (byRef.length > 0) return byRef;
  }

  throw new KonteError(
    "ADAPTER_NOT_FOUND",
    `No adapter matching "${wanted}" — see \`konte adapter list\``,
  );
}

function defaultCell(input: AdapterMetaInput): string {
  if (input.computed) return "(computed)";
  // Collapse whitespace so a multiline default (e.g. a pretty-printed JSON string) stays on one
  // table row; renderTable then caps its width.
  if (input.default !== undefined) return String(input.default).replace(/\s+/g, " ").trim();
  return "-";
}

// `≤362` marks the ceiling past which the load fails.
// `×32` / `×17+5` marks the grid konte raises a number onto: a value passed off it comes back at
// the next point. `@24` is the fps a frame count is measured on. `pin:start` / `pin:end` marks an
// image the model reproduces as that frame; the pin check refuses a sheet or a plate there.
function typeCell(input: AdapterMetaInput): string {
  const base = input.array ? `${input.type}[]` : input.type;
  const clock = input.clock ? `@${input.clock}` : "";
  const grid = input.grid
    ? ` ×${input.grid.step}${input.grid.offset ? `+${input.grid.offset}` : ""}`
    : "";
  const max = input.max !== undefined ? ` ≤${input.max}` : "";
  const pin = input.pin ? ` pin:${input.pin}` : "";
  return `${base}${clock}${grid}${max}${pin}`;
}

function renderInputs(inputs: Record<string, AdapterMetaInput>): string {
  // Required inputs first (declaration order kept within each group): they are what an asset() call
  // cannot omit, and in declaration order they scatter through a 20-row table — a reader who cuts
  // the output short misses one.
  const entries = Object.entries(inputs).sort(
    ([, a], [, b]) => Number(b.required) - Number(a.required),
  );
  if (entries.length === 0) return "(none)";
  const anyDescription = entries.some(
    ([, input]) =>
      input.description ||
      Object.values(input.structure?.fields ?? {}).some((field) => field.description),
  );
  const rows = entries.flatMap(([name, input]) => [
    {
      INPUT: name,
      TYPE: typeCell(input),
      REQUIRED: input.required ? "yes" : "-",
      DEFAULT: defaultCell(input),
      // Quote each allowed value: a ComfyUI band reads as a label over a range (`8: -18.5--14`), so
      // unquoted it looks like an index and a gloss, and `"8"` gets passed instead of the whole string.
      VALUES: input.values ? input.values.map((value) => JSON.stringify(value)).join(", ") : "-",
      ...(anyDescription ? { DESCRIPTION: input.description ?? "-" } : {}),
    },
    ...Object.entries(input.structure?.fields ?? {}).map(([field, def]) => ({
      INPUT: `  ${field}`,
      TYPE: "",
      REQUIRED: def.required ? "yes" : "-",
      DEFAULT: "",
      VALUES: "",
      ...(anyDescription ? { DESCRIPTION: def.description ?? "" } : {}),
    })),
  ]);
  // A default can be a multi-KB embedded JSON string (e.g. Stable Audio's `category`); left whole
  // it flattens the whole table. Cap it here.
  return renderTable(rows, { maxWidths: { DEFAULT: 60 } });
}

function renderEntry(entry: AdapterCatalogEntry, unconfigured: boolean | null): string {
  const label = entryLabel(entry);
  // A quiet marker: this workspace has not configured that backend, so `generate`
  // would refuse it (BACKEND_NOT_CONFIGURED). How to turn it on is in `adapter list`.
  const policyTag = unconfigured ? "  (not configured)" : "";
  const lines = [`${label}  (${entry.meta.backend}, ${entry.meta.mediaType})${policyTag}`, ""];
  lines.push(`ref     ${entry.meta.ref}`);
  const readHint =
    entry.guides.length > 1
      ? "(read each, in order, before writing a prompt)"
      : "(read it before writing a prompt)";
  entry.guides.forEach((guide, index) => {
    const hint = guide.path ? (index === 0 ? `  ${readHint}` : "") : "  (missing)";
    lines.push(`guide   ${guide.path ?? guide.specifier}${hint}`);
  });
  if (entry.meta.allowedIn)
    lines.push(`scope   declared in ${entry.meta.allowedIn.join(", ")} only`);
  if (entry.meta.readsPrevPanel)
    lines.push(
      "cut     readsPrevPanel — another shot's panel passed to an image input is the frame the cut comes from",
    );
  if (entry.meta.turbo)
    lines.push(
      `turbo   ${Object.entries(entry.meta.turbo)
        .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
        .join(
          ", ",
        )} — konte sets it on a shot or timeline asset's first take; every later take uses the default`,
    );
  // The specifier, plus how to import it — a named export, so a bare path would misread as a
  // default import (TS2613). A prebuilt adapter comes through the `adapters` namespace.
  lines.push(`import  ${entry.importFrom}`);
  lines.push(
    entry.importFrom === "konte"
      ? `        import { adapters } from "konte"  (used as ${label})`
      : `        import { ${entry.name} } from "${entry.importFrom}"`,
  );
  lines.push("", entry.meta.description, "");
  lines.push(renderInputs(entry.meta.inputs));
  return lines.join("\n");
}

export function registerAdapterShowCommand(program: Command): void {
  const show = program
    .command("show <adapter>")
    .description("Show an adapter's full schema and craft guide")
    .addHelpText(
      "after",
      "\nPrints everything needed to write an asset() call for an adapter: backend, model ref,\n" +
        "the full input schema (type, required, default, allowed values, and any per-input notes),\n" +
        "required inputs first, and the path to its craft guide when it ships one — prompt-craft for\n" +
        "a model, usage for a local op. A guide is named, not printed; a model whose decodes share\n" +
        "a grammar lists that file first and its own last. Names a prebuilt adapter by its export (either\n" +
        "`imageResize` or `adapters.imageResize`) or a workspace adapter by its export\n" +
        "name. It also resolves by what the adapter wraps — a ComfyUI workflow filename or a fal\n" +
        "endpoint id — matched by its bare name, without any path or\n" +
        "`.json`. When that names several sibling adapters (a model's t2v and i2v), each is printed.\n" +
        "\nExamples:\n" +
        "  konte adapter show falSeedance25T2v   Schema + guide for the FAL Seedance T2V adapter\n" +
        "  konte adapter show myComfyAsset       A workspace adapter under adapters/\n" +
        "  konte adapter show video_minimax_h3_r2v  By its ComfyUI workflow filename",
    )
    .action(async (name: string) => {
      const workspaceRoot = requireWorkspaceRoot();
      const catalog = await loadAdapterCatalog(workspaceRoot);
      const matches = resolveEntries(catalog.entries, name);
      const { configured } = await backendPolicy(workspaceRoot);
      const decorated = matches.map((entry) => ({
        entry,
        // null when konte.config.json could not be read: nothing is known about the vendors, so the
        // adapter carries no marker.
        unconfigured:
          configured === null
            ? null
            : !isExemptAdapter(entry.meta.backend) && !configured.includes(entry.meta.backend),
      }));

      const blocks = decorated.map(({ entry, unconfigured }) => renderEntry(entry, unconfigured));
      const body = blocks.join(`\n\n${"─".repeat(60)}\n\n`);
      console.log(
        matches.length > 1 ? `${matches.length} adapters match "${name}":\n\n${body}` : body,
      );
    });

  declareScope(show, { scope: "workspace", skipTypeCheck: true });
}
