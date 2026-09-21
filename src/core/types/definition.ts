import { z } from "zod";
import type { PinOccurrence } from "../pin-check.js";
import type { ImageInputOccurrence } from "../image-inputs.js";
import type { PromptOccurrence } from "../prompt-check.js";
import { FONT_FAMILY_PATTERN, isLanguageTag, type LanguageTag } from "../typography.js";
import type { MediaAsset, SoundtrackEntry } from "../dsl/builders.js";
import type { ShotFunction } from "../dsl/shot-context.js";

export const ComfyModelTypeSchema = z.enum([
  "checkpoint",
  "lora",
  "VAE",
  "clip",
  "diffusion_model",
  "controlnet",
  "upscale",
  "embeddings",
  "clip_vision",
  "unet",
]);
export type ComfyModelType = z.infer<typeof ComfyModelTypeSchema>;

export const ComfyModelDeclarationSchema = z.object({
  filename: z.string(),
  type: ComfyModelTypeSchema,
  // The loader node that reads this file, when the adapter knows it. Its only job is to say which
  // optional branch owns the weights: if that node is pruned (an omitted `branch` input), the
  // declaration goes with it and konte provisions nothing for a branch that is not in the graph.
  // Left unset the model is always provisioned, which is the safe direction and the old behaviour.
  nodeId: z.string().optional(),
  // URL may contain `${VAR_NAME}` placeholders resolved at runtime against
  // process.env (the workspace's credentials are loaded into it).
  url: z.string(),
  savePath: z.string().optional(),
  base: z.string().optional(),
  displayName: z.string().optional(),
});
export type ComfyModelDeclaration = z.infer<typeof ComfyModelDeclarationSchema>;

export const ComfyNodeDeclarationSchema = z.object({
  // ComfyUI-Manager registry id (cnr_id), and the `custom_nodes` directory name a pack outside
  // the registry must be installed under.
  id: z.string(),
});
export type ComfyNodeDeclaration = z.infer<typeof ComfyNodeDeclarationSchema>;

// The verdict axis every asset kind carries.
//
//   deterministic — one outcome for one input. There is nothing to pick among, so `reroll` and
//     `dismiss` refuse, and `generate` re-bakes a stale take over whatever its accept says.
const VerdictAxes = {
  deterministic: z.boolean().optional(),
};

// The axis names, for `computeDefinitionHash` to strip. Derived from the shape above rather than
// written out again, so a second axis added there is excluded from the hash by that edit alone.
export const VERDICT_AXIS_KEYS = Object.keys(VerdictAxes) as ReadonlyArray<
  keyof typeof VerdictAxes
>;

// Which declared adapter input wrote each key of `inputs`: the backend's own key — `<nodeId>.<field>`
// for comfy, the provider field path for fal — mapped to the name the adapter declares it under. A
// built definition is keyed the backend's way (`136.prompt`), which names nothing a reader can act
// on. `also` targets and a pruned branch's keys follow their input, so the map and `inputs` always
// name the same set. A local asset declares none — its inputs already carry the adapter's names.
const InputLabelsSchema = z.record(z.string(), z.string()).optional();

// What a turbo take sends over `inputs` — an adapter's `turbo`, keyed as `inputs` is. Only the take
// reserved as the address's first (`isTurboTake`) reads it, at submission.
const TurboInputsSchema = z.record(z.string(), z.unknown()).optional();

// Every definition field no backend reads, stripped before hashing (see `computeDefinitionHash`).
// `turboInputs` is read by a turbo take, yet stays out: a turbo take and the ones after it are one
// definition, so the second take never ages out the first.
export const NON_GENERATIVE_KEYS: ReadonlyArray<string> = [
  ...VERDICT_AXIS_KEYS,
  "inputLabels",
  "turboInputs",
];

