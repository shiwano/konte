import type { Command } from "commander";
import { JobManager } from "../../../core/job-manager.js";
import {
  activeGenerationVariantIds,
  findPendingPatches,
  loadPatchCatalog,
  patchHashesOf,
} from "../../../core/patch.js";
import { isVariantStale, variantsNewestFirst } from "../../../core/staleness.js";
import { StateManager } from "../../../core/state/index.js";
import { requireVideoRoots } from "../../context.js";
import {
  addListLimitOptions,
  applyListLimit,
  type ListLimitOptions,
  listMoreLine,
} from "../../format-list.js";
import { applyResolutionDefinitions } from "../../../core/definition-hashes.js";

type PatchStatus = "pending" | "applied" | "orphaned" | "absent" | "broken";

interface PatchRow {
  source: string;
  address: string | null;
  file: string;
  status: PatchStatus;
  outputs: string[];
  detail?: string;
  // Ordering only — not part of the reported shape.
  sortKey?: string;
}

export function registerPatchListCommand(parent: Command): void {
  addListLimitOptions(
    parent
      .command("list")
      .description("List patch scripts and whether each one's output is current"),
    "rows",
  )
    .addHelpText(
      "after",
      `
One row per patches/<variantId>.ts. "pending" means the script has no up-to-date output — it was
never applied, it was edited since, or an input it consumed moved. "orphaned" means its source
variant is gone from state; \`konte prune\` offers to clean those up. "absent" means its source variant
is in state but its media is not in this checkout (git tracks only accepted takes).

Examples:
  konte patch list           every patch and its state
`,
    )
    .action(async (opts: ListLimitOptions & { json?: boolean }) => {
      const roots = requireVideoRoots();
      const videoRoot = roots.video;
      const manager = await StateManager.load(videoRoot);
      const state = manager.getState();
      const catalog = await loadPatchCatalog(videoRoot, state, manager.absentVariantIds());
      const patchHashes = patchHashesOf(catalog);
      // The per-row "current" count takes the same memo, or the two columns disagree about a patch.
      await applyResolutionDefinitions({ videoRoot, patchHashes });
      const cache = manager.stalenessCache();
      const jobs = await new JobManager(videoRoot).listJobs();
      const pending = new Set(
        findPendingPatches(
          state,
          catalog,
          activeGenerationVariantIds(jobs),
          manager.stalenessCache(),
        ).map((p) => p.sourceVariantId),
      );

      const rows: PatchRow[] = [];
      for (const patch of catalog.patches.values()) {
        const variants = state.assets[patch.sourceAddress]?.variants ?? {};
        const outputs = variantsNewestFirst(variants)
          .filter(([, v]) => v.derivedFrom === patch.sourceVariantId)
          .map(([id]) => id);
        const current = outputs.filter((id) => {
          const v = variants[id];
          return (
            v?.file && !isVariantStale(state, patch.sourceAddress, v, null, patchHashes, cache)
          );
        });
        rows.push({
          source: patch.sourceVariantId,
          address: patch.sourceAddress,
          file: patch.filePath,
          status: pending.has(patch.sourceVariantId) ? "pending" : "applied",
          outputs,
          detail: current.length > 0 ? `${current.length} current` : undefined,
          // Newest-first is by the SOURCE take's creation, since a variant id is random and
          // sorts to nothing meaningful.
          sortKey: variants[patch.sourceVariantId]?.createdAt ?? "",
        });
      }
      for (const orphan of catalog.orphans) {
        rows.push({
          source: orphan.sourceVariantId,
          address: null,
          file: orphan.filePath,
          status: "orphaned",
          outputs: [],
          detail: "source variant is gone from state",
        });
      }
      for (const absent of catalog.absent) {
        rows.push({
          source: absent.sourceVariantId,
          address: null,
          file: absent.filePath,
          status: "absent",
          outputs: [],
          detail: "source variant's media is not in this checkout",
        });
      }
      for (const err of catalog.errors) {
        rows.push({
          source: err.sourceVariantId,
          address: null,
          file: err.filePath,
          status: "broken",
          outputs: [],
          detail: err.message,
        });
      }

      // Newest-first, like every other list command. Rows with no source take (orphaned, absent, broken)
      // have no timestamp, so they sort last and fall back to the id for a stable order.
      rows.sort((a, b) => {
        const byTime = (b.sortKey ?? "").localeCompare(a.sortKey ?? "");
        return byTime !== 0 ? byTime : a.source.localeCompare(b.source);
      });

      // `--limit` caps both renderings, matching the documented list-command contract.
      const capped = applyListLimit(rows, opts);

      if (rows.length === 0) {
        console.log("No patches");
        return;
      }

      const { shown, hidden } = capped;
      for (const row of shown) {
        const where = row.address ? ` ${row.address}` : "";
        const detail = row.detail ? `  ${row.detail}` : "";
        console.log(`  ${row.status.padEnd(8)} ${row.source}${where}${detail}`);
      }
      if (hidden > 0) console.log(`\n${listMoreLine(hidden)}`);
    });
}
