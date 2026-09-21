import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { addressFromCacheSegments } from "./address.js";
import { FFMPEG_CONCURRENCY, mapConcurrent } from "./concurrency.js";
import { errorMessage } from "./errors.js";
import { padVideoClip } from "./ffmpeg.js";
import type { StateManager } from "./state/index.js";

/**
 * The reel plays every shot from its own `<video>`, and the runtime starts one only when its
 * window opens — at the cut. Starting a clip there holds the picture on its first frame for a frame
 * or two, and it costs the same whether the cut calls `play()`, seeks, or changes `playbackRate`.
 * The one thing that costs nothing is an element already running at rate 1 on the right frame,
 * which the cut then merely reveals.
 *
 * So each clip opens its own window `lead` seconds early. `Li()` (the runtime's visibility pass)
 * ANDs an element's window with every `[data-start]` ancestor's, and a shot's `<video>` sits inside
 * a host `<div data-composition-id data-start="<cut>">` — so the clip plays through the run-up
 * hidden behind the shot still on screen, and the cut touches nothing.
 *
 * A clip's position is `(t - data-start) + data-media-start`, so the shift is paid out of
 * `data-media-start` — which a clip cut out of the middle of a take has to spare, and one that
 * opens on its take's first frame does not, `data-media-start` having no negative side. Only the
 * second case needs media that does not exist yet: `padVideoClip` writes a copy holding the first
 * frame in front, bounded to the window the clip plays, and cached per take. Either way the frame at
 * every position inside the window is the frame that was there before.
 *
 * A copy also carries a tail — the last frame cloned past the source's end — and a clip whose take
 * ends within a tail of its window gets a copy for that alone: a source that ends with the window
 * hits EOF whenever the picture runs a frame ahead of the transport, and the runtime answers an
 * ended clip inside its window by seeking it back and replaying it.
 *
 * The run-up hides the cost of starting the clip, but not the lag it starts with: the runtime never
 * re-syncs a playing `<video>` (a seek would freeze it), so however late the picture gets going, it
 * stays that late to the end of the shot — the clone frames end that much after the cut. A clip the
 * browser has suspended (idle for a while since the page loaded) gets going late, so the reel's
 * warm-up (`prerollWarmupScript`) seeks each clip to its in-point shortly before its window opens:
 * the seek wakes the pipeline and parks the decoder on the right frame, unseen.
 */

/** How long before its cut a clip starts playing. Frame-aligned per clip (see `planVideoPreroll`). */
export const PREROLL_TARGET_SEC = 0.4;

/** How far past its window a copy keeps playing, cloning the last frame where the source is out. */
export const PREROLL_TAIL_SEC = 0.5;

/** How long before a clip's window opens the warm-up seeks it. */
export const PREROLL_WARMUP_SEC = 2;

/** URL prefix the preview server serves the padded copies from. */
export const PREROLL_ASSET_BASE = "/api/preroll-assets";

export interface PrerollClip {
  /**
   * Offset of the `<video>` tag this plan belongs to, and the tag as it stood there.
   *
   * A plan is per placement: one take can open two shots at different `mediaStart`s or for
   * different lengths, and each of those needs its own offset, copy and window.
   */
  tagIndex: number;
  tag: string;
  /** Absolute path of the take being padded. */
  sourceFile: string;
  /** The shift applied to `data-start`. */
  leadSec: number;
  /** Source time a copy starts at: the in-point less the lead, floored at the take's head. */
  seekSec: number;
  /**
   * How much of the lead the media does not already have in front of the clip's in-point, and so
   * must be padded on. Zero where the in-point sits at least a lead into the take.
   */
  padSec: number;
  /** `data-media-start` after the shift. */
  mediaStartAfter: number;
  /**
   * `<variantId>/<bytes>-<seek>s<pad>p<limit>w.mp4` under the cache and the served prefix; null
   * where the take itself carries both the run-up and a tail.
   */
  cachePath: string | null;
  /** The take's own directory in the cache, and the byte-stamp its current copies carry. */
  variantDir: string;
  stamp: string;
  /** Seconds of the copy to write — the clip's own window plus the tail, never the whole source. */
  copyLimitSec: number;
}

const VIDEO_TAG = /<video\b[^>]*>/g;
const SHOT_HOST = /<div\b[^>]*\sdata-composition-id="shot-([^"]+)"[^>]*>/g;
const SHOT_TEMPLATE = /<template id="shot-([^"]+)-template">/g;

function attr(tag: string, name: string): string | null {
  return tag.match(new RegExp(`\\s${name}="([^"]*)"`))?.[1] ?? null;
}

function ms(seconds: number): number {
  return Math.round(seconds * 1000);
}

function num(value: string | null): number | null {
  if (value === null) return null;
  const n = parseFloat(value);
  return Number.isFinite(n) ? n : null;
}

