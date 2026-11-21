import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isCompositionAddress, isDeliveryAddress } from "./address.js";
import type { GenerationResult } from "./backend.js";
import { hashFile } from "./content-hash.js";
import { KonteError, errorMessage } from "./errors.js";
import { formatSeconds } from "./format-duration.js";
import { normalizeKeyframesIfSparse } from "./keyframe-normalize.js";
import { type PatchOutputOrigin, materializePatchOutput } from "./patch-output.js";
import { recognizesSpeechIn } from "./sherpa-binary.js";
import { hearSpeech, writeHeardSpeech } from "./speech-hearing.js";
import { StateManager } from "./state/index.js";
import type { GenerationJob } from "./types/index.js";
import { mediaDurationSec, mediaHasAudio } from "./variant-media.js";
import { videoCacheDir } from "./video-cache.js";
import { probeMediaInfo } from "./video-probe.js";

export type FinalizeTakeInput = {
  videoRoot: string;
  job: GenerationJob;
  result: GenerationResult;
  // A take that owes a line is heard when it lands; the song is heard off its vocal track instead.
  owesLine: boolean;
  lang: string;
  // Set on the step a patched take is made from.
  patchOutput: PatchOutputOrigin | null;
  workerId: string;
  log: (line: string) => void;
  // Whether this worker still holds the job's run lease; false ends the finalize uncommitted.
  stillOwns: () => Promise<boolean>;
};

export type FinalizedTake =
  | { kind: "committed"; outputFiles: string[]; outputFile: string; outputHash: string | null }
  | { kind: "lost" }
  // The state write failed, so the job must not be marked completed.
  | { kind: "stateUncommitted"; error: string };

/**
 * Turn a finished backend result into the take state records: re-encode sparse keyframes, hash and
 * probe the file, hear its line, fingerprint its inputs, and commit the variant. Throws only what
 * fails the job.
 */
