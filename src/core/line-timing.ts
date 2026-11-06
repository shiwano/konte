// Where each script line is heard on the reel: the characters' heard seconds where the take was
// heard, else the take's sound and the pauses inside it.

import { tryParseAddress } from "./address.js";
import { loudnessOf } from "./audio-level.js";
import { buildShotClips, type CompositionClip } from "./composition-builder.js";
import type { StageDefinitions } from "./definition-hashes.js";
import { collectShots } from "./direction.js";
import type { Direction } from "./dsl/direction.js";
import { loadHearing } from "./hearing/index.js";
import { alignHeard } from "./line-hearing.js";
import {
  clipReelClock,
  readTakeHeard,
  saidBy,
  sourceWindow,
  spokenSourcesOf,
  takeDurationSec,
} from "./line-marks.js";
import { recognizesSpeechIn } from "./sherpa-binary.js";
import type { StateManager } from "./state/index.js";
import type { AnimaticDefinition, StageDefinition, VideoDefinition } from "./types/index.js";
import { loadDirectionDefinition } from "./loader.js";
import { overlayShotStarts, renderOverlayBody } from "./overlay-render.js";
import { buildRenderPlan, type RenderPlan } from "./render-plan.js";
import { stageEntryPath } from "./roots.js";
import { loadStageDefinitions } from "./stage-definitions.js";
import { lineText } from "./types/script.js";
import { type LineTimer, type LineTiming, lineTimingKey } from "./subtitle-timing.js";

/**
 * The timing of every line of the shots `lineShots` names (every shot where null), heard in the
 * clips of `clipsByShot` across `shots`, each opening at its `start` on the reel. A line is its own
 * shot's however far from it the take saying it plays.
 */
async function reelLineTimings(opts: {
  videoRoot: string;
  manager: StateManager;
  definitions: StageDefinitions;
  direction: Direction;
  animatic: AnimaticDefinition | null;
  lang: string;
  shots: readonly { id: string; start: number }[];
  lineShots: ReadonlySet<string> | null;
  clipsByShot: ReadonlyMap<string, readonly CompositionClip[]>;
}): Promise<Map<string, LineTiming>> {
  const state = opts.manager.getState();
  const hearing = recognizesSpeechIn(opts.lang) ? await loadHearing(opts.lang) : null;
  const out = new Map<string, LineTiming>();
  for (const found of collectShots(opts.direction)) {
    if (opts.lineShots && !opts.lineShots.has(found.id)) continue;
    const script = "script" in found ? (found.script ?? []) : [];
    script.forEach((line, i) => {
      out.set(lineTimingKey(found.id, i + 1), {
        shotId: found.id,
        line: i + 1,
        text: lineText(line),
        take: null,
        charAt: null,
        clipped: null,
        onsets: [],
        sound: null,
        pauses: [],
        takeLines: [],
      });
    });
  }
  for (const shot of opts.shots) {
    for (const clip of opts.clipsByShot.get(shot.id) ?? []) {
      if (!clip.hasAudio) continue;
      const toReel = clipReelClock(clip, shot.start);
      for (const source of spokenSourcesOf(clip, opts)) {
        const said = saidBy(source, opts);
        const variantId = source.variantIds[0];
        if (!said.scripted || !variantId) continue;
        const parsed = tryParseAddress(source.address);
        const owner = parsed?.kind === "shot" ? parsed.shotId : shot.id;
        const media = state.assets[source.address]?.variants?.[variantId]?.media ?? undefined;
        const durationSec = takeDurationSec(media);
        const [from, to] = sourceWindow(clip, shot.start, source, durationSec);
        const reelAt = (t: number) => toReel(source.toMedia(t));
        const plays = (t: number) => t >= from && t < to;
        const heard = hearing
          ? readTakeHeard(opts.videoRoot, state, source.address, variantId)
          : null;
        const aligned =
          heard && hearing
            ? alignHeard(
                said.lines.map((l) => l.text),
                heard,
                hearing,
                durationSec,
              )
            : null;
        const loudness = loudnessOf(media);
        const measured: [number, number] | null =
          loudness?.leadInSec !== undefined && loudness.soundEndSec !== undefined
            ? [
                Math.max(from, reelAt(loudness.leadInSec)),
                Math.min(to, reelAt(loudness.soundEndSec)),
              ]
            : null;
        const sound = measured && measured[1] > measured[0] ? measured : null;
        const pauses = (loudness?.pausesSec ?? [])
          .map(([s, e]): [number, number] => [reelAt(s), reelAt(e)])
          .filter(([s, e]) => sound !== null && s >= sound[0] && e <= sound[1]);
        const onsets = (heard ?? [])
          .map((t) => reelAt(t.startSec))
          .filter(plays)
          .sort((x, y) => x - y);
        const takeLines = said.lines.map((l) => ({ line: l.number, text: l.text }));
        said.lines.forEach((line, k) => {
          const key = lineTimingKey(owner, line.number);
          const prev = out.get(key);
          if (!prev) return;
          const heardAt = aligned
            ? aligned[k]!.secAt.map((s) => (s === null ? null : reelAt(s)))
            : null;
          const charAt = heardAt?.map((t) => (t !== null && plays(t) ? t : null)) ?? null;
          const clipped = heardAt?.map((t) => t !== null && !plays(t)) ?? null;
          const fresh: LineTiming = {
            ...prev,
            take: { address: source.address, variantId },
            charAt,
            clipped,
            onsets,
            sound,
            pauses,
            takeLines,
          };
          const sameTake =
            prev.take?.address === source.address && prev.take.variantId === variantId;
          if (!prev.take || (!sameTake && !prev.charAt && charAt)) {
            out.set(key, fresh);
          } else if (sameTake) {
            // A take split across clips is heard in each: a character takes the clip playing it.
            out.set(key, mergeClips(prev, fresh));
          }
        });
      }
    }
  }
  return out;
}

