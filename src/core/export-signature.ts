import { mixedSoundtracks } from "./song-bed.js";
import { listCompositionAddresses, listStemAddresses } from "./address.js";
import { definitionHashForAddress, overlayDefinitionHash } from "./composition-resource.js";
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
//   - leaves: each composition's and stem's definition hash — the rendered picture structure and
//     the cue mix, the same identities the review signs off. The export re-renders from the
//     definition, so an edit to either changes the deliverable.
//   - soundtracks: the muxed timeline beds, the song bed among them (normalized, so robust to how
//     they're authored).
//   - overlay: the overlay's structural hash.
//   - delivery: the video's delivery resolution + upscale fns.
//
// Must be computed from the SAME definition the export actually renders — see run-export-job.ts,
// which reloads video.tsx at render time and stamps this then (not at submit), so an edit between
// submit and render can't leave a fresh export wearing a stale signature.
//
// Approximations (both consistent with the rest of konte):
//   - soundtracks are read from `timelineSoundtracks`, which defineVideo bakes at discovery (as
//     graph.ts / accept-cascade.ts also do).
//   - re-accepting a *layer* to a different variant changes the deliverable without touching any
//     source here, so it isn't flagged on the export line — but it surfaces via the consuming
//     composition going input-stale ("needs re-review"), which leads back to a re-export.
export function computeExportSignature(video: VideoDefinition): string {
  const render = { fps: video.format.fps, size: video.format.size };
  const leaves = [...listCompositionAddresses(video), ...listStemAddresses(video)].map(
    (address) => [address, definitionHashForAddress(video, address)] as const,
  );
  const soundtracks = mixedSoundtracks(video, video.timelineSoundtracks).map((st) => ({
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
  const overlay = video.overlay ? overlayDefinitionHash(video) : null;
  return shortHash({
    render,
    leaves,
    soundtracks,
    delivery: deliverySig,
    ...(overlay ? { overlay } : {}),
  });
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