export const ComfyAssetDefinitionSchema = z.object({
  kind: z.literal("comfy"),
  workflow: z.string(),
  inputs: z.record(z.string(), z.unknown()),
  prunedNodes: z.array(z.string()).optional(),
  // Which of `prunedNodes` are pass-throughs, and on which input socket: `<nodeId>` → the input
  // whose source stands in for that node's output. An edge into such a node re-points at that
  // source rather than being dropped, which is what lets an optional branch be spliced out of a
  // chain (a ControlNet on the model line) and not just lopped off its end.
  prunedPassThroughs: z.record(z.string(), z.string()).optional(),
  outputNodeId: z.string().optional(),
  models: z.array(ComfyModelDeclarationSchema).optional(),
  nodes: z.array(ComfyNodeDeclarationSchema).optional(),
  inputLabels: InputLabelsSchema,
  turboInputs: TurboInputsSchema,
  ...VerdictAxes,
});

export type ComfyAssetDefinition = z.infer<typeof ComfyAssetDefinitionSchema>;

export const FileAssetDefinitionSchema = z.object({
  kind: z.literal("file"),
  path: z.string(),
  type: z.enum(["image", "video", "audio"]).optional(),
  ...VerdictAxes,
});
export type FileAssetDefinition = z.infer<typeof FileAssetDefinitionSchema>;

export const FalAssetDefinitionSchema = z.object({
  kind: z.literal("fal"),
  endpointId: z.string(),
  mediaType: z.enum(["image", "video", "audio"]),
  inputs: z.record(z.string(), z.unknown()),
  inputLabels: InputLabelsSchema,
  turboInputs: TurboInputsSchema,
  ...VerdictAxes,
});

export type FalAssetDefinition = z.infer<typeof FalAssetDefinitionSchema>;

export const LocalAssetDefinitionSchema = z.object({
  kind: z.literal("local"),
  operation: z.enum(["resize", "crop", "blank", "trim", "retime", "frame", "render"]),
  mediaType: z.enum(["image", "video", "audio"]),
  inputs: z.record(z.string(), z.unknown()),
  ...VerdictAxes,
});

export type LocalAssetDefinition = z.infer<typeof LocalAssetDefinitionSchema>;

export const AssetDefinitionSchema = z.discriminatedUnion("kind", [
  ComfyAssetDefinitionSchema,
  FileAssetDefinitionSchema,
  FalAssetDefinitionSchema,
  LocalAssetDefinitionSchema,
]);

export type AssetDefinition = z.infer<typeof AssetDefinitionSchema>;

/**
 * One keyframe of an ANIMATIC shot — what a `<Panel>` in its composition declared.
 */
export const PanelDefinitionSchema = z.object({
  // The part name — the leaf of `assetPath`. What the review page labels the frame with, and what
  // the contact sheet frames.
  assetName: z.string(),
  // The panel's resolved asset path — exactly one of `animatic:shot.<id>.<name>`,
  // `animatic:timeline.<name>`, or `reference:<name>`. Carries the scope the leaf `assetName`
  // alone loses, so every consumer resolves the panel's real target instead of guessing by name.
  assetPath: z.string(),
  // The window the panel holds, in shot-local seconds — resolved by `defineAnimatic` from the
  // declared `<Panel start>`s (absent ones divide the shot's duration equally) and the shot's end.
  // Display only: the video stage reads a panel as a keyframe image, never its cut position.
  start: z.number(),
  duration: z.number(),
  // The subject movement carrying THIS frame to the next one — or, when it is the shot's only
  // frame, to the shot's end. The transit, not either endpoint. Written from the take that came
  // back, so it is absent until bound; the last panel of a multi-panel shot is the landing frame
  // and never carries it (see assertPanelMoves) unless the next shot runs on from this lane in one
  // take (`continuedBy`), and every other panel must carry it before the board reaches review
  // (REVIEW_PREREQUISITE_MISSING).
  blocking: z.string().optional(),
  // The camera's behaviour over that same transit. Same position rule as `blocking`. A subject
  // leaving frame because the camera moved off it belongs here.
  camera: z.string().optional(),
});

