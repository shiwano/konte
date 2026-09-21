import type {
  AnyShotInput,
  AsideShotInput,
  PendingShotInput,
  ShotInput,
  ShotOptions,
  SoundtrackEntry,
} from "../../dsl/builders.js";
import { defineDirection } from "../../dsl/direction.js";
import {
  getDirectionIndex,
  makeAnimaticShotStarter,
  makeVideoShotStarter,
} from "../../dsl/direction.js";
import { directionDefaults, testDirection } from "./direction.js";
import { defineAnimatic } from "../../dsl/animatic-builders.js";
import { defineReference } from "../../dsl/reference-builders.js";
import type { AnimaticDefinition, ReferenceDefinition } from "../../types/index.js";
import type { ShotFunction } from "../../dsl/shot-context.js";
import type { StageTimelineReturn, StageTerminal } from "../../dsl/animatic-builders.js";
import type { Identifier } from "../../dsl/validate-identifier.js";

// Test-only `shot()` constructor. The production DSL mints stage shots through the stage-bound
// `shot` starter that `defineAnimatic`/`defineVideo` inject, which pins the id to the direction and
// injects its duration. Tests still want the terse `shot(id, { duration, … })` form, so this builds
// a one-shot inline direction carrying the per-call duration and delegates to that direction's
// starter. The starter returns a chain-of-one; this unwraps it back to the bare shot input so a test
// can assemble several with `stageTimeline([...])`, mirroring what a real `shot(first).nextShot(…)`
// walk would produce.
//
// Stage-neutral: a `ShotInput` carries no stage — both composition stages author a shot the same
// way, and the ambient discovery context `defineStage` sets is what decides which addresses its
// `asset()` calls mint.
export function shot<TId extends string>(
  id: TId & Identifier<TId>,
  options: ShotOptions & {
    action?: string;
    build: (ctx: { duration: number }) => ReturnType<ShotFunction>;
  },
): ShotInput<TId> {
  const { duration, action = "test shot", build } = options;
  const index = getDirectionIndex(inlineDirection(id, action, duration));
  return makeVideoShotStarter(index).shot(
    id,
    build as (ctx: { duration: number }) => ReturnType<ShotFunction>,
  ).__shots[0]! as ShotInput<TId>;
}

// Test-only terse `pendingShot(id, { duration })` — mints an undeveloped shot the same way `shot()`
// mints a developed one, via the starter's `pendingShot` (which starts a chain carrying the single
// shot in `__shots`); this unwraps it back to the bare `PendingShotInput`.
export function pendingShot<TId extends string>(
  id: TId & Identifier<TId>,
  options: { duration: number; action?: string },
): PendingShotInput<TId> {
  const { duration, action = "test shot" } = options;
  const index = getDirectionIndex(inlineDirection(id, action, duration));
  return makeVideoShotStarter(index).pendingShot(id).__shots[0] as PendingShotInput<TId>;
}

export const pendingAnimaticShot = pendingShot;

// Test-only terse `asideShot(id, { duration, label })` — the board's form, which takes no build, so
// what it mints is a span konte fills with its own slug. Pass `build` for the video's form.
export function asideShot<TId extends string>(
  id: TId & Identifier<TId>,
  options: {
    duration: number;
    label?: string;
    build?: (ctx: { duration: number; label: string }) => ReturnType<ShotFunction>;
  },
): AsideShotInput<TId> {
  const { duration, label = "test aside", build } = options;
  const index = getDirectionIndex(inlineAsideDirection(id, label, duration));
  const starter = build ? makeVideoShotStarter(index) : makeAnimaticShotStarter(index);
  return (starter.asideShot as (i: string, b?: unknown) => { __shots: unknown[] })(id, build)
    .__shots[0] as AsideShotInput<TId>;
}

function inlineDirection(id: string, action: string, duration: number) {
  return defineDirection({
    ...directionDefaults,
    sequence: {
      lens: "mini-drama",
      pleasure: "cute",
      shots: [{ id, role: "hero", action, setup: "front", duration, lineup: [] }],
    },
  });
}

function inlineAsideDirection(id: string, label: string, duration: number) {
  return defineDirection({
    ...directionDefaults,
    sequence: {
      lens: "mini-drama",
      pleasure: "cute",
      shots: [{ kind: "aside", id, label, duration }],
    },
  });
}

// Stand-in movement for a panel whose staging the test does not care about, for a test that needs a
// bound panel — one the review gates let through.
export const moves = { blocking: "she steps to the window", camera: "fixed" } as const;

// Test-only assembler: wrap bare shot inputs into the `{ shots, soundtracks? }` terminal shape a
// stage's `timeline` expects, without walking a real multi-shot direction. Bypasses the
// direction-order/completeness type gate (exercised separately in the type-inference tests), letting
// a test declare an arbitrary shot list terse-ly.
export function stageTimeline<const TShots extends readonly AnyShotInput[]>(
  shots: TShots,
  soundtracks?: readonly SoundtrackEntry<TShots[number]["id"]>[],
): StageTimelineReturn<TShots[number]["id"]> {
  const terminal = {
    __complete: true,
    __shots: shots,
    __shotIds: undefined,
  } as unknown as StageTerminal<TShots[number]["id"]>;
  return soundtracks ? { shots: terminal, soundtracks } : { shots: terminal };
}

export const videoTimeline = stageTimeline;
export const animaticTimeline = stageTimeline;

// A board with no shots: what a test hands to something that requires an `animatic` but does not
// exercise it.
export function emptyAnimatic(): AnimaticDefinition {
  return defineAnimatic(testDirection(directionDefaults.policy.format), {
    timeline: () => ({ shots: [] }),
  });
}

// An empty shared pool: what a test hands to something that requires a `reference` but does not
// exercise it.
export function emptyReference(): ReferenceDefinition {
  return defineReference(testDirection(directionDefaults.policy.format), () => ({}));
}
