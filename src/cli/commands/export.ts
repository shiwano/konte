import * as path from "node:path";
import type { Command } from "commander";
import { parseStageScope } from "../../core/address.js";
import { deliveryUpscalerMissing } from "../../core/delivery.js";
import { KonteError } from "../../core/errors.js";
import { computeExportPlanDigest } from "../../core/export-signature.js";
import { syncFileAssets } from "../../core/file-sync.js";
import { buildDependencyGraph } from "../../core/graph.js";
import { JobManager } from "../../core/job-manager.js";
import { buildRenderPlan } from "../../core/render-plan.js";
import { StateManager } from "../../core/state/index.js";
import type {
  ReferenceDefinition,
  AnimaticDefinition,
  VideoDefinition,
} from "../../core/types/index.js";
import {
  assertAnimaticConsumed,
  gateDirectionForStage,
  gateStageChecks,
  loadStageDefinitions,
} from "../load-definition.js";
import { planDelivery } from "./render-delivery.js";
import { formatSuggestedActions } from "../../core/suggested-actions.js";
import { requireVideoRoots } from "../context.js";
import type { VideoRoots } from "../../core/roots.js";
import { applyResolutionDefinitions } from "../../core/definition-hashes.js";

// Registered, not rendered — nothing pushes the render's outcome, so both paths name the wait.
const EXPORT_NEXT_ACTIONS = [{ command: "konte job wait" }, { command: "konte probe export" }];

// Register an `export` job that renders the video profile to a delivered MP4. The render
// runs asynchronously through the job pipeline (like `generate`): with delivery config,
// each video layer's upscale is submitted first and the export job depends on them, so the
// MCP watcher (or a bare `konte job wait`) runs the upscales then the render. Re-running reuses
// fresh upscales (staleness cache) and registers a fresh render.
async function registerVideoExport(opts: {
  roots: VideoRoots;
  video: VideoDefinition;
  animatic: AnimaticDefinition;
  reference: ReferenceDefinition | null;
  allowUnaccepted: boolean;
  noDelivery: boolean;
}): Promise<void> {
  const { roots, video, animatic, reference, allowUnaccepted, noDelivery } = opts;
  const videoRoot = roots.video;

  // Sync file assets under the state lock so the seconds-long media hashing cannot
  // clobber a concurrent watcher write; reuse the returned post-sync snapshot below.
  const manager = await StateManager.withLock(videoRoot, async (m) => {
    await syncFileAssets({ reference, animatic, video }, m, { measure: true });
    return m;
  });

  // Store the base output dir on the job; the render worker picks a fresh timestamped
  // subdir per attempt (so a reclaimed render never collides with a stalled prior one).
  const outputDirRel = path.join("dist", "video");

  // `generate video` refuses the same wiring gap; a ref removed after the motion was generated would
  // reach export unspent.
  assertAnimaticConsumed({
    video,
    animatic,
    graph: buildDependencyGraph(video, animatic, reference),
  });

  const plan = buildRenderPlan(video, manager, {
    outputDir: path.resolve(videoRoot, outputDirRel),
    allowUnaccepted: true,
  });

  if (plan.shots.length === 0) {
    throw new KonteError("NO_RENDERABLE_ASSET", "No shots found in the video definition");
  }

  // A final deliverable can't have undeveloped shots. Pending shots pass the direction gate (they
  // are realized in the direction) but must be developed before export — unlike --allow-unaccepted,
  // there is no override: an undeveloped shot has no motion at all.
  const pendingShots = plan.shots.filter((s) => s.pending).map((s) => s.shotId);
  if (pendingShots.length > 0) {
    throw new KonteError(
      "PENDING_SHOTS",
      `Cannot export: the following shots are still undeveloped (pendingShot):\n${pendingShots
        .map((id) => `  video:shot.${id}`)
        .join(
          "\n",
        )}\nDevelop them (swap the injected pendingShot for shot in video.tsx) before exporting.`,
    );
  }

  // A composition ref reaching outside its shot (an animatic panel, a reference asset, a sibling shot's
  // asset) that resolves to nothing would render as a raw placeholder — a black layer, shipped
  // silently. There is nothing to fall back to, so no flag overrides this.
  const unresolvedRefs = [...new Set(plan.shots.flatMap((s) => s.unresolvedRefs))];
  if (unresolvedRefs.length > 0) {
    throw new KonteError(
      "DEPENDENCY_NOT_RESOLVED",
      `Cannot export: the composition references assets with no ready variant:\n${unresolvedRefs
        .map((ref) => `  ${ref}`)
        .join("\n")}\nGenerate them first.`,
    );
  }

  // Refuse to export a half-baked video by default — the upscale/render only runs on
  // ready source layers, so block here unless --allow-unaccepted. Out-of-shot refs are held to the
  // same bar: an animatic panel the video composites is as load-bearing as one of its own assets.
  const unaccepted = [
    ...new Set([
      ...plan.unacceptedTimelineAssets,
      ...plan.shots.flatMap((s) => s.unacceptedAssets),
      ...plan.shots.flatMap((s) => s.unacceptedRefs),
    ]),
  ];
  if (unaccepted.length > 0 && !allowUnaccepted) {
    throw new KonteError(
      "UNACCEPTED_ASSETS",
      `Cannot export: the following assets are not accepted:\n${unaccepted
        .map((addr) => `  ${addr}`)
        .join("\n")}\nAccept them, or pass --allow-unaccepted to render the ready variants.`,
    );
  }

  const jobManager = new JobManager(videoRoot);

  // Submit delivery upscales (if any) and collect what the render depends on.
  let dependsOnAssets: string[] = [];
  let dependsOnJobs: string[] = [];
  let deliverySubmitted = 0;
  let deliveryInProgress = 0;
  // Delivery upscaler gate (export-only; validating at load would break read-only and
  // reference-stage commands mid-wiring — see defineVideo). There is no aspect gate: the working
  // canvas is derived from the delivery's own aspect. Skipped under --no-delivery.
  const delivery = video.export?.delivery;
  if (delivery && !noDelivery) {
    if (deliveryUpscalerMissing(video)) {
      throw new KonteError(
        "DELIVERY_UPSCALE_REQUIRED",
        `The direction delivers ${delivery.size!.width}x${delivery.size!.height} from a ${video.format.size.width}x${video.format.size.height} canvas but video.tsx wires no export.delivery.upscale. Add upscale.video or upscale.frame, or raise policy.format.size.megapixels so the canvas meets the delivery.`,
      );
    }
  }

  const hasDelivery = delivery != null;
  if (hasDelivery && !noDelivery) {
    const dp = await planDelivery({
      video,
      shots: plan.shots,
      manager,
      roots,
      jobManager,
    });
    if (dp) {
      dependsOnAssets = dp.deliveryAddresses;
      dependsOnJobs = dp.submittedJobIds;
      deliverySubmitted = dp.submittedJobIds.length;
      deliveryInProgress = dp.inProgress;
    }
  }

  const exportJob = await jobManager.createExportJob({
    outputDir: outputDirRel,
    allowUnaccepted,
    noDelivery,
    dependsOnAssets,
    dependsOnJobs,
    planDigest: computeExportPlanDigest(video),
  });

  console.log(`Export job ${exportJob.id} registered (video).`);
  if (hasDelivery && noDelivery) {
    console.log(
      `Delivery skipped (${allowUnaccepted ? "--allow-unaccepted" : "--no-delivery"}): rendering at working size into a *_no_delivery dir.`,
    );
  } else if (hasDelivery) {
    console.log(
      `Delivery upscales: ${deliverySubmitted} submitted, ${deliveryInProgress} already running.`,
    );
  }
  console.log(`\n${formatSuggestedActions(EXPORT_NEXT_ACTIONS)}`);
}

