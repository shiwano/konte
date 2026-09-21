export type {
  ComfyAssetDefinition,
  FalAssetDefinition,
  FileAssetDefinition,
  LocalAssetDefinition,
  AssetDefinition,
  ShotDefinition,
  VideoDefinition,
  VideoFormat,
  Export,
  Delivery,
  DeliveryUpscaleFn,
  DeliveryUpscaleInput,
} from "../types/definition.js";
export type { TrimInputs, AudioRetimeInputs } from "./adapters/index.js";
export type { AnimaticDefinition, AnimaticFormat, PanelDefinition } from "../types/animatic.js";
export type {
  MediaKind,
  MediaAsset,
  NarrationStem,
  ShotInput,
  PendingShotInput,
  AsideShotInput,
  AsideShotOptions,
  AnyShotInput,
  ShotOptions,
  ShotAnchor,
  SoundtrackOptions,
  SoundtrackEntry,
  ShotHandle,
  StageShots,
  DefineVideoOptions,
} from "./builders.js";
export { defineVideo, soundtrack } from "./builders.js";
export { respell } from "./respell.js";
export {
  defineDirection,
  defineLens,
  isAsideShot,
  isGraphicShot,
  type StageShotStarter,
  type StagePendingShotStarter,
  type StageAsideShotStarter,
  type VideoAsideShotStarter,
  type Direction,
  type DirectionEntry,
  type DirectionNode,
  type Pleasure,
  type Character,
  type Voice,
  type Prop,
  type Location,
  type Landmark,
  type Setup,
  type Framing,
  type DirectionBrief,
  type CanvasSize,
  type DirectionFormat,
  type SpeechPolicy,
  type DirectionPolicy,
  type Shot,
  type NarrativeShot,
  type GraphicShot,
  type AsideShot,
  type ScriptLine,
  type ShotIdOf,
  type ArcItem,
  type Beat,
  type BeatFunction,
  type LensSpec,
  type DirectionFinding,
  type DirectionFindingCode,
} from "./direction.js";
export { jsxImage, type JsxImageInputs, type JsxImageCanvas } from "./adapters/index.js";
export { upscale } from "./delivery-upscale.js";
export {
  asset,
  type AdapterInputs,
  type AdapterOutput,
  type AssetAdapter,
  type AssetDeclarationSite,
} from "./adapter.js";
export {
  promptReferenceTags,
  minimaxH3Prompt,
  minimaxH3CutSource,
  minimaxH3Dialogue,
  inertInputs,
  requireOneOf,
  type AdapterValidator,
  type AdapterValidatorContext,
  type PromptReferenceTagsSpec,
  type PromptTagSlots,
  type MinimaxH3Mode,
  type MinimaxH3PromptSpec,
  type InertInputsSpec,
  type InputMatch,
  type RequireOneOfSpec,
  type UnsetValue,
} from "./validators/index.js";
export { imageFile, videoFile, audioFile } from "./adapters/index.js";
export { checkArc } from "../direction-check.js";
export { BUILTIN_LENSES, findBuiltinLens } from "../lenses.js";
export {
  defineReference,
  type DefineReferenceOptions,
  type ReferenceRef,
} from "./reference-builders.js";
export { definePatch, type PatchBuild, type PatchContext, type PatchDefinition } from "./patch.js";
export type { PromptFinding, PromptFindingCode, PromptOccurrence } from "../prompt-check.js";
export type { PinFinding, PinFindingCode, PinOccurrence } from "../pin-check.js";
export type { ReferenceDefinition } from "../types/reference.js";
export {
  defineComfyAsset,
  type AdapterInputDef,
  type AdapterInputGrid,
  type AdapterInputType,
  type AdapterOutputDef,
  type ComfyAssetConfig,
} from "./comfy-asset.js";
export type {
  ComfyModelDeclaration,
  ComfyModelType,
  ComfyNodeDeclaration,
} from "../types/definition.js";
export {
  formatCutTime,
  type PromptStructure,
  type PromptStructureField,
  type PromptStructureValue,
} from "./prompt-structure.js";
export {
  defineFalAsset,
  type FalInputDef,
  type FalInputType,
  type FalAssetConfig,
} from "./fal-asset.js";
export {
  Animate,
  Audio,
  Composition,
  Cutin,
  Image,
  Panel,
  Subtitle,
  Video,
  type AudioProps,
  type CutinCorner,
  type CutinProps,
  type GsapTimeline,
  type ImageProps,
  type PanelProps,
  type SubtitleEntry,
  type SubtitleProps,
  type VideoProps,
} from "./composition/index.js";
export type { ShotFunction } from "./shot-context.js";
export {
  defineAnimatic,
  type DefineAnimaticOptions,
  type SetupIdOf,
  type AnimaticPlates,
  type StageShotContext,
  type AsideShotContext,
  type NarrativeIdOf,
  type AsideIdOf,
  type StageChain,
  type StageTerminal,
  type StageTimelineReturn,
  type DirectionIdTuple,
  type FirstShotId,
  type ChainRest,
  type Head,
  type Tail,
  type ScriptOf,
} from "./animatic-builders.js";
export type { AnimaticRef, AnimaticShotRef } from "./animatic-ref.js";
import {
  audioFile,
  audioRetime,
  audioTrim,
  imageCrop,
  imageFile,
  imageResize,
  jsxImage,
  videoFile,
  videoFrame,
  videoTrim,
} from "./adapters/index.js";

export const adapters = {
  imageFile,
  videoFile,
  audioFile,
  imageResize,
  imageCrop,
  videoTrim,
  audioTrim,
  audioRetime,
  videoFrame,
  jsxImage,
};
export function seed(): string & { readonly __brand: "KontePlaceholder" } {
  return "" as any;
}