export async function finalizeTake(input: FinalizeTakeInput): Promise<FinalizedTake> {
  const { videoRoot, job, result, log, stillOwns } = input;

  // Confirm we still own the lease BEFORE the destructive work below. The backend wait can run
  // for many minutes; if this worker stalled and a reclaimer took over during it, an in-place
  // keyframe re-encode + hash + state write from both owners would race — a hash could be
  // computed from a half-rewritten file. stillOwns is false when ownership was lost (and
  // refreshes it when retained).
  if (!(await stillOwns())) return { kind: "lost" };

  // Backends write into the absolute variantDir and return absolute paths, but konte
  // stores every variant/thumbnail/export path project-relative — konte.state.json is
  // committed, so an absolute path breaks the project on a checkout at a different path.
  // Normalize here, the one point every backend's result flows through.
  const outputFiles = result.files.map((f) =>
    path.isAbsolute(f) ? path.relative(videoRoot, f) : f,
  );

  const [outputFile] = outputFiles;
  if (!outputFile) {
    throw new KonteError(
      "GENERATION_FAILED",
      `Backend job ${job.backendJobId} returned no output file`,
    );
  }

  // Re-encode in place before hashing so the variant konte stores is always
  // seek-safe — AI video models often emit sparse keyframes that break
  // HyperFrames' frame-by-frame capture/render with freezing and A/V desync.
  // Doing it here covers every backend.
  try {
    const norm = await normalizeKeyframesIfSparse(path.resolve(videoRoot, outputFile));
    if (norm.normalized) {
      log(
        `Normalized sparse keyframes (max interval ${norm.maxIntervalSeconds === undefined ? "?" : formatSeconds(norm.maxIntervalSeconds, 2)} > 2s) for reliable seeking.`,
      );
    } else if (norm.skipReason && norm.maxIntervalSeconds !== undefined) {
      log(
        `Left sparse keyframes (max interval ${formatSeconds(norm.maxIntervalSeconds, 2)}) unchanged: ${norm.skipReason}.`,
      );
    }
  } catch (normErr) {
    log(`Keyframe normalization failed (kept original): ${errorMessage(normErr)}`);
  }

  // Re-verify ownership after the in-place re-encode (which can itself take a while) and
  // before hashing/committing: had this worker stalled through the normalization, a reclaimer
  // that took over could be rewriting the same file, and the hash would read half-written
  // bytes.
  if (!(await stillOwns())) return { kind: "lost" };

  const outputHash = await hashFile(path.resolve(videoRoot, outputFile)).catch(() => null);
  // The one probe of these bytes, where the file has just landed.
  const media = await probeMediaInfo(path.resolve(videoRoot, outputFile));
  const durationSec = mediaDurationSec(media);
  const { lang, owesLine } = input;
  if (owesLine && !recognizesSpeechIn(lang)) {
    log(`Speech in ${lang} is not recognized; the line is not heard.`);
  } else if (owesLine && outputHash && durationSec && media && mediaHasAudio(media)) {
    const workDir = videoCacheDir(videoRoot, "heard", `${job.id}-${input.workerId}`);
    try {
      const heard = await hearSpeech(
        path.resolve(videoRoot, outputFile),
        durationSec,
        lang,
        workDir,
      );
      await writeHeardSpeech(videoRoot, job.address, job.variantId, { outputHash, heard });
      log(`Heard: ${heard.length} token(s)`);
    } catch (hearErr) {
      log(`Warning: the take's line could not be recognized: ${errorMessage(hearErr)}`);
    } finally {
      await fs.rm(workDir, { recursive: true, force: true });
    }
  }
  const inputFingerprints = await fingerprintInputs(videoRoot, job);

  // Commit the dependency-resolving state (variant.file) BEFORE the caller flips the job to
  // "completed". evaluateJob keys off state.file, and a cascade triggered the instant the
  // job is observed ready would otherwise see "ready job, no file, no active job" and
  // permanently fail dependents. Ordering state-first makes "completed" imply the file
  // exists. Both state.json and the job file are written atomically (temp+rename).
  try {
    const owned = await StateManager.withLock(videoRoot, async (manager) => {
      if (!(await stillOwns())) return false;
      const variant = manager.tryGetAssetState(job.address)?.variants?.[job.variantId];
      if (variant) {
        variant.file = outputFile;
        variant.readyAt = new Date().toISOString();
        variant.outputHash = outputHash;
        // Absent unless the measurement came back, and only alongside the hash it is keyed to. A
        // retry commits over the same variant, so a failure has to clear rather than leave an
        // earlier take's numbers describing the bytes now at `outputHash`.
        if (media && outputHash) variant.media = media;
        else delete variant.media;
        variant.inputFingerprints = inputFingerprints;
        variant.metadata = result.metadata;
        // Recorded in the job's metadata at submission (see submitToBackend), so a reclaiming
        // waiter reads it back from the persisted job; absent for a seedless definition.
        if (typeof job.metadata.seed === "number") variant.seed = job.metadata.seed;
        // A `#delivery` asset is synthesized (not in the definition) and is konte's to accept.
        if (isDeliveryAddress(job.address)) {
          manager.setAccepted(job.address, job.variantId);
        }
        // The chain's returned step just landed, so the patched take exists: register it at the
        // source's address, in this same lock. Committing it separately would leave a window
        // where the correction is on disk but nothing at the corrected address points at it.
        //
        // A failure here is NOT this commit's failure: the source take can have been removed
        // (`patch remove`, `clean`) while the chain ran, and the step's own take is on disk
        // either way. Letting it throw would abandon that commit and leave the job unable to
        // settle, re-failing for every waiter that reclaims it.
        if (input.patchOutput) {
          try {
            materializePatchOutput(manager, input.patchOutput, {
              address: job.address,
              variantId: job.variantId,
            });
          } catch (err) {
            log(`Patched variant not registered: ${errorMessage(err)}`);
          }
        }
      }
      return true;
    });
    if (!owned) return { kind: "lost" };
  } catch (stateErr) {
    return { kind: "stateUncommitted", error: errorMessage(stateErr) };
  }

  return { kind: "committed", outputFiles, outputFile, outputHash };
}

async function fingerprintInputs(
  videoRoot: string,
  job: GenerationJob,
): Promise<Record<string, string>> {
  const inputFingerprints: Record<string, string> = {};
  for (const [depPath, depFile] of Object.entries(job.provenance.resolvedDependencies)) {
    // A patch feeds its source variant in under its OWN address; fingerprinting that would make
    // the output permanently input-stale against its own address's accepted output. The patch's
    // upstream picture is its source's, so it is inherited below instead.
    if (depPath === job.address) continue;
    try {
      // A composition dependency (a frame delivery upscale's source) is identified by its
      // definition + upstream fingerprints (compositionCacheKey) — NOT the rendered mp4's
      // bytes, which vary per render. Use the key snapshotted at submit time (provenance), not
      // a recompute from live state: the composition may have moved during this (long) upscale,
      // which would record the new composition's key onto an upscale of the old one — making the
      // next export cache-hit a stale shot forever.
      if (isCompositionAddress(depPath)) {
        const key = job.provenance.compositionCacheKeys[depPath];
        if (key) inputFingerprints[depPath] = key;
        continue;
      }
      inputFingerprints[depPath] = await hashFile(path.resolve(videoRoot, depFile));
    } catch {
      // dependency file unreadable; skip — staleness treats missing as not determinable
    }
  }
  return inputFingerprints;
}
