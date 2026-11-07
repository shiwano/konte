import type { DirectionErrorCode } from "../direction.js";
import type { DirectionFindingCode } from "../direction-check.js";
import type { FindingCode } from "../finding.js";

const VOUCH_TAKE =
  "dismiss the take (reroll for another beside it), or `konte vouch <variantId>` once you have " +
  "heard it is fine";

export const OTHER_FINDING_REMEDY: Record<
  Exclude<FindingCode, DirectionFindingCode | DirectionErrorCode>,
  string
> = {
  "prompt-negation": "describe what occupies the space instead of naming what to leave out",
  "prompt-not-yet": "describe the state the frame is in instead of what has not happened",
  "prompt-double-negative": "keep the term, drop the negation",
  "landmark-unheld":
    "describe only what the frame holds, or add the landmark to the `holds` of the setup where " +
    "the frame carries it",
  "pin-unanchored":
    "pin a frame of the picture: pass a reference sheet as an ordinary reference input and pin " +
    "the board panel the shot develops; for a plate, pin the panel that stands on that plate",
  "class-font-family": "declare the font family on `direction.policy.fonts`",
  "composition-class-font-family": "declare the font family on `direction.policy.fonts`",
  "movement-unwritten": "write the missing `blocking` / `camera` from the output of the take named",
  "take-silent": VOUCH_TAKE,
  "line-misheard": VOUCH_TAKE,
  "line-truncated":
    "where a retime is named, put that cue through `adapters.audioRetime` with the duration given " +
    "and play that in its place; else lengthen the shot's `duration` in direction.ts or shorten " +
    "its script",
  "tail-silent":
    "set the shot's `duration` in direction.ts to the fit given, fill the tail with sound, or " +
    "`konte vouch <shot address>` for a hold the picture needs",
  "animatic-unconsumed":
    "build the video shot from its own board shot (a panel image, `.stem` — not " +
    "`.narrationStem` / `.offFrameStem`) in video.tsx, developing that board shot first if it is still a " +
    'pendingShot, or leave it as `pendingShot("<id>")` until it is wired',
  "stem-unmouthed":
    "the take is driven by its board shot's stem, yet no mouth in the frame speaks the lines. " +
    "Drive the take without the stem and its lines, and place the stem with " +
    '<Audio src={animatic.shot("<id>").stem} /> in the shot\'s composition',
  "stem-unplaced":
    "place the stem with the `<Audio>` given in a video shot's composition, usually that shot's " +
    "own; its start and volume are yours there",
  "subtitle-pauses-stale":
    "read the pauses of the take named with `konte probe reel-lines`, then write its id as the entry's " +
    "`take` and the pauses its texts break at",
  "script-unvoiced":
    "give every line the direction gives the shot an `<Audio>` carrying it in its " +
    '`<Composition>`: in animatic.tsx `<Audio src={asset("vo", …)}>`, or move the words to ' +
    "`telop` if nobody says them, and for a model that misreads the words " +
    '`respell(script.<who>[n], "…")` in their place; on `policy.song`, in video.tsx ' +
    '`<Audio src={animatic.shot("<id>").audio("<name>")} start={…}>` where the animatic places ' +
    "it, or the reference voice it was made from",
  "cutin-required":
    "place the wipe's `<Panel>` (animatic) / `<Video>` (video) inside `<Cutin>`, or drop the " +
    "shot's `cutin` from direction.ts",
  "cutin-undeclared":
    "declare the shot's `cutin` (`cutin: { setup, lineup }`) in direction.ts, or place the layer " +
    "as an `<Image>` instead",
  "plate-undeclared-setup": "file the plate under a setup direction.ts declares",
  "soundtrack-anchor-unknown":
    "anchor the soundtrack's `from` / `until` to a shot the timeline holds",
  "pending-reference":
    "develop the `pendingShot` it is built on; until then the asset and what is built on it " +
    "wait, and the rest of the stage spends",
  "source-locator-out-of-range":
    "fix it in the file named: point the locator at a chunk `konte source import` counted, or " +
    "import the source with `konte source import <kind> <file>`",
};