/** The address/variant a served asset URL (`buildAssetUrl`) names; null for any other src. */
function parseServedAsset(
  src: string,
  assetBaseUrl: string,
): { address: string; variantId: string } | null {
  const prefix = `${assetBaseUrl}/`;
  if (!src.startsWith(prefix)) return null;
  const segs = src.slice(prefix.length).split("/");
  if (segs.length < 3) return null;
  try {
    const [stage, suffix, variantId] = segs.slice(0, 3).map((s) => decodeURIComponent(s));
    return { address: addressFromCacheSegments([stage!, suffix!]), variantId: variantId! };
  } catch {
    return null;
  }
}

// A variant id names a file here, so anything that could leave the cache directory is refused
// rather than sanitized into a different take's name.
function safeVariantId(variantId: string): boolean {
  return /^[A-Za-z0-9_-]{1,128}$/.test(variantId);
}

// The take's bytes, short and filename-safe. Null for an unhashed take, which is one nothing can
// tell apart from the next thing written at the same id.
function contentStamp(outputHash: string | null | undefined): string | null {
  const hex = /^[A-Za-z0-9]{8,}$/.test(outputHash ?? "") ? outputHash! : null;
  return hex && hex.slice(0, 16);
}

export function prerollCacheDir(videoRoot: string): string {
  return path.join(videoRoot, ".konte", "cache", "preroll");
}

/** A take's padded copies. Keyed by variant like the audio/motion caches, so `prune` reaches it. */
export function prerollVariantDir(videoRoot: string, variantId: string): string {
  return path.join(prerollCacheDir(videoRoot), variantId);
}

/** Where each shot's host sits on the reel clock, by shot id. */
function shotHostStarts(html: string): Map<string, number> {
  const starts = new Map<string, number>();
  for (const m of html.matchAll(SHOT_HOST)) {
    const start = num(attr(m[0], "data-start"));
    if (start !== null) starts.set(m[1]!, start);
  }
  return starts;
}

/** One `<video>` tag eligible for a run-up, located in the HTML so the rewrite can be exact. */
interface ClipTag {
  tag: string;
  index: number;
  src: string;
  dataStart: number;
  dataDuration: number;
  mediaStart: number;
}

/**
 * Every `<video>` that opens its shot — the only ones a run-up is safe on.
 *
 * What hides the run-up is the shot host's own window, so a clip must begin exactly where its host
 * does. One that starts partway through its shot (`<Video start={2}>`, or the second clip of a
 * two-clip shot) sits inside a host that is ALREADY on screen, and pulling its window back would put
 * it on screen early. Tags are matched to their shot through the
 * `<template id="shot-<id>-template">` they are emitted in, so a clip cannot borrow another shot's
 * start by happening to land on it.
 */
function shotOpeningClipTags(html: string): ClipTag[] {
  const hostStarts = shotHostStarts(html);
  const clips: ClipTag[] = [];
  for (const m of html.matchAll(SHOT_TEMPLATE)) {
    const hostStart = hostStarts.get(m[1]!);
    if (hostStart === undefined) continue;
    const from = m.index + m[0].length;
    const to = html.indexOf("</template>", from);
    if (to === -1) continue;

    VIDEO_TAG.lastIndex = 0;
    for (const v of html.slice(from, to).matchAll(VIDEO_TAG)) {
      const src = attr(v[0], "src");
      const dataStart = num(attr(v[0], "data-start"));
      // Without an explicit duration the runtime falls back to the host's remaining span, which the
      // shift would stretch by the lead — and nothing bounds how much source a copy would cover.
      const dataDuration = num(attr(v[0], "data-duration"));
      if (!src || dataStart === null || dataDuration === null) continue;
      if (dataStart !== hostStart) continue;
      // A looping clip replays its whole source every cycle, padding included — the run-up would
      // become a held frame in the middle of the shot, over and over.
      if (/\sloop(?=[\s>=])/.test(v[0])) continue;
      // The runtime reads a clip's position as `(t - start) * rate + mediaStart`, so a rate other
      // than 1 scales the shift and the window with it — and the frame alignment the padding needs
      // is then a whole source frame at that rate.
      const rate = num(attr(v[0], "data-playback-rate"));
      if (rate !== null && rate > 0 && rate !== 1) continue;
      clips.push({
        tag: v[0],
        index: from + v.index,
        src,
        dataStart,
        dataDuration,
        mediaStart: num(attr(v[0], "data-media-start")) ?? 0,
      });
    }
  }
  return clips;
}