export function registerExportCommand(program: Command): void {
  program
    .command("export <stage>")
    .description("Export the finished video as a rendered MP4 (async render job)")
    .option(
      "--allow-unaccepted",
      "Export even when some assets are not accepted (uses ready variants); implies --no-delivery",
    )
    .option("--no-delivery", "Skip delivery upscales; render a working-size composite check")
    .addHelpText(
      "after",
      `
Registers an async render job that runs through the job pipeline. When the video has a
delivery config, the per-shot upscales are submitted first and the render waits on them.
Pass --no-delivery to skip the upscales and render a quick working-size composite check
instead; its output lands in a *_no_delivery dir so it is never mistaken for the real
deliverable. --allow-unaccepted implies it: material nobody has signed off is not what a
delivery upscale is spent on. Only the video stage is exportable — the animatic is a
working stage with no deliverable.

Examples:
  konte export video                   Render the final deliverable (runs delivery upscales)
  konte export video --no-delivery     Quick working-size composite check, no upscales
`,
    )
    .action(async (scope: string, opts: { allowUnaccepted?: boolean; delivery?: boolean }) => {
      const { stage } = parseStageScope(scope);
      const roots = requireVideoRoots();
      const videoRoot = roots.video;

      if (stage !== "video") {
        throw new KonteError(
          "INVALID_ADDRESS",
          stage === "reference"
            ? "The reference stage is not exportable — it is an upstream pool consumed by animatic/video."
            : "Only the video stage is exportable — the animatic is a working stage with no deliverable.",
        );
      }

      const { video, animatic, reference } = await loadStageDefinitions(videoRoot);
      await applyResolutionDefinitions({
        videoRoot,
        definitions: { video, animatic, reference },
      });

      // Gate on the direction before rendering the deliverable. A video export is the final
      // assembly, so it also enforces completeness — every direction id must be realized.
      await gateDirectionForStage({
        videoRoot,
        command: "export",
        stage,
        realizedIds: video.shots.map((s) => s.id),
      });
      await gateStageChecks(video, stage);

      // A delivery upscale is the one part of an export that spends, and unaccepted material is
      // by definition not what it is spent on — so the rough cut never reaches it.
      const allowUnaccepted = !!opts.allowUnaccepted;

      await registerVideoExport({
        roots,
        video,
        animatic,
        reference,
        allowUnaccepted,
        noDelivery: opts.delivery === false || allowUnaccepted,
      });
    });
}
