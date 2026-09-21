import { shortHash } from "./content-hash.js";
import type { VideoDefinition } from "./types/index.js";

// A fingerprint of everything in the definition that determines the EXPORTED video. Stamped on each
// export job and recomputed by `status`, so a last export whose definition has since changed reads
// as "out of date" instead of masquerading as current. Only a hash is stored, so a soundtrack `src`
// placeholder never leaks into an artifact.
//
// Covers:
//   - render: the video's render params (fps + working size). Export renders shots at these
//     (render-video.ts), and fps in particular is in no other staleness hash, so an fps/size edit
//     would otherwise have no export signal at all.
//   - renderFns: the live shot/timeline render-fn sources. The export RE-RENDERS from these at
//     export time (render-plan keeps `shot.shotFn`; the accepted composite artifact is for review
//     only — render-plan.ts), so any edit to a render fn — picture OR per-shot `<Audio>` — changes
//     the deliverable. Source-text based: it has the approximation that a non-pixel refactor flips
//     it too, and the blind spot that changes in helpers/closures the source text doesn't reflect.
//     (The composite's own definition hash is instead structural — rendered picture HTML — so the
//     two now differ in that respect: this export line still tracks per-shot `<Audio>` source.)
//   - soundtracks: the muxed timeline beds (normalized, so robust to how they're authored).
//   - delivery: the video's delivery resolution + upscale fns.
//
// Must be computed from the SAME definition the export actually renders — see run-export-job.ts,
// which reloads video.tsx at render time and stamps this then (not at submit), so an edit between
// submit and render can't leave a fresh export wearing a stale signature.
//
// Approximations (both consistent with the rest of konte):
//   - soundtracks are read from `timelineSoundtracks`, which defineVideo bakes at discovery (as
//     graph.ts / accept-cascade.ts also do). Their source edits are still caught via
//     renderFns.timeline.
//   - re-accepting a *layer* to a different variant changes the deliverable without touching any
//     source here, so it isn't flagged on the export line — but it surfaces via the consuming
//     composition going input-stale ("needs re-review"), which leads back to a re-export.
export function computeExportSignature(video: VideoDefinition): string {
  const render = { fps: video.format.fps, size: video.format.size };
  const renderFns = {
    timeline: video.timelineFn?.toString() ?? null,
    shots: video.shots.map((s) => [s.id, s.shotFn?.toString() ?? null] as const),
  };
  const soundtracks = (video.timelineSoundtracks ?? []).map((st) => ({
    id: st.id,
    src: st.src.src,
    options: st.options,
  }));
  const delivery = video.export?.delivery;
  const deliverySig = delivery
    ? {
        size: delivery.size,
        video: delivery.upscale?.video?.toString() ?? null,
        frame: delivery.upscale?.frame?.toString() ?? null,
      }
    : null;
  return shortHash({ render, renderFns, soundtracks, delivery: deliverySig });
}

// Everything the definition alone decides about an export's cut, stamped on the export job by the
// registering CLI and recomputed by the render worker from the definition it reloaded. The
// signature above covers what an EDIT to video.tsx changes; this adds what the direction hands the
// cut — the shot order and each shot's length — which is where a worker rendering from stale
// definitions was caught cutting an accepted 1.5s composition to 1s. Recorded so the worker can
// tell "the definition changed after submit" (render it) from "my definitions are older than the
// files" (step aside — see run-export-job.ts).
export function computeExportPlanDigest(video: VideoDefinition): string {
  return shortHash({
    signature: computeExportSignature(video),
    shots: video.shots.map((s) => [s.id, s.duration, s.aside ?? false, s.pending ?? false]),
  });
}
