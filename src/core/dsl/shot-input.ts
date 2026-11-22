import type { ShotFunction } from "../types/definition.js";

export interface ShotOptions {
  duration: number;
}

interface VideoShotOptions extends ShotOptions {
  action: string;
}

/**
 * One developed shot of either stage: its id, the closure that builds its `<Composition>`, and the
 * shot facts the direction injected.
 */
export interface ShotInput<TId extends string = string> {
  __shotInput: true;
  // A graphic shot's build (`graphicShot`).
  __graphicShot?: true;
  id: TId;
  fn: ShotFunction;
  options: VideoShotOptions;
}

/**
 * An "undeveloped shot" marker that carries no composition/asset/job and nothing of its own; the shot
 * it stands for is the direction's `action`. It lets a stage file mirror the whole direction before
 * every shot is built; preview renders it as a black tile, and export refuses while any remain.
 */
export interface PendingShotInput<TId extends string = string> {
  __shotInput: true;
  __pendingShot: true;
  id: TId;
  options: VideoShotOptions;
}

/**
 * A shot that occupies the clock without being part of the arc (see `AsideShot`). The video
 * authors it like any other shot (`fn` builds the picture, usually a `file`); the animatic never
 * boards it and carries it with no `fn` at all, konte filling that span with a labelled slug.
 */
export interface AsideShotInput<TId extends string = string> {
  __shotInput: true;
  __asideShot: true;
  id: TId;
  fn?: ShotFunction;
  options: AsideShotOptions;
}

export interface AsideShotOptions extends ShotOptions {
  label: string;
}

// Any shot a stage chain may hold. Narrowing helpers below rather than a `kind` field: each reader
// asks the one question it has.
export type AnyShotInput<TId extends string = string> =
  | ShotInput<TId>
  | PendingShotInput<TId>
  | AsideShotInput<TId>;

export function isPendingShotInput(input: AnyShotInput): input is PendingShotInput {
  return "__pendingShot" in input && input.__pendingShot === true;
}

export function isAsideShotInput(input: AnyShotInput): input is AsideShotInput {
  return "__asideShot" in input && input.__asideShot === true;
}
