import type { Stage } from "./address.js";
import { assertNever } from "./assert.js";
import type { Direction } from "./dsl/direction.js";
import { KonteError } from "./errors.js";
import { formatReferenceAddress } from "./address.js";
import { loadDirectionDefinition } from "./loader.js";
import { stageEntryPath } from "./roots.js";
import type { ReferenceDefinition, AnimaticDefinition, VideoDefinition } from "./types/index.js";

// The definitions a command has loaded — one per stage entry. On a piece cut to a song no take of
// is read, the board and the video cannot load until one is: they are null, `songUnread` is the
// stop a command that needs them makes (`requireShotStages`), and `direction` the piece they wait
// on.
export type LoadedDefinitions = { reference: ReferenceDefinition } & (
  | { video: VideoDefinition; animatic: AnimaticDefinition }
  | { video: null; animatic: null; songUnread: KonteError; direction: Direction }
);

export type ShotStageDefinitions = Extract<LoadedDefinitions, { video: VideoDefinition }>;

// The `reference:<id>` of the song the piece is cut to, where it is.
export function songOfDefinitions(defs: LoadedDefinitions): string | undefined {
  if (defs.video) return defs.video.song;
  const song = defs.direction.policy.song;
  return song === undefined ? undefined : formatReferenceAddress(song);
}

// The definitions with the board and the video loaded, else the song they wait on.
export function requireShotStages(defs: LoadedDefinitions): ShotStageDefinitions {
  if (defs.video === null) throw defs.songUnread;
  return defs;
}

// The board and the video `load` reads, or — where they wait on a song no take of is read — null
// in their place, beside what they wait on.
export async function loadShotStages(
  videoRoot: string,
  load: () => Promise<{ video: VideoDefinition; animatic: AnimaticDefinition }>,
): Promise<
  | { video: VideoDefinition; animatic: AnimaticDefinition }
  | { video: null; animatic: null; songUnread: KonteError; direction: Direction }
> {
  try {
    return await load();
  } catch (err) {
    if (!(err instanceof KonteError) || err.code !== "SONG_UNREAD") throw err;
    const direction = await loadDirectionDefinition(stageEntryPath(videoRoot, "direction"));
    return { video: null, animatic: null, songUnread: err, direction };
  }
}

// The active definition for a stage, tagged so callers narrow on `stage` to the concrete
// definition type instead of carrying four nullable variables and `!`-asserting the right one.
type LoadedDefinition =
  | { stage: "reference"; def: ReferenceDefinition }
  | { stage: "animatic"; def: AnimaticDefinition }
  | { stage: "video"; def: VideoDefinition };

// Resolve a stage to its loaded definition, or throw the stage-appropriate not-found error.
// The exhaustive switch makes a new Stage a compile error here — the single place that maps a
// dynamic stage to "which definition", replacing the scattered `stage === "reference" ? …` picks.
export function selectDefinition(stage: Stage, defs: LoadedDefinitions): LoadedDefinition {
  switch (stage) {
    case "reference":
      return { stage, def: defs.reference };
    case "animatic":
      return { stage, def: requireShotStages(defs).animatic };
    case "video":
      return { stage, def: requireShotStages(defs).video };
    case "direction":
      // The direction stage is feedback-only — it has no asset definition to select.
      throw new KonteError(
        "INVALID_ADDRESS",
        "The direction stage has no asset definition — it is a feedback-only stage",
      );
    default:
      return assertNever(stage, "selectDefinition");
  }
}
