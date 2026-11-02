// A prompt of a shot naming a landmark of its location that the shot's setup does not hold. A shot
// whose frame moves by declaration — `coverage`, `lineupTo` — is not read.

import { tryParseAddress } from "./address.js";
import { collectShotFrames, setupHolds } from "./direction.js";
import type { Direction } from "./dsl/direction.js";
import type { ImageInputOccurrence } from "./image-inputs.js";
import type { PromptOccurrence } from "./prompt-check.js";

export type UnheldLandmark = {
  address: string;
  shotId: string;
  setups: readonly string[];
  landmarkId: string;
  promptDepiction: string;
};

type ShotLandmarks = {
  setups: string[];
  held: string[];
  unheld: { id: string; promptDepiction: string }[];
};

// A shot's frames together: a cutin's holds count for the whole shot, since a take's prompt cannot
// be told to one lane.
function shotLandmarks(direction: Direction): Map<string, ShotLandmarks | null> {
  const out = new Map<string, ShotLandmarks | null>();
  for (const frame of collectShotFrames(direction)) {
    if (out.get(frame.shotId) === null) continue;
    const setup = direction.setups?.[frame.setup];
    const holds = setupHolds(direction, frame.setup);
    if (frame.coverage || frame.lineupTo || !setup || !holds) {
      out.set(frame.shotId, null);
      continue;
    }
    const entry = out.get(frame.shotId) ?? { setups: [], held: [], unheld: [] };
    entry.setups.push(frame.setup);
    entry.held.push(
      ...holds.flatMap(({ landmark }) => (landmark ? [landmark.promptDepiction] : [])),
    );
    const heldIds = new Set(holds.map(({ id }) => id));
    for (const [id, landmark] of Object.entries(
      direction.locations?.[setup.location]?.landmarks ?? {},
    )) {
      if (!heldIds.has(id)) entry.unheld.push({ id, promptDepiction: landmark.promptDepiction });
    }
    out.set(frame.shotId, entry);
  }
  for (const entry of out.values()) {
    if (!entry) continue;
    const held = new Set(entry.setups.flatMap((s) => direction.setups?.[s]?.holds ?? []));
    entry.unheld = entry.unheld.filter(
      (landmark, i, all) =>
        !held.has(landmark.id) && all.findIndex((other) => other.id === landmark.id) === i,
    );
  }
  return out;
}

// A depiction as whole words, so "door" is not read inside "outdoor". An edge in a script written
// without spaces takes no boundary. Null for a blank one.
function depictionPattern(depiction: string): RegExp | null {
  const words = depiction.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return null;
  const body = words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("\\s+");
  const spaced = /[\p{Script=Latin}\p{N}]/u;
  const before = spaced.test(words[0]!.at(0)!) ? "(?<![\\p{L}\\p{N}])" : "";
  const after = spaced.test(words.at(-1)!.at(-1)!) ? "(?![\\p{L}\\p{N}])" : "";
  return new RegExp(`${before}${body}${after}`, "giu");
}

// A held depiction is cut out first, so an unheld one it contains ("door" in "front door") is not
// read inside it.
function withoutHeld(text: string, held: readonly string[]): string {
  return held.reduce((out, depiction) => {
    const pattern = depictionPattern(depiction);
    return pattern ? out.replace(pattern, " ") : out;
  }, text);
}

// The declarations handed another shot's frame: their prompt writes that frame too.
function cutAddresses(imageInputs: readonly ImageInputOccurrence[]): Set<string> {
  const out = new Set<string>();
  for (const { address, sources } of imageInputs) {
    const own = tryParseAddress(address);
    if (own?.kind !== "shot") continue;
    for (const source of sources) {
      const from = tryParseAddress(source);
      if (from?.kind === "shot" && from.shotId !== own.shotId) out.add(address);
    }
  }
  return out;
}

export function findUnheldLandmarks(
  direction: Direction,
  prompts: readonly PromptOccurrence[],
  imageInputs: readonly ImageInputOccurrence[],
): UnheldLandmark[] {
  const landmarks = shotLandmarks(direction);
  const cuts = cutAddresses(imageInputs);
  const out: UnheldLandmark[] = [];
  const seen = new Set<string>();
  for (const prompt of prompts) {
    if (prompt.negative || prompt.spoken || prompt.media === "audio") continue;
    const parsed = tryParseAddress(prompt.address);
    if (!parsed || parsed.kind !== "shot" || parsed.stage === "reference") continue;
    const shot = landmarks.get(parsed.shotId);
    if (!shot || cuts.has(prompt.address)) continue;
    const said = prompt.spokenMarks ?? prompt.spokenWithin ?? [];
    const text = withoutHeld(
      said.reduce((out, line) => out.split(line).join(" "), prompt.value),
      shot.held,
    );
    for (const landmark of shot.unheld) {
      const pattern = depictionPattern(landmark.promptDepiction);
      if (!pattern?.test(text)) continue;
      const key = `${prompt.address}\0${landmark.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        address: prompt.address,
        shotId: parsed.shotId,
        setups: shot.setups,
        landmarkId: landmark.id,
        promptDepiction: landmark.promptDepiction,
      });
    }
  }
  return out;
}