export type PanelDefinition = z.infer<typeof PanelDefinitionSchema>;

// Which camera frame of a shot a keyframe belongs to: the shot's own picture, or the second frame
// a `<Cutin>` lays over it.
export const PanelLaneSchema = z.enum(["main", "cutin"]);

export type PanelLane = z.infer<typeof PanelLaneSchema>;

export const ShotDefinitionSchema = z.object({
  id: z.string(),
  duration: z.number(),
  // Review metadata only — no hash reads it, so editing the direction's prose never marks a shot stale.
  action: z.string(),
  assets: z.record(z.string(), AssetDefinitionSchema),
  shotFn: z.custom<ShotFunction>().optional(),
  // Asset paths the shot's composition (shotFn output) references, including
  // timeline assets pulled in via closure. Source of truth for composition deps.
  // Optional so raw ShotDefinition literals (tests, fallback shots) stay valid;
  // defineVideo always populates it. Consumers treat absent as [].
  compositionRefs: z.array(z.string()).optional(),
  // `compositionRefs` partitioned by media at discovery: `pictureRefs` feed the picture
  // composition (audio excluded so an audio-only edit never re-renders the picture),
  // `stemRefs` feed the shot's audio stem (<Audio>/<Video hasAudio> sources; a hasAudio
  // video's source is in both). Absent on raw literals; consumers fall back to compositionRefs.
  pictureRefs: z.array(z.string()).optional(),
  stemRefs: z.array(z.string()).optional(),
  // ANIMATIC ONLY: the narration cues, split out of `stemRefs` once the cues are classified. They
  // feed `#narrationStem` rather than `#stem`, so a motion model driven by the stem never mouths the
  // narrator's words.
  narrationStemRefs: z.array(z.string()).optional(),
  // What each `stemRefs` / `narrationStemRefs` cue is to the mix, decided from the direction's
  // script when the stage was built (see classifyShotCues) — the levels it is brought to, and
  // whether it ducks a bed. Stored here because the direction's lines are not on the stage
  // definition.
  cueKinds: z.record(z.string(), z.enum(["voice", "narration", "mob", "sfx"])).optional(),
  // ANIMATIC ONLY: the keyframes this shot's composition declared with `<Panel>`, in document
  // order, each with its resolved window. A developed animatic shot always has at least one
  // (PANEL_REQUIRED); a video shot has none.
  panels: z.array(PanelDefinitionSchema).optional(),
  // ANIMATIC ONLY: per lane, the shot whose frame runs on from this one in one take (the direction's
  // `join: "continuous"`, where it is possible). This lane's last panel is then no landing frame.
  // Derived from the direction by `defineAnimatic`; no hash reads it.
  continuedBy: z.object({ main: z.string().optional(), cutin: z.string().optional() }).optional(),
  // The second camera frame the composition lays over the picture with `<Cutin>`, present exactly
  // when it renders one. `refs` are the assets drawn inside it — on the video, what tells a cutin's
  // take from the main frame's — and `sharedRefs` those of them the shot's own picture draws too.
  // `panels` are its keyframes, on the animatic only; `<Panel>`s outside the `<Cutin>` stay in the
  // shot's own `panels`.
  cutin: z
    .object({
      refs: z.array(z.string()),
      sharedRefs: z.array(z.string()).optional(),
      panels: z.array(PanelDefinitionSchema).optional(),
    })
    .optional(),
  // A shot of the arc with no camera (the DSL's `GraphicShot`): its picture is the composition's own
  // layers, so it holds no keyframe in its main frame and owes the board nothing it could build on.
  graphic: z.literal(true).optional(),
  // A first-class "undeveloped shot" marker, on either composition stage.
  // A pending shot carries no composition/asset/job (`shotFn` and `assets` are empty) and nothing
  // of its own; the shot it stands for is the direction's `action`. Preview renders it as a black tile;
  // export refuses while any remain; status never counts it for review. It stays declared in the
  // shot list so direction drift checks see the shot as realized.
  //
  // Invariant — a pending shot has no shotFn/compositionRefs/assets; a developed shot has no
  // `pending`. Enforced by construction in defineVideo (the only builder), not by a schema refine:
  // this schema drives the user-facing generated type, which must stay a plain ZodObject (a
  // superRefine turns it into a ZodEffects the template's zod can't express).
  pending: z.literal(true).optional(),
  // A shot that occupies the clock without being part of the arc (see the DSL's `AsideShot`) — a
  // title card, an eyecatch, an OP dropped in whole. On the video it is an ordinary developed shot
  // wearing this flag; on the animatic it carries no `shotFn` at all, since the board never draws
  // one, and renders as a labelled slug of the declared duration so the reel's clock still matches.
  //
  // It is NOT `pending`: an aside is finished business, so export never refuses over it and status
  // never asks for it to be developed. `action` holds its label — the definition layer's field is the
  // prose a reader is shown for this shot, and for an aside that is what the span is.
  aside: z.literal(true).optional(),
});

