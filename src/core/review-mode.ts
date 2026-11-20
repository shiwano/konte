import type { Stage } from "./address.js";

export const REVIEW_STAGES = [
  "video",
  "animatic",
  "reference",
  "direction",
] as const satisfies readonly Stage[];

export type ReviewMode = `${Stage}-preview`;

export const REVIEW_MODES = REVIEW_STAGES.map(reviewModeOf) as [ReviewMode, ...ReviewMode[]];

export function reviewModeOf<S extends Stage>(stage: S): `${S}-preview` {
  return `${stage}-preview`;
}

export function reviewStageOf<M extends ReviewMode>(
  mode: M,
): M extends `${infer S extends Stage}-preview` ? S : never {
  return mode.slice(0, -"-preview".length) as never;
}

export function isReviewStage(value: unknown): value is Stage {
  return (REVIEW_STAGES as readonly unknown[]).includes(value);
}

// A submit body names the stage it reviews, beside the stage's own fields.
export const SUBMIT_PATH = "/api/submit";