/**
 * The clips in a built reel that can be given a run-up, each with the lead it gets.
 *
 * The lead is rounded to a whole source frame: a fractional one would put the cut inside a padding
 * frame, which is the one-frame hold this exists to remove. A clip is skipped where the take's fps
 * is unmeasured (nothing to align to), where its bytes are unidentified (nothing to key a copy on),
 * or where the cut is closer to the reel's head than the lead (no room to run up in). Pure — the
 * caller decides which of these are actually on disk.
 */
export function planVideoPreroll(
  html: string,
  assetBaseUrl: string,
  manager: StateManager,
): PrerollClip[] {
  const plans: PrerollClip[] = [];
  for (const clip of shotOpeningClipTags(html)) {
    const served = parseServedAsset(clip.src, assetBaseUrl);
    if (!served || !safeVariantId(served.variantId)) continue;

    const variant = manager.tryGetAssetState(served.address)?.variants?.[served.variantId];
    const media = variant?.media;
    if (!variant?.file || media?.kind !== "video") continue;

    // A `file` take keeps its variant id when its bytes are swapped (`syncFileAssets` updates the
    // hash in place), so the id alone would hand back a copy of media that is gone.
    const stamp = contentStamp(variant.outputHash);
    if (!stamp) continue;

    const leadSec = Math.round(PREROLL_TARGET_SEC * media.fps) / media.fps;
    if (leadSec <= 0 || clip.dataStart < leadSec) continue;

    // Only what the take is short of — a clip cut from the middle of a long source needs no copy,
    // and never a pass over the whole file.
    const padSec = Math.max(0, leadSec - clip.mediaStart);
    const seekSec = clip.mediaStart - leadSec + padSec;
    const tailShort = media.durationSec - (clip.mediaStart + clip.dataDuration) < PREROLL_TAIL_SEC;
    const needsCopy = padSec > 0 || tailShort;
    const copyLimitSec = leadSec + clip.dataDuration + PREROLL_TAIL_SEC;

    plans.push({
      tagIndex: clip.index,
      tag: clip.tag,
      sourceFile: path.resolve(manager.videoRoot, variant.file),
      leadSec,
      seekSec,
      padSec,
      mediaStartAfter: needsCopy ? 0 : clip.mediaStart - leadSec,
      cachePath: needsCopy
        ? `${served.variantId}/${stamp}-${ms(seekSec)}s${ms(padSec)}p${ms(copyLimitSec)}w.mp4`
        : null,
      copyLimitSec,
      variantDir: served.variantId,
      stamp,
    });
  }
  return plans;
}

// One encode per output path for as long as it runs. The preview issues overlapping full-composition
// requests (the player and the shot list each ask), and two passes on one path would race their
// renames and could interleave writes into the file the loser then publishes.
const inFlight = new Map<string, Promise<boolean>>();

// Best-effort GC of copies of bytes this take no longer has: a `file` take keeps its id when its
// content is swapped, so without this every edit would leave its encode behind for good. Copies of
// the CURRENT bytes all share the stamp, so the take's other placements survive.
async function dropSupersededCopies(dir: string, stamp: string): Promise<void> {
  try {
    for (const entry of await fsp.readdir(dir)) {
      if (!entry.startsWith(`${stamp}-`)) await fsp.rm(path.join(dir, entry), { force: true });
    }
  } catch {
    // the directory is new, or someone else is sweeping it
  }
}

async function buildPrerollCopy(outputFile: string, clip: PrerollClip): Promise<boolean> {
  await fsp.mkdir(path.dirname(outputFile), { recursive: true });
  await dropSupersededCopies(path.dirname(outputFile), clip.stamp);
  // A crash mid-encode would leave a truncated mp4 under the name a later run trusts, so the pass
  // writes beside it and renames only once ffmpeg has returned. The temp is unique per pass (a
  // second konte process shares neither this map nor its pid) and keeps the `.mp4` extension —
  // ffmpeg picks its muxer off that, and any other suffix fails to open at all.
  const ext = path.extname(outputFile);
  const partial = `${outputFile.slice(0, -ext.length)}.${process.pid}-${randomUUID().slice(0, 8)}${ext}`;
  try {
    await padVideoClip({
      inputFile: clip.sourceFile,
      outputFile: partial,
      seek: clip.seekSec,
      lead: clip.padSec,
      tail: PREROLL_TAIL_SEC,
      limit: clip.copyLimitSec,
    });
    await fsp.rename(partial, outputFile);
    return true;
  } catch (err) {
    await fsp.rm(partial, { force: true }).catch(() => {});
    console.error(`[preview] preroll clip failed (${clip.cachePath}): ${errorMessage(err)}`);
    return false;
  }
}

/**
 * Build whatever copies are missing, and report the clips that are ready to be used.
 *
 * A clip that cannot be built is left out: the reel then plays it the way it does today, one hitch
 * at that cut, rather than a broken `src`. A copy is keyed by the take's bytes, so an existing one
 * is reused across sessions and only a fresh take pays for a pass.
 */
