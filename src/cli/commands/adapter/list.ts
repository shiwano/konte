import type { Command } from "commander";
import {
  filterCatalog,
  loadAdapterCatalog,
  requiredInputNames,
} from "../../../core/adapter-catalog.js";
import type { AdapterBackendKind, AdapterMeta } from "../../../core/dsl/adapter.js";
import {
  backendSetupAdvice,
  backendSetupHint,
  configuredVendorBackends,
} from "../../../core/backend-policy.js";
import { loadKonteConfig } from "../../../core/config.js";
import { KonteError, errorMessage } from "../../../core/errors.js";
import { singleLine } from "../../../core/truncate.js";
import type { VendorBackendKind } from "../../../core/types/index.js";
import { requireWorkspaceRoot } from "../../context.js";
import { declareScope } from "../../scope.js";
import { renderTable } from "../../table.js";

const BACKENDS: readonly AdapterBackendKind[] = ["comfy", "fal", "local", "file"];
const KINDS: readonly AdapterMeta["mediaType"][] = ["image", "video", "audio"];

function parseChoice<T extends string>(value: string, choices: readonly T[], flag: string): T {
  if (!(choices as readonly string[]).includes(value)) {
    throw new KonteError(
      "VALIDATION_FAILED",
      `Invalid ${flag} "${value}": expected one of ${choices.join(", ")}`,
    );
  }
  return value as T;
}

interface BackendPolicy {
  // null when konte.config.json could not be read: nothing is known about the vendors, so nothing
  // is hidden and nothing is claimed.
  configured: readonly VendorBackendKind[] | null;
  error: string | null;
}

// An adapter no vendor policy speaks about, so it is always listed — the same pair the generate
// gate exempts (see isVendorBackendAsset).
export function isExemptAdapter(
  backend: AdapterBackendKind,
): backend is Exclude<AdapterBackendKind, VendorBackendKind> {
  return backend === "file" || backend === "local";
}

// An adapter on a backend this workspace has not configured is not a choice — `generate` refuses
// it — so the default listing narrows to the configured vendors. Read from konte.config.json and
// the credentials already in the environment, never from a connectivity probe. A config that
// fails to load is reported and stepped over, so a mid-edit config still lists adapters.
export async function backendPolicy(workspaceRoot: string): Promise<BackendPolicy> {
  try {
    const config = await loadKonteConfig(workspaceRoot);
    return { configured: configuredVendorBackends(config), error: null };
  } catch (error) {
    return { configured: null, error: errorMessage(error) };
  }
}

