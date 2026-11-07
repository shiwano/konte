// A video take driven by a board stem whose lines no one in the shot's frame speaks.

import { formatShotStemAddress, tryParseAddress } from "./address.js";
import { collectArcShots, shotFrames } from "./direction.js";
import { type Direction, isGraphicShot } from "./dsl/direction.js";
import {
  isPendingAnimaticShot,
  isPendingShot,
  type AnimaticDefinition,
  type VideoDefinition,
} from "./types/index.js";

export type UnmouthedStem = {
  address: string;
  shotId: string;
  speakers: readonly string[];
};

function offFrameSpeakers(direction: Direction): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const shot of collectArcShots(direction)) {
    if (isGraphicShot(shot) || shot.coverage) continue;
    const lines = (shot.script ?? []).filter((line) => !("narration" in line));
    if (lines.length === 0 || lines.some((line) => !("character" in line))) continue;
    const inFrame = new Set(
      shotFrames(shot).flatMap((f) => [...f.lineup, ...(f.lineupTo ?? []), ...(f.passing ?? [])]),
    );
    const speakers = [
      ...new Set(lines.flatMap((line) => ("character" in line ? [line.character] : []))),
    ];
    if (speakers.some((id) => inFrame.has(id))) continue;
    out.set(shot.id, speakers);
  }
  return out;
}

export function findUnmouthedStems(
  direction: Direction,
  animatic: AnimaticDefinition,
  video: VideoDefinition,
): UnmouthedStem[] {
  const speakersById = offFrameSpeakers(direction);
  const voiceOnly = new Set(
    animatic.shots.flatMap((shot) => {
      if (isPendingAnimaticShot(shot) || shot.songCue) return [];
      const refs = shot.stemRefs ?? [];
      const kinds = shot.cueKinds ?? {};
      return refs.length > 0 && refs.every((ref) => kinds[ref] === "voice") ? [shot.id] : [];
    }),
  );
  const shots = new Map(video.shots.map((shot) => [shot.id, shot]));
  return (video.stemInputs ?? []).flatMap((occurrence): UnmouthedStem[] => {
    const shotId = [...speakersById.keys()].find(
      (id) => occurrence.source === formatShotStemAddress("animatic", id),
    );
    const shot = shotId === undefined ? undefined : shots.get(shotId);
    if (!shotId || !shot || isPendingShot(shot) || !voiceOnly.has(shotId)) return [];
    const at = tryParseAddress(occurrence.address);
    const inShot =
      at?.stage === "video" &&
      (at.kind === "shot"
        ? at.shotId === shotId
        : at.kind === "timeline" && (shot.pictureRefs ?? []).includes(occurrence.address));
    if (!inShot) return [];
    return [{ address: occurrence.address, shotId, speakers: speakersById.get(shotId)! }];
  });
}
