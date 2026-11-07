import {
  formatAddress,
  formatShotAddress,
  isHeardStemAddress,
  isNarrationStemAddress,
  listShotStems,
} from "./address.js";
import { parsePlaceholder } from "./dsl/shot-context.js";
import { KonteError } from "./errors.js";
import { extractRefs } from "./graph.js";
import {
  isPendingAnimaticShot,
  isPendingShot,
  type AnimaticDefinition,
  type VideoDefinition,
} from "./types/index.js";

// A board shot's `#narrationStem` / `#offFrameStem` reaches the video only as a sound: fed to a
// model it would be mouthed, and drawn it is no picture. The type of `.narrationStem` /
// `.offFrameStem` refuses both; this catches what routes around the type.
export function assertHeardStemsHeard(video: VideoDefinition): void {
  const misplaced: string[] = [];
  const check = (refs: readonly string[], where: string): void => {
    for (const ref of refs) {
      if (isHeardStemAddress(ref)) misplaced.push(`  ${ref} — ${where}`);
    }
  };
  for (const shot of video.shots) {
    for (const [name, entry] of Object.entries(shot.assets)) {
      check(extractRefs(entry), `input of ${formatAddress("video", shot.id, name)}`);
    }
    check(shot.pictureRefs ?? [], `picture of ${formatShotAddress("video", shot.id)}`);
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
    `${misplaced.length} board shot narration / off-frame stem(s) are used as something other ` +
      "than a sound — place each only with <Audio> in a video shot's composition",
    misplaced,
  );
}

export type UnplacedStem = {
  // `animatic:shot.<id>#narrationStem` / `#offFrameStem`.
  address: string;
  shotId: string;
  accessor: "narrationStem" | "offFrameStem";
};

// The heard stems no video shot places: a developed video shot over a board shot with lines no
// mouth in its frame speaks places each of them somewhere. A `pendingShot` stands in with the
// board, those lines included, so it owes nothing yet.
export function findUnplacedStems(
  video: VideoDefinition,
  board: AnimaticDefinition,
): UnplacedStem[] {
  const placed = new Set(video.shots.flatMap((shot) => shot.stemRefs ?? []));
  const videoShots = new Map(video.shots.map((shot) => [shot.id, shot]));
  return board.shots.flatMap((shot): UnplacedStem[] => {
    if (isPendingAnimaticShot(shot)) return [];
    const videoShot = videoShots.get(shot.id);
    if (!videoShot || isPendingShot(videoShot)) return [];
    return listShotStems("animatic", shot)
      .filter((stem) => isHeardStemAddress(stem.address) && !placed.has(stem.address))
      .map((stem) => ({
        address: stem.address,
        shotId: shot.id,
        accessor: isNarrationStemAddress(stem.address) ? "narrationStem" : "offFrameStem",
      }));
  });
}