export async function ensurePrerollClips(
  videoRoot: string,
  clips: readonly PrerollClip[],
): Promise<PrerollClip[]> {
  if (clips.length === 0) return [];
  const dir = prerollCacheDir(videoRoot);

  const built = await mapConcurrent(clips, FFMPEG_CONCURRENCY, async (clip) => {
    // A take that already carries its own run-up and tail needs nothing on disk.
    if (!clip.cachePath) return clip;

    const outputFile = path.join(dir, clip.cachePath);
    if (fs.existsSync(outputFile)) return clip;

    let pass = inFlight.get(outputFile);
    if (!pass) {
      pass = buildPrerollCopy(outputFile, clip).finally(() => inFlight.delete(outputFile));
      inFlight.set(outputFile, pass);
    }
    return (await pass) ? clip : null;
  });

  return built.filter((c): c is PrerollClip => c !== null);
}

function shiftedVideoTag(tag: string, clip: PrerollClip): string | null {
  const start = num(attr(tag, "data-start"));
  const duration = num(attr(tag, "data-duration"));
  if (start === null || duration === null || start < clip.leadSec) return null;

  let out = tag
    .replace(/\sdata-start="[^"]*"/, ` data-start="${start - clip.leadSec}"`)
    .replace(/\sdata-duration="[^"]*"/, ` data-duration="${duration + clip.leadSec}"`);
  if (clip.cachePath) {
    out = out.replace(/\ssrc="[^"]*"/, ` src="${PREROLL_ASSET_BASE}/${clip.cachePath}"`);
  }
  // A copy starts a lead before the clip's own in-point, so its offset is zero; a take used as is
  // runs up through its own frames, so the offset moves back by exactly the shift.
  return /\sdata-media-start="/.test(out)
    ? out.replace(/\sdata-media-start="[^"]*"/, ` data-media-start="${clip.mediaStartAfter}"`)
    : out.replace(/>$/, ` data-media-start="${clip.mediaStartAfter}">`);
}

/**
 * Point each ready clip's `<video>` at its padded copy and open its window `lead` seconds early.
 *
 * Only the picture moves. The mirrored `<audio>` a `<Video hasAudio>` carries keeps playing the
 * untouched take at its own offsets — the padded copy has no audio track, so the mix a review is
 * judged on is still the take's own bytes.
 */
export function applyVideoPreroll(html: string, ready: readonly PrerollClip[]): string {
  let out = html;
  // Back to front, so each splice leaves the offsets ahead of it untouched.
  for (const clip of [...ready].sort((a, b) => b.tagIndex - a.tagIndex)) {
    // The plan was made against this exact string; anything else means it is not ours to rewrite.
    if (!out.startsWith(clip.tag, clip.tagIndex)) continue;
    const shifted = shiftedVideoTag(clip.tag, clip);
    if (!shifted) continue;
    out = out.slice(0, clip.tagIndex) + shifted + out.slice(clip.tagIndex + clip.tag.length);
  }
  return out;
}

/**
 * The reel's warm-up, as an inline script.
 *
 * Every `PREROLL_WARMUP_SEC` before a `<video>`'s window opens, while it is still paused, it is
 * seeked once to its in-point. The clip is outside its window, which the runtime leaves alone. A
 * clip the playhead is parked in front of is seeked again after `REWARM_MS`, before the browser's
 * idle timer can suspend it a second time.
 */
export function prerollWarmupScript(): string {
  return (
    `<script>(function(){var WARM=${PREROLL_WARMUP_SEC},REWARM_MS=10000,warmed=new WeakMap();` +
    `setInterval(function(){var p=window.__player;if(!p||typeof p.getTime!=="function")return;` +
    `var t=p.getTime();if(typeof t!=="number"||!isFinite(t))return;` +
    `var els=document.querySelectorAll("video[data-start]");` +
    `for(var i=0;i<els.length;i++){var el=els[i],start=parseFloat(el.dataset.start);` +
    `if(!isFinite(start)||t<start-WARM||t>=start||!el.paused)continue;` +
    `var now=performance.now(),last=warmed.get(el);if(last!=null&&now-last<REWARM_MS)continue;` +
    `warmed.set(el,now);var ms=parseFloat(el.dataset.mediaStart||"0");` +
    `try{el.currentTime=isFinite(ms)?ms:0}catch(e){}}},250)})()</script>`
  );
}

/** Add the warm-up to a built reel, before `</body>` where the page has one. */
export function injectPrerollWarmup(html: string): string {
  const script = prerollWarmupScript();
  const bodyCloseIdx = html.lastIndexOf("</body>");
  if (bodyCloseIdx === -1) return html + script;
  return `${html.slice(0, bodyCloseIdx)}${script}\n${html.slice(bodyCloseIdx)}`;
}