export function registerAdapterListCommand(program: Command): void {
  const list = program
    .command("list")
    .description("List the adapters an asset() can use")
    .addHelpText(
      "after",
      "\nLists the adapters an asset() can use: the prebuilt ones konte ships (imported from\n" +
        '"konte" as adapters.<name>) and the workspace\'s own under adapters/ (imported by the\n' +
        "workspace-root specifier in the IMPORT column, which carries a .js extension).\n" +
        "INPUTS names the adapter's required inputs; what it can pin or carry beyond them is in\n" +
        "its description and `adapter show`.\n" +
        "\nOnly the backends this workspace has configured are listed (plus file and local, which\n" +
        "need none) — an adapter generate would refuse is not a choice. A backend is configured by\n" +
        "comfyui.url in konte.config.json, or by its credential (fal: FAL_KEY). --all lists the\n" +
        "rest too.\n" +
        "\nExamples:\n" +
        "  konte adapter list                    Every adapter the workspace allows\n" +
        "  konte adapter list --backend comfy    Only the workspace's ComfyUI adapters\n" +
        "  konte adapter list --kind audio       Only adapters that produce audio\n" +
        "  konte adapter list --all              Include backends this workspace has not configured",
    )
    .option(`--backend <kind>`, `Filter by backend (${BACKENDS.join(", ")})`)
    .option(`--kind <media>`, `Filter by output media (${KINDS.join(", ")})`)
    .option("--all", "Include backends this workspace has not configured")
    .action(async (opts: { backend?: string; kind?: string; all?: boolean }) => {
      const workspaceRoot = requireWorkspaceRoot();
      const backend = opts.backend ? parseChoice(opts.backend, BACKENDS, "--backend") : undefined;
      const kind = opts.kind ? parseChoice(opts.kind, KINDS, "--kind") : undefined;

      const catalog = await loadAdapterCatalog(workspaceRoot);
      // Read whatever --all does: the flag widens the LISTING, and reporting every vendor as
      // configured because of it would answer "what may this workspace spend on" with a flag.
      const { configured, error: policyError } = await backendPolicy(workspaceRoot);
      // An explicit --backend is an explicit ask: honour it, and say so if it is unconfigured.
      const narrow = configured !== null && !opts.all && !backend;
      const selected = filterCatalog(catalog.entries, { backend, kind });
      const hidden = (b: AdapterBackendKind): b is VendorBackendKind =>
        configured !== null && !isExemptAdapter(b) && !configured.includes(b);
      const entries = narrow ? selected.filter((e) => !hidden(e.meta.backend)) : selected;
      const hiddenBackends = narrow
        ? [...new Set(selected.map((e) => e.meta.backend).filter(hidden))]
        : [];
      const hiddenByPolicy = selected.length - entries.length;
      const unconfiguredAsk = !opts.all && backend && hidden(backend) ? backend : null;
      // A widened listing still has to say what generate would refuse. Without this, --all reads as
      // "all of this is spendable" — the flag would answer "what may this workspace spend on",
      // which is the one question it must not touch.
      const shownUnconfigured = narrow ? [] : entries.filter((e) => hidden(e.meta.backend));
      if (entries.length === 0) {
        console.log("No adapters found.");
      } else {
        const rows = entries.map((entry) => ({
          ADAPTER: entry.importFrom === "konte" ? `adapters.${entry.name}` : entry.name,
          BACKEND: entry.meta.backend,
          MEDIA: entry.meta.mediaType,
          INPUTS: requiredInputNames(entry.meta).join(", ") || "-",
          IMPORT: entry.importFrom,
          // The last column, so its length costs the table no alignment.
          DESCRIPTION: singleLine(
            `${entry.meta.allowedIn ? `[${entry.meta.allowedIn.join("/")} only] ` : ""}${
              entry.meta.description || "(none — add a description to the adapter)"
            }`,
          ),
        }));
        console.log(renderTable(rows));
        // The IMPORT column is a specifier, not an import statement — every adapter is a named
        // export, so spell the form here rather than let a bare path misread as a default import.
        console.log(
          '\nImport: workspace adapters are named exports — `import { <ADAPTER> } from "<IMPORT>"`.\n' +
            '        Prebuilt ones come from `import { adapters } from "konte"` (used as adapters.<name>).',
        );
      }

      const footer: string[] = [];
      // Whenever the policy would otherwise have had a say — it is why the listing was not
      // narrowed, and why an explicit --backend carries no marker.
      if (policyError) {
        footer.push(
          `! konte.config.json failed to load, so no backend could be ruled out — every one is listed: ${policyError}`,
        );
      }
      if (hiddenByPolicy > 0) {
        footer.push(
          `... and ${hiddenByPolicy} on a backend this workspace has not configured — use --all, or ` +
            backendSetupAdvice(hiddenBackends),
        );
      }
      if (unconfiguredAsk) {
        footer.push(
          `! ${unconfiguredAsk} is not configured, so generate will refuse these — ${backendSetupHint(unconfiguredAsk)}`,
        );
      } else if (shownUnconfigured.length > 0) {
        footer.push(
          `! ${shownUnconfigured.length} of these are on a backend this workspace has not configured, ` +
            `so generate will refuse them — ${backendSetupAdvice(shownUnconfigured.map((e) => e.meta.backend).filter(hidden))}`,
        );
      }
      for (const error of catalog.errors) {
        footer.push(`! ${error.file} failed to load: ${error.message}`);
      }

      if (footer.length > 0) {
        console.log(`\n${footer.join("\n")}`);
      }
    });

  declareScope(list, { scope: "workspace", skipTypeCheck: true });
}