function mergeClips(a: LineTiming, b: LineTiming): LineTiming {
  const charAt = a.charAt && b.charAt ? a.charAt.map((t, i) => t ?? b.charAt![i] ?? null) : null;
  return {
    ...a,
    charAt,
    clipped:
      charAt?.map((t, i) => t === null && (a.clipped?.[i] || b.clipped?.[i]) === true) ?? null,
    onsets: [...a.onsets, ...b.onsets].sort((x, y) => x - y),
    sound:
      a.sound && b.sound
        ? [Math.min(a.sound[0], b.sound[0]), Math.max(a.sound[1], b.sound[1])]
        : (a.sound ?? b.sound),
    pauses: [...a.pauses, ...b.pauses].sort((x, y) => x[0] - y[0]),
  };
}

const LINE_ATTR = /\sdata-konte-line="([^"]+)"/g;

/**
 * Each script-line `<Subtitle>` entry of the stage's overlay as `[shotId, line, take]`, read off its render
 * from the definition alone; `take` is where the entry splits at that take's pauses.
 */
function overlaySubtitleLines(
  video: StageDefinition,
): { shotId: string; line: number; take: string | null }[] {
  if (!video.overlay) return [];
  const html = renderOverlayBody({
    stage: video.stage,
    overlay: video.overlay,
    fn: video.overlay.fn,
    size: video.format.size,
    typography: video.typography,
    resolvedFiles: {},
  });
  const seen = new Map<string, { shotId: string; line: number; take: string | null }>();
  for (const m of html.matchAll(/<div\b[^>]*>/g)) {
    const line = new RegExp(LINE_ATTR.source).exec(m[0])?.[1];
    if (!line) continue;
    const take = /\sdata-konte-take="([^"]+)"/.exec(m[0])?.[1] ?? null;
    const at = line.lastIndexOf(":");
    seen.set(`${line}|${take}`, {
      shotId: line.slice(0, at),
      line: Number(line.slice(at + 1)),
      take,
    });
  }
  return [...seen.values()];
}

