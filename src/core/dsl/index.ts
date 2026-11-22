export type { MediaKind, MediaAsset } from "../types/media.js";
export type { ShotAnchor, SoundtrackOptions, SoundtrackEntry } from "../types/soundtrack.js";
import {
  audioConcat,
  audioFile,
  audioRetime,
  audioTrim,
  imageCrop,
  imageFile,
  imageResize,
  jsxImage,
  jsxVideo,
  videoFile,
  videoFrame,
  videoTrim,
  imageOrbit,
} from "./adapters/index.js";
// Runtime only, and not in `adapters` — see the file header.
export {
  internalTestImage,
  internalTestPlate,
  type InternalTestImageInputs,
  type InternalTestPlateInputs,
} from "./adapters/index.js";

export {
  defineVideo,
  soundtrack,
  type HeardStem,
  type OverlayContext,
  type ThumbnailContext,
  type ThumbnailSpec,
  type ShotHandle,
  type StageShots,
} from "./builders.js";
export type {
  ShotOptions,
  ShotInput,
  PendingShotInput,
  AsideShotInput,
  AsideShotOptions,
  AnyShotInput,
} from "./shot-input.js";
export { respell } from "./respell.js";
export {
  asset,
  type AdapterInputs,
  type AdapterOutput,
  type AssetAdapter,
  type AllowedSites,
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
export {
  defineReference,
  type DefineReferenceOptions,
  type ReferenceRef,
  type ReferenceViewRef,
  type ReferenceViews,
} from "./reference-builders.js";
export { definePatch, type PatchBuild, type PatchContext, type PatchDefinition } from "./patch.js";
export type { PromptFinding, PromptFindingCode } from "../prompt-check.js";
export type { PinFinding, PinFindingCode } from "../pin-check.js";
export type { PinOccurrence, PromptOccurrence } from "../types/stage-build.js";
export type { ReferenceDefinition } from "../types/reference.js";
export { imageFile, videoFile, audioFile } from "./adapters/index.js";
export { jsxImage, type JsxImageInputs, type JsxImageCanvas } from "./adapters/index.js";
export { jsxVideo, type JsxVideoInputs } from "./adapters/index.js";
export { imageOrbit, type ImageOrbitInputs } from "./adapters/index.js";
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
  ShotFunction,
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
  Screen,
  Subtitle,
  Video,
  type AudioProps,
  type CutinCorner,
  type CutinProps,
  type ScreenPoint,
  type ScreenProps,
  type AnimateContext,
  type AnimateData,
  type GsapSplit,
  type GsapSplitOptions,
  type GsapTargets,
  type GsapTimeline,
  type ImageProps,
  type PanelProps,
  type SubtitleEntry,
  type SubtitleProps,
  type VideoProps,
} from "./composition/index.js";
export { seed, runInRenderMode, runTimelineInRenderMode } from "./shot-context.js";
export { upscale } from "./delivery-upscale.js";
export type {
  VideoFormat,
  Export,
  Delivery,
  DeliveryUpscaleFn,
  DeliveryUpscaleInput,
  ShotJoin,
} from "../types/definition.js";
export {
  defineAnimatic,
  type DefineAnimaticOptions,
  type SetupIdOf,
  type AnimaticPlates,
  type ShotClockContext,
  type StageChain,
  type StageTerminal,
  type StageTimelineReturn,
} from "./animatic-builders.js";
export type { AnimaticDefinition, AnimaticFormat, PanelDefinition } from "../types/animatic.js";
export type { AnimaticRef, AnimaticShotRef } from "./animatic-ref.js";
export type { Identifier } from "./validate-identifier.js";
export {
  defineDirection,
  deriveShotHinges,
  defineLens,
  type Direction,
  type DirectionEntry,
  type DirectionNode,
  type Pleasure,
  type Character,
  type Voice,
  type Prop,
  type Location,
  type LocationView,
  type LocationViews,
  type Landmark,
  type Setup,
  type Framing,
  type View,
  type DirectionBrief,
  type BriefReference,
  type BriefSource,
  type CanvasSize,
  type DirectionFormat,
  type DirectionPolicy,
  type Shot,
  type NarrativeShot,
  type GraphicShot,
  type AsideShot,
  type ScriptLine,
  type ShotIdOf,
  type ArcItem,
  type LensRole,
  type RoleFunction,
  type LensSpec,
  type DirectionFinding,
  type DirectionFindingCode,
} from "./direction.js";
export { isAsideShot, isGraphicShot } from "./shot-kind.js";
export { lyricText } from "./direction-timeline.js";
export {
  type StageShotStarter,
  type StagePendingShotStarter,
  type StageAsideShotStarter,
  type VideoAsideShotStarter,
} from "./stage-chain.js";
export {
  defineSourceChunk,
  type SourceChunk,
  type SourceScene,
  type SourceLook,
  type SourcePanel,
  type SourcePanelText,
} from "./source.js";
export { checkArc } from "../direction-check.js";
export { BUILTIN_LENSES, findBuiltinLens } from "../lenses.js";

export const adapters = {
  imageFile,
  videoFile,
  audioFile,
  imageResize,
  imageCrop,
  videoTrim,
  audioTrim,
  audioRetime,
  audioConcat,
  videoFrame,
  jsxImage,
  jsxVideo,
  imageOrbit,
};