export type ShotDefinition = z.infer<typeof ShotDefinitionSchema>;

export function isPendingShot(shot: ShotDefinition): boolean {
  return shot.pending === true;
}

/**
 * A composition stage's `timeline` callback. It both declares top-level (timeline) assets as a side
 * effect and returns the shot inputs; the shot starters it closes over are injected by the builder,
 * so callers pass only `{ format }` (the render size/fps assets may derive their inputs from).
 */
export type TimelineFunction = (args: { format: VideoFormat }) => {
  shots: Array<{ id: string; fn: ShotFunction }>;
  soundtracks: ReadonlyArray<SoundtrackEntry>;
};

/**
 * What konte hands a delivery upscale function at export time: the source `video` (a
 * placeholder so the dependency graph wires it up), the `scale` factor (delivery/working),
 * and the absolute target `width`/`height`. The user threads whichever its upscaler needs —
 * scale-based upscalers use `scale`, absolute/preset ones use `width`/`height`.
 *   - `video` mode: source = one video layer; width/height = the layer's real size × scale
 *     (ffprobed at export, AR-preserving).
 *   - `frame` mode: source = the composited shot (working res); width/height = delivery size.
 */
export type DeliveryUpscaleInput = {
  video: MediaAsset<"video">;
  scale: number;
  width: number;
  height: number;
};

/**
 * A delivery upscale: a function that, given konte's injected inputs, returns the upscale
 * definition (an AssetDefinition, usually built via the `upscale(adapter, inputs)` helper).
 */
export type DeliveryUpscaleFn = (input: DeliveryUpscaleInput) => AssetDefinition;

const deliveryUpscaleFnSchema = z.custom<DeliveryUpscaleFn>((v) => typeof v === "function");

/**
 * Optional "delivery" config, under the video's `export`. `size` is the delivery resolution
 * (from `direction.policy.format.size.delivery`); `upscale` is the author's upscaler in video.tsx.
 * Both are optional — either half may be declared alone, validated at export (`DELIVERY_*`) not at
 * load. `upscale.video` upscales each video layer then re-composites at delivery res (text/overlays
 * stay native — sharp); `upscale.frame` upscales the whole composited shot (any upscaler, incl.
 * preset — text upscaled with the frame). A video with no `delivery` ships at working size.
 */
export const DeliverySchema = z.object({
  size: z.object({ width: z.number(), height: z.number() }).optional(),
  upscale: z
    .object({
      video: deliveryUpscaleFnSchema.optional(),
      frame: deliveryUpscaleFnSchema.optional(),
    })
    .optional(),
});
export type Delivery = z.infer<typeof DeliverySchema>;

/**
 * The video's render canvas: the working `size`/`fps` every generated asset and composition targets.
 * `defineVideo` derives this from the direction canvas (`resolveDirectionFormat` — the canvas derived
 * from `policy.format.size`, plus `fps`) and stores it here.
 */