export function overlayLineTimer(manager: StateManager): LineTimer {
  return (video, plan) => overlayLineTimings({ video, manager, plan });
}

const timingsByManager = new WeakMap<StateManager, Map<string, Promise<Map<string, LineTiming>>>>();

/**
 * Where the lines the stage's overlay subtitles are heard on the reel `plan` resolves, the whole
 * timeline's; undefined where the overlay subtitles none.
 */
export async function overlayLineTimings(opts: {
  video: StageDefinition;
  manager: StateManager;
  plan: () => RenderPlan;
}): Promise<ReadonlyMap<string, LineTiming> | undefined> {
  const { video, manager } = opts;
  const shotIds = new Set(overlaySubtitleLines(video).map((l) => l.shotId));
  if (shotIds.size === 0) return undefined;
  const plan = opts.plan();
  const key = JSON.stringify([
    video.stage,
    [...shotIds],
    plan.shots.map((s) => [s.shotId, s.resolvedVariants]),
  ]);
  let cached = timingsByManager.get(manager);
  if (!cached) timingsByManager.set(manager, (cached = new Map()));
  let timings = cached.get(key);
  if (!timings) {
    timings = stageLineTimings(video, manager, plan, shotIds);
    cached.set(key, timings);
  }
  return timings;
}

/**
 * Where the lines of the stage's shots (`shotIds`, else every one) are heard on the reel `plan`
 * resolves.
 */
export async function stageLineTimings(
  video: StageDefinition,
  manager: StateManager,
  plan: RenderPlan,
  shotIds: ReadonlySet<string> | null,
): Promise<Map<string, LineTiming>> {
  const videoRoot = manager.videoRoot;
  const direction = await loadDirectionDefinition(stageEntryPath(videoRoot, "direction"));
  const loaded = await loadStageDefinitions(videoRoot, { tolerant: true });
  const animatic = video.stage === "animatic" ? (video as AnimaticDefinition) : loaded.animatic;
  const starts = overlayShotStarts(video.shots);
  return reelLineTimings({
    videoRoot,
    manager,
    definitions: {
      reference: loaded.reference,
      animatic,
      video: video.stage === "video" ? (video as VideoDefinition) : loaded.video,
    },
    direction,
    animatic,
    lang: video.typography.lang,
    shots: video.shots.map((s) => ({ id: s.id, start: starts.get(s.id) ?? 0 })),
    lineShots: shotIds,
    clipsByShot: buildShotClips(plan, ""),
  });
}

/** A script-line `<Subtitle>` entry split at the pauses of a take other than the one now saying its line. */
export interface StalePauseSplit {
  stage: StageDefinition["stage"];
  shotId: string;
  line: number;
  take: string;
  // The take that says the line on the reel now; null where none does.
  now: string | null;
}

export async function staleSubtitlePauses(
  stages: readonly (StageDefinition | null)[],
  manager: StateManager,
): Promise<StalePauseSplit[]> {
  const out: StalePauseSplit[] = [];
  for (const video of stages) {
    if (!video) continue;
    const split = overlaySubtitleLines(video).filter((l) => l.take !== null);
    if (split.length === 0) continue;
    const timings = await overlayLineTimings({
      video,
      manager,
      plan: () =>
        buildRenderPlan(video, manager, {
          outputDir: "",
          allowUnaccepted: true,
          allowNotReady: true,
        }),
    });
    for (const l of split) {
      const now = timings?.get(lineTimingKey(l.shotId, l.line))?.take?.variantId ?? null;
      if (now !== l.take) {
        out.push({ stage: video.stage, shotId: l.shotId, line: l.line, take: l.take!, now });
      }
    }
  }
  return out;
}
