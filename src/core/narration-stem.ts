import { formatNarrationStemAddress, isNarrationStemAddress } from "./address.js";
import { parsePlaceholder } from "./dsl/shot-context.js";
import { KonteError } from "./errors.js";
import { extractRefs } from "./graph.js";
import {
  isPendingAnimaticShot,
  isPendingShot,
  type AnimaticDefinition,
  type VideoDefinition,
} from "./types/index.js";

// A board shot's `#narrationStem` reaches the video only as a sound: fed to a model it would be
// mouthed, and drawn it is no picture. The type of `.narrationStem` refuses both; this catches what
// routes around the type.
export function assertNarrationStemsHeard(video: VideoDefinition): void {
  const misplaced: string[] = [];
  const check = (refs: readonly string[], where: string): void => {
    for (const ref of refs) {
      if (isNarrationStemAddress(ref)) misplaced.push(`  ${ref} — ${where}`);
    }
  };
  for (const shot of video.shots) {
    for (const [name, entry] of Object.entries(shot.assets)) {
      check(extractRefs(entry), `input of video:shot.${shot.id}.${name}`);
    }
    check(shot.pictureRefs ?? [], `picture of video:shot.${shot.id}`);
  }
  for (const [name, entry] of Object.entries(video.topLevelAssets ?? {})) {
    check(extractRefs(entry), `input of video:timeline.${name}`);
  }
  for (const soundtrack of video.timelineSoundtracks ?? []) {
    const src = parsePlaceholder(soundtrack.src.src);
    if (src) check([src], `soundtrack "${soundtrack.id}"`);
  }
  if (misplaced.length === 0) return;
  throw new KonteError(
    "ANIMATIC_INVALID",
    `A board shot's narration stem is placed only with <Audio> in a video shot's composition:\n` +
      `${misplaced.join("\n")}\n` +
      `Nothing on screen speaks the narration, so it drives no model and draws no picture.`,
  );
}

// Every narration the board mixes is delivered: a developed video shot over a narrated shot means
// the video places that shot's `#narrationStem` somewhere. A `pendingShot` stands in with the board,
// narration included, so it owes nothing yet. Checked wherever the two stages are loaded together,
// since a video built from `file`/`local` media never reaches the board at all.
export function assertNarrationStemsPlaced(
  video: VideoDefinition,
  board: AnimaticDefinition,
): void {
  const placed = new Set(video.shots.flatMap((shot) => shot.stemRefs ?? []));
  const videoShots = new Map(video.shots.map((shot) => [shot.id, shot]));
  const unplaced = board.shots.filter((shot) => {
    if (isPendingAnimaticShot(shot) || (shot.narrationStemRefs?.length ?? 0) === 0) return false;
    const videoShot = videoShots.get(shot.id);
    if (!videoShot || isPendingShot(videoShot)) return false;
    return !placed.has(formatNarrationStemAddress(shot.id));
  });
  if (unplaced.length === 0) return;
  throw new KonteError(
    "NARRATION_UNPLACED",
    `video.tsx never places the narration of ${unplaced.length} board shot(s):\n` +
      unplaced
        .map((shot) => `  ${formatNarrationStemAddress(shot.id)} — video:shot.${shot.id}`)
        .join("\n") +
      `\nPlace each with <Audio src={animatic.shot("<id>").narrationStem} /> in a video shot's ` +
      `composition — usually that shot's own; its start and volume are yours there.`,
  );
}