export const VideoFormatSchema = z.object({
  size: z.object({ width: z.number(), height: z.number() }),
  fps: z.number(),
});
export type VideoFormat = z.infer<typeof VideoFormatSchema>;

/**
 * Export-time settings (delivery/upscale), read only when writing the final deliverable.
 */
export const ExportSchema = z.object({
  delivery: DeliverySchema.optional(),
});
export type Export = z.infer<typeof ExportSchema>;

/**
 * How a composition document is typeset: the direction's language on the document root, the piece's
 * fonts on its body.
 */
export const TypographySchema = z.object({
  lang: z.custom<LanguageTag>((v) => typeof v === "string" && isLanguageTag(v)),
  fonts: z.array(z.string().regex(FONT_FAMILY_PATTERN)).optional(),
});
export type Typography = z.infer<typeof TypographySchema>;

// The prompt check's two fields, carried by every stage entry alike: `prompts` is what the stage's
// `"prompt"` inputs were built with, `waivers` the reasons standing against their findings, keyed
// the way `status` prints them. Both are read by the spend gate; neither is hashed.
export const PromptsSchema = z.custom<readonly PromptOccurrence[]>().optional();
export const PromptWaiversSchema = z.record(z.string(), z.string()).optional();

// The pin check's half of the same pair — what the stage's `pin` inputs were wired to. `waivers`
// above is the one record both classes are keyed in (see waiver-keys.ts). Not hashed either.
export const PinsSchema = z.custom<readonly PinOccurrence[]>().optional();

// `panel-unlinked`'s and `plate-unnested`'s half — every wired image input the stage declared. Not
// hashed either: what each slot was passed already lives in `inputs`.
export const ImageInputsSchema = z.custom<readonly ImageInputOccurrence[]>().optional();

// Every address the stage declared with a `readsPrevPanel` adapter. Not hashed.
export const PrevPanelReadersSchema = z.custom<readonly string[]>().optional();

// One line spelled as one model needs it — what `respell()` declared while the stage built, filed
// by the shot the call was made inside (absent for a cue declared on the timeline). Read by the
// voiced check and the cue classifier and printed beside the prompts; never hashed, since which
// spelling a model needs is not a change to the take.
export const RespellingSchema = z.object({
  shot: z.string().optional(),
  line: z.string(),
  as: z.string(),
});
export type Respelling = z.infer<typeof RespellingSchema>;
export const RespellingsSchema = z.array(RespellingSchema).optional();

// What the two composition stages have in common — everything the render, staleness, graph and
// review machinery reads. `animatic` and `video` are the same shape because they are the same
// thing at two points of the pipeline: a reel of `<Composition>` shots on one canvas. The stage
// each is rides on the definition rather than being passed alongside it, so every address a
// consumer formats is the definition's own.
export const StageDefinitionSchema = z.object({
  stage: z.enum(["animatic", "video"]),
  format: VideoFormatSchema,
  typography: TypographySchema,
  shots: z.array(ShotDefinitionSchema),
  topLevelAssets: z.record(z.string(), AssetDefinitionSchema).optional(),
  timelineSoundtracks: z.custom<readonly SoundtrackEntry[]>().optional(),
  timelineFn: z.custom<TimelineFunction>().optional(),
  prompts: PromptsSchema,
  pins: PinsSchema,
  imageInputs: ImageInputsSchema,
  prevPanelReaders: PrevPanelReadersSchema,
  waivers: PromptWaiversSchema,
  respellings: RespellingsSchema,
});

export type StageDefinition = z.infer<typeof StageDefinitionSchema>;

export const VideoDefinitionSchema = StageDefinitionSchema.extend({
  stage: z.literal("video"),
  export: ExportSchema.optional(),
});

export type VideoDefinition = z.infer<typeof VideoDefinitionSchema>;
