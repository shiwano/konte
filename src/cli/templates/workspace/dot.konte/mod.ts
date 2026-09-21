/* eslint-disable */

declare namespace React {
  type ReactElement = { type: string | Function; props: Record<string, unknown> };
  type ReactNode = ReactElement | string | number | boolean | null | undefined | ReactNode[];
  type ComponentPropsWithoutRef<T extends keyof JSX.IntrinsicElements> = JSX.IntrinsicElements[T];
}

declare namespace z {
  interface ZodTypeDef {}
  interface ZodType<Output = any, _Def extends ZodTypeDef = ZodTypeDef, Input = Output> {
    _output: Output;
    _input: Input;
  }
  type ZodTypeAny = ZodType<any, ZodTypeDef, any>;
  type infer<T extends ZodType<any, any, any>> = T["_output"];
  type ZodString = ZodType<string>;
  type ZodNumber = ZodType<number>;
  type ZodBoolean = ZodType<boolean>;
  type ZodLiteral<T> = ZodType<T>;
  type ZodUnknown = ZodType<unknown>;
  type ZodNever = ZodType<never>;
  interface ZodOptional<T extends ZodTypeAny> extends ZodType<
    T["_output"] | undefined,
    ZodTypeDef,
    T["_input"] | undefined
  > {}
  interface ZodNullable<T extends ZodTypeAny> extends ZodType<
    T["_output"] | null,
    ZodTypeDef,
    T["_input"] | null
  > {}
  interface ZodTuple<
    T extends readonly ZodTypeAny[] = ZodTypeAny[],
    _R extends ZodTypeAny | null = null,
  > extends ZodType<
    { -readonly [K in keyof T]: T[K] extends ZodTypeAny ? T[K]["_output"] : never },
    ZodTypeDef,
    { -readonly [K in keyof T]: T[K] extends ZodTypeAny ? T[K]["_input"] : never }
  > {}
  interface ZodEnum<T extends [string, ...string[]]> extends ZodType<T[number]> {}
  interface ZodRecord<K extends ZodType<string>, V extends ZodTypeAny> extends ZodType<
    Record<K["_output"], V["_output"]>
  > {}
  interface ZodArray<
    T extends ZodTypeAny,
    _C extends "many" | "atleastone" = "many",
  > extends ZodType<T["_output"][]> {}
  interface ZodObject<
    _S extends Record<string, ZodTypeAny> = Record<string, ZodTypeAny>,
    _M extends string = "strip",
    _C extends ZodTypeAny = ZodTypeAny,
    Output = any,
    Input = Output,
  > extends ZodType<Output, ZodTypeDef, Input> {}
  interface ZodDiscriminatedUnion<
    _K extends string = string,
    M extends readonly ZodObject[] = ZodObject[],
  > extends ZodType<M[number]["_output"], ZodTypeDef, M[number]["_input"]> {}
  interface ZodUnion<M extends readonly ZodTypeAny[] = ZodTypeAny[]> extends ZodType<
    M[number]["_output"],
    ZodTypeDef,
    M[number]["_input"]
  > {}
}

declare global {
  namespace JSX {
    type Element = {
      type: string | Function;
      props: Record<string, unknown>;
    };

    interface ElementChildrenAttribute {
      children: {};
    }

    interface HtmlAttributes {
      id?: string;
      className?: string;
      style?: string | Record<string, string | number>;
      title?: string;
      lang?: string;
      hidden?: boolean;
      children?: any;
      dangerouslySetInnerHTML?: { __html: string };
      [key: `data-${string}`]: string | number | boolean;
    }

    interface MediaAttributes extends HtmlAttributes {
      src?: string;
      muted?: boolean;
      playsInline?: boolean;
      autoPlay?: boolean;
      loop?: boolean;
      controls?: boolean;
      preload?: string;
    }

    interface MetaAttributes extends HtmlAttributes {
      charSet?: string;
      name?: string;
      content?: string;
      httpEquiv?: string;
    }

    interface LinkAttributes extends HtmlAttributes {
      rel?: string;
      href?: string;
      type?: string;
      media?: string;
    }

    interface ScriptAttributes extends HtmlAttributes {
      src?: string;
      type?: string;
      async?: boolean;
      defer?: boolean;
    }

    type SvgLength = number | string;

    interface SvgAttributes extends HtmlAttributes {
      transform?: string;
      transformOrigin?: string;
      opacity?: number | string;
      fill?: string;
      fillOpacity?: number | string;
      fillRule?: "nonzero" | "evenodd";
      stroke?: string;
      strokeWidth?: SvgLength;
      strokeOpacity?: number | string;
      strokeLinecap?: "butt" | "round" | "square";
      strokeLinejoin?: "miter" | "round" | "bevel" | "arcs" | "miter-clip";
      strokeMiterlimit?: number | string;
      strokeDasharray?: SvgLength;
      strokeDashoffset?: SvgLength;
      paintOrder?: string;
      vectorEffect?: string;
      shapeRendering?: string;
      clipPath?: string;
      clipRule?: "nonzero" | "evenodd";
      mask?: string;
      filter?: string;
      markerStart?: string;
      markerMid?: string;
      markerEnd?: string;
    }

    interface SvgTextAttributes extends SvgAttributes {
      x?: SvgLength;
      y?: SvgLength;
      dx?: SvgLength;
      dy?: SvgLength;
      textAnchor?: "start" | "middle" | "end";
      dominantBaseline?: string;
      fontFamily?: string;
      fontSize?: SvgLength;
      fontWeight?: number | string;
      fontStyle?: string;
      letterSpacing?: SvgLength;
    }

    interface IntrinsicElements {
      div: HtmlAttributes;
      span: HtmlAttributes;
      p: HtmlAttributes;
      h1: HtmlAttributes;
      h2: HtmlAttributes;
      h3: HtmlAttributes;
      h4: HtmlAttributes;
      h5: HtmlAttributes;
      h6: HtmlAttributes;
      a: HtmlAttributes & { href?: string; target?: string; rel?: string };
      img: HtmlAttributes & { src?: string; alt?: string; width?: number; height?: number };
      video: MediaAttributes & { width?: number; height?: number; poster?: string };
      audio: MediaAttributes;
      source: HtmlAttributes & { src?: string; type?: string };
      track: HtmlAttributes & {
        src?: string;
        kind?: string;
        label?: string;
        srcLang?: string;
        default?: boolean;
      };
      html: HtmlAttributes;
      head: HtmlAttributes;
      body: HtmlAttributes;
      title: HtmlAttributes;
      meta: MetaAttributes;
      link: LinkAttributes;
      style: HtmlAttributes;
      script: ScriptAttributes;
      br: HtmlAttributes;
      hr: HtmlAttributes;
      input: HtmlAttributes & { type?: string; value?: string; name?: string };
      canvas: HtmlAttributes & { width?: number; height?: number };
      svg: SvgAttributes & {
        width?: SvgLength;
        height?: SvgLength;
        viewBox?: string;
        preserveAspectRatio?: string;
        xmlns?: string;
      };
      g: SvgAttributes;
      defs: SvgAttributes;
      symbol: SvgAttributes & { viewBox?: string; preserveAspectRatio?: string };
      use: SvgAttributes & {
        href?: string;
        x?: SvgLength;
        y?: SvgLength;
        width?: SvgLength;
        height?: SvgLength;
      };
      path: SvgAttributes & { d?: string; pathLength?: number };
      rect: SvgAttributes & {
        x?: SvgLength;
        y?: SvgLength;
        width?: SvgLength;
        height?: SvgLength;
        rx?: SvgLength;
        ry?: SvgLength;
      };
      circle: SvgAttributes & { cx?: SvgLength; cy?: SvgLength; r?: SvgLength };
      ellipse: SvgAttributes & { cx?: SvgLength; cy?: SvgLength; rx?: SvgLength; ry?: SvgLength };
      line: SvgAttributes & { x1?: SvgLength; y1?: SvgLength; x2?: SvgLength; y2?: SvgLength };
      polyline: SvgAttributes & { points?: string };
      polygon: SvgAttributes & { points?: string };
      text: SvgTextAttributes;
      tspan: SvgTextAttributes;
      image: SvgAttributes & {
        href?: string;
        x?: SvgLength;
        y?: SvgLength;
        width?: SvgLength;
        height?: SvgLength;
        preserveAspectRatio?: string;
      };
      linearGradient: SvgAttributes & {
        x1?: SvgLength;
        y1?: SvgLength;
        x2?: SvgLength;
        y2?: SvgLength;
        gradientUnits?: "userSpaceOnUse" | "objectBoundingBox";
        gradientTransform?: string;
        spreadMethod?: "pad" | "reflect" | "repeat";
      };
      radialGradient: SvgAttributes & {
        cx?: SvgLength;
        cy?: SvgLength;
        r?: SvgLength;
        fx?: SvgLength;
        fy?: SvgLength;
        gradientUnits?: "userSpaceOnUse" | "objectBoundingBox";
        gradientTransform?: string;
        spreadMethod?: "pad" | "reflect" | "repeat";
      };
      stop: SvgAttributes & {
        offset?: SvgLength;
        stopColor?: string;
        stopOpacity?: number | string;
      };
      clipPath: SvgAttributes & { clipPathUnits?: "userSpaceOnUse" | "objectBoundingBox" };
      mask: SvgAttributes & {
        x?: SvgLength;
        y?: SvgLength;
        width?: SvgLength;
        height?: SvgLength;
        maskUnits?: "userSpaceOnUse" | "objectBoundingBox";
        maskContentUnits?: "userSpaceOnUse" | "objectBoundingBox";
      };
      pattern: SvgAttributes & {
        x?: SvgLength;
        y?: SvgLength;
        width?: SvgLength;
        height?: SvgLength;
        viewBox?: string;
        patternUnits?: "userSpaceOnUse" | "objectBoundingBox";
        patternContentUnits?: "userSpaceOnUse" | "objectBoundingBox";
        patternTransform?: string;
      };
    }
  }
}

declare const STAGE_FINDING_CODES: readonly [
  "prompt-negation",
  "prompt-not-yet",
  "prompt-double-negative",
  "pin-unanchored",
];
export type StageFindingCode = (typeof STAGE_FINDING_CODES)[number];
/**
 * The class this check reports, its slice of the waiver namespace (see waiver-keys.ts).
 *   - pin-unanchored: the pinned image is a reference sheet or a plate.
 */
export type PinFindingCode = Extract<StageFindingCode, `pin-${string}`>;
export type PinSubject = "sheet" | "plate";
export type PinOccurrence = {
  address: string;
  input: string;
  pin: "start" | "end";
  source?: string;
  clip?: {
    sec: number;
    frameSec: number;
    landsAt: number;
  };
};
export type PinFinding = {
  code: PinFindingCode;
  key: string;
  source: string;
  subject: PinSubject;
  sites: readonly {
    address: string;
    input: string;
    pin: "start" | "end";
  }[];
};
/**
 * One wired image input that is not a `pin`, as declared at one address: the addresses it was
 * passed.
 */
export type ImageInputOccurrence = {
  address: string;
  sources: readonly string[];
};
/**
 * The classes this check reports, its slice of the waiver namespace (see waiver-keys.ts).
 *   - prompt-negation: the prompt names something to leave out.
 *   - prompt-not-yet: the prompt describes what has not happened — time talk in a still frame, or a
 *     motion prompt written as a state to hold rather than a move to make.
 *   - prompt-double-negative: a negativePrompt names an exclusion negatively ("no watermark"),
 *     which cancels it.
 */
export type PromptFindingCode = Extract<StageFindingCode, `prompt-${string}`>;
export type PromptOccurrence = {
  address: string;
  input: string;
  value: string;
  negative?: true;
  spoken?: true;
  spokenWithin?: readonly string[];
  spokenMarks?: readonly string[];
  exemptions?: readonly RegExp[];
  script?: readonly string[];
};
export type PromptFinding = {
  code: PromptFindingCode;
  key: string;
  phrase: string;
  addresses: readonly string[];
};
declare const LANGUAGES: readonly [
  "ja",
  "ko",
  "zh",
  "en",
  "fr",
  "de",
  "es",
  "pt",
  "it",
  "nl",
  "pl",
  "ru",
  "uk",
  "tr",
  "ar",
  "he",
  "hi",
  "th",
  "vi",
  "id",
];
export type Language = (typeof LANGUAGES)[number];
/**
 * What `policy.lang` accepts. Wider than `LANGUAGES` on one axis: subtags may ride along (`en-US`,
 * `pt-BR`, `zh-Hans-CN`) — an unknown one renders exactly as none at all. They are kept, not
 * stripped: for Chinese a region IS a script (`zh-CN` is Simplified), so dropping it loses the glyphs.
 */
export type LanguageTag = Language | `${Language}-${string}`;
/**
 * A reference is the shared upstream stage: a flat pool of named assets (characters, backgrounds,
 * bgm) shared across the animatic and video stages. Assets are stored in `topLevelAssets` (the
 * shared non-shot pool) with no shots.
 *
 * `exposedAssetNames` are the asset names the callback returned — the ones published as
 * `reference.<name>` to the other stages. They are the usage roots for the reference pool:
 * an exposed asset (and anything it transitively consumes) is "used" even before a panel
 * references it, while a declared asset that is neither exposed nor consumed is unused.
 */
export interface ReferenceDefinition {
  shots: never[];
  topLevelAssets?: Record<string, AssetDefinition>;
  exposedAssetNames?: string[];
  prompts?: readonly PromptOccurrence[];
  pins?: readonly PinOccurrence[];
  waivers?: Record<string, string>;
}
export type ShotStage = "animatic" | "video";
/**
 * The stages that own an asset address at all, in any shape.
 */
export type AssetStage = ShotStage | "reference";
export type ShotFunction = () => React.ReactElement;
/**
 * The stage canvas an adapter's format-derived inputs (width/height/fps) resolve against at
 * definition-build time.
 * `duration` (seconds) is the active shot's, present only inside a video shot discovery — a
 * timeline or reference build has no single duration — so a function default computing a frame
 * count from it must guard for undefined.
 */
export interface BuildFormat {
  size: {
    width: number;
    height: number;
  };
  fps?: number;
  duration?: number;
  typography?: Typography;
}
declare const AnimaticFormatSchema: z.ZodObject<
  {
    size: z.ZodObject<
      {
        width: z.ZodNumber;
        height: z.ZodNumber;
      },
      "strip",
      z.ZodTypeAny,
      {
        width: number;
        height: number;
      },
      {
        width: number;
        height: number;
      }
    >;
    fps: z.ZodNumber;
  },
  "strip",
  z.ZodTypeAny,
  {
    fps: number;
    size: {
      width: number;
      height: number;
    };
  },
  {
    fps: number;
    size: {
      width: number;
      height: number;
    };
  }
>;
export type AnimaticFormat = z.infer<typeof AnimaticFormatSchema>;
declare const AnimaticDefinitionSchema: z.ZodObject<
  {
    format: z.ZodObject<
      {
        size: z.ZodObject<
          {
            width: z.ZodNumber;
            height: z.ZodNumber;
          },
          "strip",
          z.ZodTypeAny,
          {
            width: number;
            height: number;
          },
          {
            width: number;
            height: number;
          }
        >;
        fps: z.ZodNumber;
      },
      "strip",
      z.ZodTypeAny,
      {
        fps: number;
        size: {
          width: number;
          height: number;
        };
      },
      {
        fps: number;
        size: {
          width: number;
          height: number;
        };
      }
    >;
    typography: z.ZodObject<
      {
        lang: z.ZodType<LanguageTag, z.ZodTypeDef, LanguageTag>;
        fonts: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
      },
      "strip",
      z.ZodTypeAny,
      {
        lang: LanguageTag;
        fonts?: string[] | undefined;
      },
      {
        lang: LanguageTag;
        fonts?: string[] | undefined;
      }
    >;
    shots: z.ZodArray<
      z.ZodObject<
        {
          id: z.ZodString;
          duration: z.ZodNumber;
          action: z.ZodString;
          assets: z.ZodRecord<
            z.ZodString,
            z.ZodDiscriminatedUnion<
              "kind",
              [
                z.ZodObject<
                  {
                    deterministic: z.ZodOptional<z.ZodBoolean>;
                    kind: z.ZodLiteral<"comfy">;
                    workflow: z.ZodString;
                    inputs: z.ZodRecord<z.ZodString, z.ZodUnknown>;
                    prunedNodes: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
                    prunedPassThroughs: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>;
                    outputNodeId: z.ZodOptional<z.ZodString>;
                    models: z.ZodOptional<
                      z.ZodArray<
                        z.ZodObject<
                          {
                            filename: z.ZodString;
                            type: z.ZodEnum<
                              [
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
                              ]
                            >;
                            nodeId: z.ZodOptional<z.ZodString>;
                            url: z.ZodString;
                            savePath: z.ZodOptional<z.ZodString>;
                            base: z.ZodOptional<z.ZodString>;
                            displayName: z.ZodOptional<z.ZodString>;
                          },
                          "strip",
                          z.ZodTypeAny,
                          {
                            type:
                              | "checkpoint"
                              | "lora"
                              | "VAE"
                              | "clip"
                              | "diffusion_model"
                              | "controlnet"
                              | "upscale"
                              | "embeddings"
                              | "clip_vision"
                              | "unet";
                            url: string;
                            filename: string;
                            nodeId?: string | undefined;
                            savePath?: string | undefined;
                            base?: string | undefined;
                            displayName?: string | undefined;
                          },
                          {
                            type:
                              | "checkpoint"
                              | "lora"
                              | "VAE"
                              | "clip"
                              | "diffusion_model"
                              | "controlnet"
                              | "upscale"
                              | "embeddings"
                              | "clip_vision"
                              | "unet";
                            url: string;
                            filename: string;
                            nodeId?: string | undefined;
                            savePath?: string | undefined;
                            base?: string | undefined;
                            displayName?: string | undefined;
                          }
                        >,
                        "many"
                      >
                    >;
                    nodes: z.ZodOptional<
                      z.ZodArray<
                        z.ZodObject<
                          {
                            id: z.ZodString;
                          },
                          "strip",
                          z.ZodTypeAny,
                          {
                            id: string;
                          },
                          {
                            id: string;
                          }
                        >,
                        "many"
                      >
                    >;
                    inputLabels: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>;
                    turboInputs: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
                  },
                  "strip",
                  z.ZodTypeAny,
                  {
                    kind: "comfy";
                    workflow: string;
                    inputs: Record<string, unknown>;
                    prunedNodes?: string[] | undefined;
                    prunedPassThroughs?: Record<string, string> | undefined;
                    outputNodeId?: string | undefined;
                    models?:
                      | {
                          type:
                            | "checkpoint"
                            | "lora"
                            | "VAE"
                            | "clip"
                            | "diffusion_model"
                            | "controlnet"
                            | "upscale"
                            | "embeddings"
                            | "clip_vision"
                            | "unet";
                          url: string;
                          filename: string;
                          nodeId?: string | undefined;
                          savePath?: string | undefined;
                          base?: string | undefined;
                          displayName?: string | undefined;
                        }[]
                      | undefined;
                    nodes?:
                      | {
                          id: string;
                        }[]
                      | undefined;
                    inputLabels?: Record<string, string> | undefined;
                    turboInputs?: Record<string, unknown> | undefined;
                    deterministic?: boolean | undefined;
                  },
                  {
                    kind: "comfy";
                    workflow: string;
                    inputs: Record<string, unknown>;
                    prunedNodes?: string[] | undefined;
                    prunedPassThroughs?: Record<string, string> | undefined;
                    outputNodeId?: string | undefined;
                    models?:
                      | {
                          type:
                            | "checkpoint"
                            | "lora"
                            | "VAE"
                            | "clip"
                            | "diffusion_model"
                            | "controlnet"
                            | "upscale"
                            | "embeddings"
                            | "clip_vision"
                            | "unet";
                          url: string;
                          filename: string;
                          nodeId?: string | undefined;
                          savePath?: string | undefined;
                          base?: string | undefined;
                          displayName?: string | undefined;
                        }[]
                      | undefined;
                    nodes?:
                      | {
                          id: string;
                        }[]
                      | undefined;
                    inputLabels?: Record<string, string> | undefined;
                    turboInputs?: Record<string, unknown> | undefined;
                    deterministic?: boolean | undefined;
                  }
                >,
                z.ZodObject<
                  {
                    deterministic: z.ZodOptional<z.ZodBoolean>;
                    kind: z.ZodLiteral<"file">;
                    path: z.ZodString;
                    type: z.ZodOptional<z.ZodEnum<["image", "video", "audio"]>>;
                  },
                  "strip",
                  z.ZodTypeAny,
                  {
                    kind: "file";
                    path: string;
                    type?: "image" | "video" | "audio" | undefined;
                    deterministic?: boolean | undefined;
                  },
                  {
                    kind: "file";
                    path: string;
                    type?: "image" | "video" | "audio" | undefined;
                    deterministic?: boolean | undefined;
                  }
                >,
                z.ZodObject<
                  {
                    deterministic: z.ZodOptional<z.ZodBoolean>;
                    kind: z.ZodLiteral<"fal">;
                    endpointId: z.ZodString;
                    mediaType: z.ZodEnum<["image", "video", "audio"]>;
                    inputs: z.ZodRecord<z.ZodString, z.ZodUnknown>;
                    inputLabels: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>;
                    turboInputs: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
                  },
                  "strip",
                  z.ZodTypeAny,
                  {
                    kind: "fal";
                    inputs: Record<string, unknown>;
                    endpointId: string;
                    mediaType: "image" | "video" | "audio";
                    inputLabels?: Record<string, string> | undefined;
                    turboInputs?: Record<string, unknown> | undefined;
                    deterministic?: boolean | undefined;
                  },
                  {
                    kind: "fal";
                    inputs: Record<string, unknown>;
                    endpointId: string;
                    mediaType: "image" | "video" | "audio";
                    inputLabels?: Record<string, string> | undefined;
                    turboInputs?: Record<string, unknown> | undefined;
                    deterministic?: boolean | undefined;
                  }
                >,
                z.ZodObject<
                  {
                    deterministic: z.ZodOptional<z.ZodBoolean>;
                    kind: z.ZodLiteral<"local">;
                    operation: z.ZodEnum<
                      ["resize", "crop", "blank", "trim", "retime", "frame", "render"]
                    >;
                    mediaType: z.ZodEnum<["image", "video", "audio"]>;
                    inputs: z.ZodRecord<z.ZodString, z.ZodUnknown>;
                  },
                  "strip",
                  z.ZodTypeAny,
                  {
                    kind: "local";
                    inputs: Record<string, unknown>;
                    mediaType: "image" | "video" | "audio";
                    operation: "trim" | "resize" | "crop" | "blank" | "retime" | "frame" | "render";
                    deterministic?: boolean | undefined;
                  },
                  {
                    kind: "local";
                    inputs: Record<string, unknown>;
                    mediaType: "image" | "video" | "audio";
                    operation: "trim" | "resize" | "crop" | "blank" | "retime" | "frame" | "render";
                    deterministic?: boolean | undefined;
                  }
                >,
              ]
            >
          >;
          shotFn: z.ZodOptional<z.ZodType<ShotFunction, z.ZodTypeDef, ShotFunction>>;
          compositionRefs: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
          pictureRefs: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
          stemRefs: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
          narrationStemRefs: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
          cueKinds: z.ZodOptional<
            z.ZodRecord<z.ZodString, z.ZodEnum<["voice", "narration", "mob", "sfx"]>>
          >;
          panels: z.ZodOptional<
            z.ZodArray<
              z.ZodObject<
                {
                  assetName: z.ZodString;
                  assetPath: z.ZodString;
                  start: z.ZodNumber;
                  duration: z.ZodNumber;
                  blocking: z.ZodOptional<z.ZodString>;
                  camera: z.ZodOptional<z.ZodString>;
                },
                "strip",
                z.ZodTypeAny,
                {
                  duration: number;
                  assetName: string;
                  assetPath: string;
                  start: number;
                  blocking?: string | undefined;
                  camera?: string | undefined;
                },
                {
                  duration: number;
                  assetName: string;
                  assetPath: string;
                  start: number;
                  blocking?: string | undefined;
                  camera?: string | undefined;
                }
              >,
              "many"
            >
          >;
          continuedBy: z.ZodOptional<
            z.ZodObject<
              {
                main: z.ZodOptional<z.ZodString>;
                cutin: z.ZodOptional<z.ZodString>;
              },
              "strip",
              z.ZodTypeAny,
              {
                main?: string | undefined;
                cutin?: string | undefined;
              },
              {
                main?: string | undefined;
                cutin?: string | undefined;
              }
            >
          >;
          cutin: z.ZodOptional<
            z.ZodObject<
              {
                refs: z.ZodArray<z.ZodString, "many">;
                sharedRefs: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
                panels: z.ZodOptional<
                  z.ZodArray<
                    z.ZodObject<
                      {
                        assetName: z.ZodString;
                        assetPath: z.ZodString;
                        start: z.ZodNumber;
                        duration: z.ZodNumber;
                        blocking: z.ZodOptional<z.ZodString>;
                        camera: z.ZodOptional<z.ZodString>;
                      },
                      "strip",
                      z.ZodTypeAny,
                      {
                        duration: number;
                        assetName: string;
                        assetPath: string;
                        start: number;
                        blocking?: string | undefined;
                        camera?: string | undefined;
                      },
                      {
                        duration: number;
                        assetName: string;
                        assetPath: string;
                        start: number;
                        blocking?: string | undefined;
                        camera?: string | undefined;
                      }
                    >,
                    "many"
                  >
                >;
              },
              "strip",
              z.ZodTypeAny,
              {
                refs: string[];
                panels?:
                  | {
                      duration: number;
                      assetName: string;
                      assetPath: string;
                      start: number;
                      blocking?: string | undefined;
                      camera?: string | undefined;
                    }[]
                  | undefined;
                sharedRefs?: string[] | undefined;
              },
              {
                refs: string[];
                panels?:
                  | {
                      duration: number;
                      assetName: string;
                      assetPath: string;
                      start: number;
                      blocking?: string | undefined;
                      camera?: string | undefined;
                    }[]
                  | undefined;
                sharedRefs?: string[] | undefined;
              }
            >
          >;
          graphic: z.ZodOptional<z.ZodLiteral<true>>;
          pending: z.ZodOptional<z.ZodLiteral<true>>;
          aside: z.ZodOptional<z.ZodLiteral<true>>;
        },
        "strip",
        z.ZodTypeAny,
        {
          duration: number;
          id: string;
          assets: Record<
            string,
            | {
                kind: "comfy";
                workflow: string;
                inputs: Record<string, unknown>;
                prunedNodes?: string[] | undefined;
                prunedPassThroughs?: Record<string, string> | undefined;
                outputNodeId?: string | undefined;
                models?:
                  | {
                      type:
                        | "checkpoint"
                        | "lora"
                        | "VAE"
                        | "clip"
                        | "diffusion_model"
                        | "controlnet"
                        | "upscale"
                        | "embeddings"
                        | "clip_vision"
                        | "unet";
                      url: string;
                      filename: string;
                      nodeId?: string | undefined;
                      savePath?: string | undefined;
                      base?: string | undefined;
                      displayName?: string | undefined;
                    }[]
                  | undefined;
                nodes?:
                  | {
                      id: string;
                    }[]
                  | undefined;
                inputLabels?: Record<string, string> | undefined;
                turboInputs?: Record<string, unknown> | undefined;
                deterministic?: boolean | undefined;
              }
            | {
                kind: "file";
                path: string;
                type?: "image" | "video" | "audio" | undefined;
                deterministic?: boolean | undefined;
              }
            | {
                kind: "fal";
                inputs: Record<string, unknown>;
                endpointId: string;
                mediaType: "image" | "video" | "audio";
                inputLabels?: Record<string, string> | undefined;
                turboInputs?: Record<string, unknown> | undefined;
                deterministic?: boolean | undefined;
              }
            | {
                kind: "local";
                inputs: Record<string, unknown>;
                mediaType: "image" | "video" | "audio";
                operation: "trim" | "resize" | "crop" | "blank" | "retime" | "frame" | "render";
                deterministic?: boolean | undefined;
              }
          >;
          action: string;
          pending?: true | undefined;
          shotFn?: ShotFunction | undefined;
          compositionRefs?: string[] | undefined;
          pictureRefs?: string[] | undefined;
          stemRefs?: string[] | undefined;
          narrationStemRefs?: string[] | undefined;
          cueKinds?: Record<string, "voice" | "narration" | "mob" | "sfx"> | undefined;
          panels?:
            | {
                duration: number;
                assetName: string;
                assetPath: string;
                start: number;
                blocking?: string | undefined;
                camera?: string | undefined;
              }[]
            | undefined;
          cutin?:
            | {
                refs: string[];
                panels?:
                  | {
                      duration: number;
                      assetName: string;
                      assetPath: string;
                      start: number;
                      blocking?: string | undefined;
                      camera?: string | undefined;
                    }[]
                  | undefined;
                sharedRefs?: string[] | undefined;
              }
            | undefined;
          continuedBy?:
            | {
                main?: string | undefined;
                cutin?: string | undefined;
              }
            | undefined;
          graphic?: true | undefined;
          aside?: true | undefined;
        },
        {
          duration: number;
          id: string;
          assets: Record<
            string,
            | {
                kind: "comfy";
                workflow: string;
                inputs: Record<string, unknown>;
                prunedNodes?: string[] | undefined;
                prunedPassThroughs?: Record<string, string> | undefined;
                outputNodeId?: string | undefined;
                models?:
                  | {
                      type:
                        | "checkpoint"
                        | "lora"
                        | "VAE"
                        | "clip"
                        | "diffusion_model"
                        | "controlnet"
                        | "upscale"
                        | "embeddings"
                        | "clip_vision"
                        | "unet";
                      url: string;
                      filename: string;
                      nodeId?: string | undefined;
                      savePath?: string | undefined;
                      base?: string | undefined;
                      displayName?: string | undefined;
                    }[]
                  | undefined;
                nodes?:
                  | {
                      id: string;
                    }[]
                  | undefined;
                inputLabels?: Record<string, string> | undefined;
                turboInputs?: Record<string, unknown> | undefined;
                deterministic?: boolean | undefined;
              }
            | {
                kind: "file";
                path: string;
                type?: "image" | "video" | "audio" | undefined;
                deterministic?: boolean | undefined;
              }
            | {
                kind: "fal";
                inputs: Record<string, unknown>;
                endpointId: string;
                mediaType: "image" | "video" | "audio";
                inputLabels?: Record<string, string> | undefined;
                turboInputs?: Record<string, unknown> | undefined;
                deterministic?: boolean | undefined;
              }
            | {
                kind: "local";
                inputs: Record<string, unknown>;
                mediaType: "image" | "video" | "audio";
                operation: "trim" | "resize" | "crop" | "blank" | "retime" | "frame" | "render";
                deterministic?: boolean | undefined;
              }
          >;
          action: string;
          pending?: true | undefined;
          shotFn?: ShotFunction | undefined;
          compositionRefs?: string[] | undefined;
          pictureRefs?: string[] | undefined;
          stemRefs?: string[] | undefined;
          narrationStemRefs?: string[] | undefined;
          cueKinds?: Record<string, "voice" | "narration" | "mob" | "sfx"> | undefined;
          panels?:
            | {
                duration: number;
                assetName: string;
                assetPath: string;
                start: number;
                blocking?: string | undefined;
                camera?: string | undefined;
              }[]
            | undefined;
          cutin?:
            | {
                refs: string[];
                panels?:
                  | {
                      duration: number;
                      assetName: string;
                      assetPath: string;
                      start: number;
                      blocking?: string | undefined;
                      camera?: string | undefined;
                    }[]
                  | undefined;
                sharedRefs?: string[] | undefined;
              }
            | undefined;
          continuedBy?:
            | {
                main?: string | undefined;
                cutin?: string | undefined;
              }
            | undefined;
          graphic?: true | undefined;
          aside?: true | undefined;
        }
      >,
      "many"
    >;
    topLevelAssets: z.ZodOptional<
      z.ZodRecord<
        z.ZodString,
        z.ZodDiscriminatedUnion<
          "kind",
          [
            z.ZodObject<
              {
                deterministic: z.ZodOptional<z.ZodBoolean>;
                kind: z.ZodLiteral<"comfy">;
                workflow: z.ZodString;
                inputs: z.ZodRecord<z.ZodString, z.ZodUnknown>;
                prunedNodes: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
                prunedPassThroughs: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>;
                outputNodeId: z.ZodOptional<z.ZodString>;
                models: z.ZodOptional<
                  z.ZodArray<
                    z.ZodObject<
                      {
                        filename: z.ZodString;
                        type: z.ZodEnum<
                          [
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
                          ]
                        >;
                        nodeId: z.ZodOptional<z.ZodString>;
                        url: z.ZodString;
                        savePath: z.ZodOptional<z.ZodString>;
                        base: z.ZodOptional<z.ZodString>;
                        displayName: z.ZodOptional<z.ZodString>;
                      },
                      "strip",
                      z.ZodTypeAny,
                      {
                        type:
                          | "checkpoint"
                          | "lora"
                          | "VAE"
                          | "clip"
                          | "diffusion_model"
                          | "controlnet"
                          | "upscale"
                          | "embeddings"
                          | "clip_vision"
                          | "unet";
                        url: string;
                        filename: string;
                        nodeId?: string | undefined;
                        savePath?: string | undefined;
                        base?: string | undefined;
                        displayName?: string | undefined;
                      },
                      {
                        type:
                          | "checkpoint"
                          | "lora"
                          | "VAE"
                          | "clip"
                          | "diffusion_model"
                          | "controlnet"
                          | "upscale"
                          | "embeddings"
                          | "clip_vision"
                          | "unet";
                        url: string;
                        filename: string;
                        nodeId?: string | undefined;
                        savePath?: string | undefined;
                        base?: string | undefined;
                        displayName?: string | undefined;
                      }
                    >,
                    "many"
                  >
                >;
                nodes: z.ZodOptional<
                  z.ZodArray<
                    z.ZodObject<
                      {
                        id: z.ZodString;
                      },
                      "strip",
                      z.ZodTypeAny,
                      {
                        id: string;
                      },
                      {
                        id: string;
                      }
                    >,
                    "many"
                  >
                >;
                inputLabels: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>;
                turboInputs: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
              },
              "strip",
              z.ZodTypeAny,
              {
                kind: "comfy";
                workflow: string;
                inputs: Record<string, unknown>;
                prunedNodes?: string[] | undefined;
                prunedPassThroughs?: Record<string, string> | undefined;
                outputNodeId?: string | undefined;
                models?:
                  | {
                      type:
                        | "checkpoint"
                        | "lora"
                        | "VAE"
                        | "clip"
                        | "diffusion_model"
                        | "controlnet"
                        | "upscale"
                        | "embeddings"
                        | "clip_vision"
                        | "unet";
                      url: string;
                      filename: string;
                      nodeId?: string | undefined;
                      savePath?: string | undefined;
                      base?: string | undefined;
                      displayName?: string | undefined;
                    }[]
                  | undefined;
                nodes?:
                  | {
                      id: string;
                    }[]
                  | undefined;
                inputLabels?: Record<string, string> | undefined;
                turboInputs?: Record<string, unknown> | undefined;
                deterministic?: boolean | undefined;
              },
              {
                kind: "comfy";
                workflow: string;
                inputs: Record<string, unknown>;
                prunedNodes?: string[] | undefined;
                prunedPassThroughs?: Record<string, string> | undefined;
                outputNodeId?: string | undefined;
                models?:
                  | {
                      type:
                        | "checkpoint"
                        | "lora"
                        | "VAE"
                        | "clip"
                        | "diffusion_model"
                        | "controlnet"
                        | "upscale"
                        | "embeddings"
                        | "clip_vision"
                        | "unet";
                      url: string;
                      filename: string;
                      nodeId?: string | undefined;
                      savePath?: string | undefined;
                      base?: string | undefined;
                      displayName?: string | undefined;
                    }[]
                  | undefined;
                nodes?:
                  | {
                      id: string;
                    }[]
                  | undefined;
                inputLabels?: Record<string, string> | undefined;
                turboInputs?: Record<string, unknown> | undefined;
                deterministic?: boolean | undefined;
              }
            >,
            z.ZodObject<
              {
                deterministic: z.ZodOptional<z.ZodBoolean>;
                kind: z.ZodLiteral<"file">;
                path: z.ZodString;
                type: z.ZodOptional<z.ZodEnum<["image", "video", "audio"]>>;
              },
              "strip",
              z.ZodTypeAny,
              {
                kind: "file";
                path: string;
                type?: "image" | "video" | "audio" | undefined;
                deterministic?: boolean | undefined;
              },
              {
                kind: "file";
                path: string;
                type?: "image" | "video" | "audio" | undefined;
                deterministic?: boolean | undefined;
              }
            >,
            z.ZodObject<
              {
                deterministic: z.ZodOptional<z.ZodBoolean>;
                kind: z.ZodLiteral<"fal">;
                endpointId: z.ZodString;
                mediaType: z.ZodEnum<["image", "video", "audio"]>;
                inputs: z.ZodRecord<z.ZodString, z.ZodUnknown>;
                inputLabels: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>;
                turboInputs: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
              },
              "strip",
              z.ZodTypeAny,
              {
                kind: "fal";
                inputs: Record<string, unknown>;
                endpointId: string;
                mediaType: "image" | "video" | "audio";
                inputLabels?: Record<string, string> | undefined;
                turboInputs?: Record<string, unknown> | undefined;
                deterministic?: boolean | undefined;
              },
              {
                kind: "fal";
                inputs: Record<string, unknown>;
                endpointId: string;
                mediaType: "image" | "video" | "audio";
                inputLabels?: Record<string, string> | undefined;
                turboInputs?: Record<string, unknown> | undefined;
                deterministic?: boolean | undefined;
              }
            >,
            z.ZodObject<
              {
                deterministic: z.ZodOptional<z.ZodBoolean>;
                kind: z.ZodLiteral<"local">;
                operation: z.ZodEnum<
                  ["resize", "crop", "blank", "trim", "retime", "frame", "render"]
                >;
                mediaType: z.ZodEnum<["image", "video", "audio"]>;
                inputs: z.ZodRecord<z.ZodString, z.ZodUnknown>;
              },
              "strip",
              z.ZodTypeAny,
              {
                kind: "local";
                inputs: Record<string, unknown>;
                mediaType: "image" | "video" | "audio";
                operation: "trim" | "resize" | "crop" | "blank" | "retime" | "frame" | "render";
                deterministic?: boolean | undefined;
              },
              {
                kind: "local";
                inputs: Record<string, unknown>;
                mediaType: "image" | "video" | "audio";
                operation: "trim" | "resize" | "crop" | "blank" | "retime" | "frame" | "render";
                deterministic?: boolean | undefined;
              }
            >,
          ]
        >
      >
    >;
    timelineSoundtracks: z.ZodOptional<
      z.ZodType<
        readonly SoundtrackEntry<string>[],
        z.ZodTypeDef,
        readonly SoundtrackEntry<string>[]
      >
    >;
    timelineFn: z.ZodOptional<z.ZodType<TimelineFunction, z.ZodTypeDef, TimelineFunction>>;
    prompts: z.ZodOptional<
      z.ZodType<readonly PromptOccurrence[], z.ZodTypeDef, readonly PromptOccurrence[]>
    >;
    pins: z.ZodOptional<
      z.ZodType<readonly PinOccurrence[], z.ZodTypeDef, readonly PinOccurrence[]>
    >;
    imageInputs: z.ZodOptional<
      z.ZodType<readonly ImageInputOccurrence[], z.ZodTypeDef, readonly ImageInputOccurrence[]>
    >;
    prevPanelReaders: z.ZodOptional<z.ZodType<readonly string[], z.ZodTypeDef, readonly string[]>>;
    waivers: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>;
    respellings: z.ZodOptional<
      z.ZodArray<
        z.ZodObject<
          {
            shot: z.ZodOptional<z.ZodString>;
            line: z.ZodString;
            as: z.ZodString;
          },
          "strip",
          z.ZodTypeAny,
          {
            line: string;
            as: string;
            shot?: string | undefined;
          },
          {
            line: string;
            as: string;
            shot?: string | undefined;
          }
        >,
        "many"
      >
    >;
  } & {
    stage: z.ZodLiteral<"animatic">;
    plates: z.ZodOptional<
      z.ZodRecord<
        z.ZodString,
        z.ZodDiscriminatedUnion<
          "kind",
          [
            z.ZodObject<
              {
                deterministic: z.ZodOptional<z.ZodBoolean>;
                kind: z.ZodLiteral<"comfy">;
                workflow: z.ZodString;
                inputs: z.ZodRecord<z.ZodString, z.ZodUnknown>;
                prunedNodes: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
                prunedPassThroughs: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>;
                outputNodeId: z.ZodOptional<z.ZodString>;
                models: z.ZodOptional<
                  z.ZodArray<
                    z.ZodObject<
                      {
                        filename: z.ZodString;
                        type: z.ZodEnum<
                          [
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
                          ]
                        >;
                        nodeId: z.ZodOptional<z.ZodString>;
                        url: z.ZodString;
                        savePath: z.ZodOptional<z.ZodString>;
                        base: z.ZodOptional<z.ZodString>;
                        displayName: z.ZodOptional<z.ZodString>;
                      },
                      "strip",
                      z.ZodTypeAny,
                      {
                        type:
                          | "checkpoint"
                          | "lora"
                          | "VAE"
                          | "clip"
                          | "diffusion_model"
                          | "controlnet"
                          | "upscale"
                          | "embeddings"
                          | "clip_vision"
                          | "unet";
                        url: string;
                        filename: string;
                        nodeId?: string | undefined;
                        savePath?: string | undefined;
                        base?: string | undefined;
                        displayName?: string | undefined;
                      },
                      {
                        type:
                          | "checkpoint"
                          | "lora"
                          | "VAE"
                          | "clip"
                          | "diffusion_model"
                          | "controlnet"
                          | "upscale"
                          | "embeddings"
                          | "clip_vision"
                          | "unet";
                        url: string;
                        filename: string;
                        nodeId?: string | undefined;
                        savePath?: string | undefined;
                        base?: string | undefined;
                        displayName?: string | undefined;
                      }
                    >,
                    "many"
                  >
                >;
                nodes: z.ZodOptional<
                  z.ZodArray<
                    z.ZodObject<
                      {
                        id: z.ZodString;
                      },
                      "strip",
                      z.ZodTypeAny,
                      {
                        id: string;
                      },
                      {
                        id: string;
                      }
                    >,
                    "many"
                  >
                >;
                inputLabels: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>;
                turboInputs: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
              },
              "strip",
              z.ZodTypeAny,
              {
                kind: "comfy";
                workflow: string;
                inputs: Record<string, unknown>;
                prunedNodes?: string[] | undefined;
                prunedPassThroughs?: Record<string, string> | undefined;
                outputNodeId?: string | undefined;
                models?:
                  | {
                      type:
                        | "checkpoint"
                        | "lora"
                        | "VAE"
                        | "clip"
                        | "diffusion_model"
                        | "controlnet"
                        | "upscale"
                        | "embeddings"
                        | "clip_vision"
                        | "unet";
                      url: string;
                      filename: string;
                      nodeId?: string | undefined;
                      savePath?: string | undefined;
                      base?: string | undefined;
                      displayName?: string | undefined;
                    }[]
                  | undefined;
                nodes?:
                  | {
                      id: string;
                    }[]
                  | undefined;
                inputLabels?: Record<string, string> | undefined;
                turboInputs?: Record<string, unknown> | undefined;
                deterministic?: boolean | undefined;
              },
              {
                kind: "comfy";
                workflow: string;
                inputs: Record<string, unknown>;
                prunedNodes?: string[] | undefined;
                prunedPassThroughs?: Record<string, string> | undefined;
                outputNodeId?: string | undefined;
                models?:
                  | {
                      type:
                        | "checkpoint"
                        | "lora"
                        | "VAE"
                        | "clip"
                        | "diffusion_model"
                        | "controlnet"
                        | "upscale"
                        | "embeddings"
                        | "clip_vision"
                        | "unet";
                      url: string;
                      filename: string;
                      nodeId?: string | undefined;
                      savePath?: string | undefined;
                      base?: string | undefined;
                      displayName?: string | undefined;
                    }[]
                  | undefined;
                nodes?:
                  | {
                      id: string;
                    }[]
                  | undefined;
                inputLabels?: Record<string, string> | undefined;
                turboInputs?: Record<string, unknown> | undefined;
                deterministic?: boolean | undefined;
              }
            >,
            z.ZodObject<
              {
                deterministic: z.ZodOptional<z.ZodBoolean>;
                kind: z.ZodLiteral<"file">;
                path: z.ZodString;
                type: z.ZodOptional<z.ZodEnum<["image", "video", "audio"]>>;
              },
              "strip",
              z.ZodTypeAny,
              {
                kind: "file";
                path: string;
                type?: "image" | "video" | "audio" | undefined;
                deterministic?: boolean | undefined;
              },
              {
                kind: "file";
                path: string;
                type?: "image" | "video" | "audio" | undefined;
                deterministic?: boolean | undefined;
              }
            >,
            z.ZodObject<
              {
                deterministic: z.ZodOptional<z.ZodBoolean>;
                kind: z.ZodLiteral<"fal">;
                endpointId: z.ZodString;
                mediaType: z.ZodEnum<["image", "video", "audio"]>;
                inputs: z.ZodRecord<z.ZodString, z.ZodUnknown>;
                inputLabels: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>;
                turboInputs: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
              },
              "strip",
              z.ZodTypeAny,
              {
                kind: "fal";
                inputs: Record<string, unknown>;
                endpointId: string;
                mediaType: "image" | "video" | "audio";
                inputLabels?: Record<string, string> | undefined;
                turboInputs?: Record<string, unknown> | undefined;
                deterministic?: boolean | undefined;
              },
              {
                kind: "fal";
                inputs: Record<string, unknown>;
                endpointId: string;
                mediaType: "image" | "video" | "audio";
                inputLabels?: Record<string, string> | undefined;
                turboInputs?: Record<string, unknown> | undefined;
                deterministic?: boolean | undefined;
              }
            >,
            z.ZodObject<
              {
                deterministic: z.ZodOptional<z.ZodBoolean>;
                kind: z.ZodLiteral<"local">;
                operation: z.ZodEnum<
                  ["resize", "crop", "blank", "trim", "retime", "frame", "render"]
                >;
                mediaType: z.ZodEnum<["image", "video", "audio"]>;
                inputs: z.ZodRecord<z.ZodString, z.ZodUnknown>;
              },
              "strip",
              z.ZodTypeAny,
              {
                kind: "local";
                inputs: Record<string, unknown>;
                mediaType: "image" | "video" | "audio";
                operation: "trim" | "resize" | "crop" | "blank" | "retime" | "frame" | "render";
                deterministic?: boolean | undefined;
              },
              {
                kind: "local";
                inputs: Record<string, unknown>;
                mediaType: "image" | "video" | "audio";
                operation: "trim" | "resize" | "crop" | "blank" | "retime" | "frame" | "render";
                deterministic?: boolean | undefined;
              }
            >,
          ]
        >
      >
    >;
    exposedPlateIds: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
    platePrompts: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>;
  },
  "strip",
  z.ZodTypeAny,
  {
    stage: "animatic";
    shots: {
      duration: number;
      id: string;
      assets: Record<
        string,
        | {
            kind: "comfy";
            workflow: string;
            inputs: Record<string, unknown>;
            prunedNodes?: string[] | undefined;
            prunedPassThroughs?: Record<string, string> | undefined;
            outputNodeId?: string | undefined;
            models?:
              | {
                  type:
                    | "checkpoint"
                    | "lora"
                    | "VAE"
                    | "clip"
                    | "diffusion_model"
                    | "controlnet"
                    | "upscale"
                    | "embeddings"
                    | "clip_vision"
                    | "unet";
                  url: string;
                  filename: string;
                  nodeId?: string | undefined;
                  savePath?: string | undefined;
                  base?: string | undefined;
                  displayName?: string | undefined;
                }[]
              | undefined;
            nodes?:
              | {
                  id: string;
                }[]
              | undefined;
            inputLabels?: Record<string, string> | undefined;
            turboInputs?: Record<string, unknown> | undefined;
            deterministic?: boolean | undefined;
          }
        | {
            kind: "file";
            path: string;
            type?: "image" | "video" | "audio" | undefined;
            deterministic?: boolean | undefined;
          }
        | {
            kind: "fal";
            inputs: Record<string, unknown>;
            endpointId: string;
            mediaType: "image" | "video" | "audio";
            inputLabels?: Record<string, string> | undefined;
            turboInputs?: Record<string, unknown> | undefined;
            deterministic?: boolean | undefined;
          }
        | {
            kind: "local";
            inputs: Record<string, unknown>;
            mediaType: "image" | "video" | "audio";
            operation: "trim" | "resize" | "crop" | "blank" | "retime" | "frame" | "render";
            deterministic?: boolean | undefined;
          }
      >;
      action: string;
      pending?: true | undefined;
      shotFn?: ShotFunction | undefined;
      compositionRefs?: string[] | undefined;
      pictureRefs?: string[] | undefined;
      stemRefs?: string[] | undefined;
      narrationStemRefs?: string[] | undefined;
      cueKinds?: Record<string, "voice" | "narration" | "mob" | "sfx"> | undefined;
      panels?:
        | {
            duration: number;
            assetName: string;
            assetPath: string;
            start: number;
            blocking?: string | undefined;
            camera?: string | undefined;
          }[]
        | undefined;
      cutin?:
        | {
            refs: string[];
            panels?:
              | {
                  duration: number;
                  assetName: string;
                  assetPath: string;
                  start: number;
                  blocking?: string | undefined;
                  camera?: string | undefined;
                }[]
              | undefined;
            sharedRefs?: string[] | undefined;
          }
        | undefined;
      continuedBy?:
        | {
            main?: string | undefined;
            cutin?: string | undefined;
          }
        | undefined;
      graphic?: true | undefined;
      aside?: true | undefined;
    }[];
    format: {
      fps: number;
      size: {
        width: number;
        height: number;
      };
    };
    typography: {
      lang: LanguageTag;
      fonts?: string[] | undefined;
    };
    topLevelAssets?:
      | Record<
          string,
          | {
              kind: "comfy";
              workflow: string;
              inputs: Record<string, unknown>;
              prunedNodes?: string[] | undefined;
              prunedPassThroughs?: Record<string, string> | undefined;
              outputNodeId?: string | undefined;
              models?:
                | {
                    type:
                      | "checkpoint"
                      | "lora"
                      | "VAE"
                      | "clip"
                      | "diffusion_model"
                      | "controlnet"
                      | "upscale"
                      | "embeddings"
                      | "clip_vision"
                      | "unet";
                    url: string;
                    filename: string;
                    nodeId?: string | undefined;
                    savePath?: string | undefined;
                    base?: string | undefined;
                    displayName?: string | undefined;
                  }[]
                | undefined;
              nodes?:
                | {
                    id: string;
                  }[]
                | undefined;
              inputLabels?: Record<string, string> | undefined;
              turboInputs?: Record<string, unknown> | undefined;
              deterministic?: boolean | undefined;
            }
          | {
              kind: "file";
              path: string;
              type?: "image" | "video" | "audio" | undefined;
              deterministic?: boolean | undefined;
            }
          | {
              kind: "fal";
              inputs: Record<string, unknown>;
              endpointId: string;
              mediaType: "image" | "video" | "audio";
              inputLabels?: Record<string, string> | undefined;
              turboInputs?: Record<string, unknown> | undefined;
              deterministic?: boolean | undefined;
            }
          | {
              kind: "local";
              inputs: Record<string, unknown>;
              mediaType: "image" | "video" | "audio";
              operation: "trim" | "resize" | "crop" | "blank" | "retime" | "frame" | "render";
              deterministic?: boolean | undefined;
            }
        >
      | undefined;
    prompts?: readonly PromptOccurrence[] | undefined;
    pins?: readonly PinOccurrence[] | undefined;
    waivers?: Record<string, string> | undefined;
    timelineSoundtracks?: readonly SoundtrackEntry<string>[] | undefined;
    timelineFn?: TimelineFunction | undefined;
    imageInputs?: readonly ImageInputOccurrence[] | undefined;
    prevPanelReaders?: readonly string[] | undefined;
    respellings?:
      | {
          line: string;
          as: string;
          shot?: string | undefined;
        }[]
      | undefined;
    plates?:
      | Record<
          string,
          | {
              kind: "comfy";
              workflow: string;
              inputs: Record<string, unknown>;
              prunedNodes?: string[] | undefined;
              prunedPassThroughs?: Record<string, string> | undefined;
              outputNodeId?: string | undefined;
              models?:
                | {
                    type:
                      | "checkpoint"
                      | "lora"
                      | "VAE"
                      | "clip"
                      | "diffusion_model"
                      | "controlnet"
                      | "upscale"
                      | "embeddings"
                      | "clip_vision"
                      | "unet";
                    url: string;
                    filename: string;
                    nodeId?: string | undefined;
                    savePath?: string | undefined;
                    base?: string | undefined;
                    displayName?: string | undefined;
                  }[]
                | undefined;
              nodes?:
                | {
                    id: string;
                  }[]
                | undefined;
              inputLabels?: Record<string, string> | undefined;
              turboInputs?: Record<string, unknown> | undefined;
              deterministic?: boolean | undefined;
            }
          | {
              kind: "file";
              path: string;
              type?: "image" | "video" | "audio" | undefined;
              deterministic?: boolean | undefined;
            }
          | {
              kind: "fal";
              inputs: Record<string, unknown>;
              endpointId: string;
              mediaType: "image" | "video" | "audio";
              inputLabels?: Record<string, string> | undefined;
              turboInputs?: Record<string, unknown> | undefined;
              deterministic?: boolean | undefined;
            }
          | {
              kind: "local";
              inputs: Record<string, unknown>;
              mediaType: "image" | "video" | "audio";
              operation: "trim" | "resize" | "crop" | "blank" | "retime" | "frame" | "render";
              deterministic?: boolean | undefined;
            }
        >
      | undefined;
    exposedPlateIds?: string[] | undefined;
    platePrompts?: Record<string, string> | undefined;
  },
  {
    stage: "animatic";
    shots: {
      duration: number;
      id: string;
      assets: Record<
        string,
        | {
            kind: "comfy";
            workflow: string;
            inputs: Record<string, unknown>;
            prunedNodes?: string[] | undefined;
            prunedPassThroughs?: Record<string, string> | undefined;
            outputNodeId?: string | undefined;
            models?:
              | {
                  type:
                    | "checkpoint"
                    | "lora"
                    | "VAE"
                    | "clip"
                    | "diffusion_model"
                    | "controlnet"
                    | "upscale"
                    | "embeddings"
                    | "clip_vision"
                    | "unet";
                  url: string;
                  filename: string;
                  nodeId?: string | undefined;
                  savePath?: string | undefined;
                  base?: string | undefined;
                  displayName?: string | undefined;
                }[]
              | undefined;
            nodes?:
              | {
                  id: string;
                }[]
              | undefined;
            inputLabels?: Record<string, string> | undefined;
            turboInputs?: Record<string, unknown> | undefined;
            deterministic?: boolean | undefined;
          }
        | {
            kind: "file";
            path: string;
            type?: "image" | "video" | "audio" | undefined;
            deterministic?: boolean | undefined;
          }
        | {
            kind: "fal";
            inputs: Record<string, unknown>;
            endpointId: string;
            mediaType: "image" | "video" | "audio";
            inputLabels?: Record<string, string> | undefined;
            turboInputs?: Record<string, unknown> | undefined;
            deterministic?: boolean | undefined;
          }
        | {
            kind: "local";
            inputs: Record<string, unknown>;
            mediaType: "image" | "video" | "audio";
            operation: "trim" | "resize" | "crop" | "blank" | "retime" | "frame" | "render";
            deterministic?: boolean | undefined;
          }
      >;
      action: string;
      pending?: true | undefined;
      shotFn?: ShotFunction | undefined;
      compositionRefs?: string[] | undefined;
      pictureRefs?: string[] | undefined;
      stemRefs?: string[] | undefined;
      narrationStemRefs?: string[] | undefined;
      cueKinds?: Record<string, "voice" | "narration" | "mob" | "sfx"> | undefined;
      panels?:
        | {
            duration: number;
            assetName: string;
            assetPath: string;
            start: number;
            blocking?: string | undefined;
            camera?: string | undefined;
          }[]
        | undefined;
      cutin?:
        | {
            refs: string[];
            panels?:
              | {
                  duration: number;
                  assetName: string;
                  assetPath: string;
                  start: number;
                  blocking?: string | undefined;
                  camera?: string | undefined;
                }[]
              | undefined;
            sharedRefs?: string[] | undefined;
          }
        | undefined;
      continuedBy?:
        | {
            main?: string | undefined;
            cutin?: string | undefined;
          }
        | undefined;
      graphic?: true | undefined;
      aside?: true | undefined;
    }[];
    format: {
      fps: number;
      size: {
        width: number;
        height: number;
      };
    };
    typography: {
      lang: LanguageTag;
      fonts?: string[] | undefined;
    };
    topLevelAssets?:
      | Record<
          string,
          | {
              kind: "comfy";
              workflow: string;
              inputs: Record<string, unknown>;
              prunedNodes?: string[] | undefined;
              prunedPassThroughs?: Record<string, string> | undefined;
              outputNodeId?: string | undefined;
              models?:
                | {
                    type:
                      | "checkpoint"
                      | "lora"
                      | "VAE"
                      | "clip"
                      | "diffusion_model"
                      | "controlnet"
                      | "upscale"
                      | "embeddings"
                      | "clip_vision"
                      | "unet";
                    url: string;
                    filename: string;
                    nodeId?: string | undefined;
                    savePath?: string | undefined;
                    base?: string | undefined;
                    displayName?: string | undefined;
                  }[]
                | undefined;
              nodes?:
                | {
                    id: string;
                  }[]
                | undefined;
              inputLabels?: Record<string, string> | undefined;
              turboInputs?: Record<string, unknown> | undefined;
              deterministic?: boolean | undefined;
            }
          | {
              kind: "file";
              path: string;
              type?: "image" | "video" | "audio" | undefined;
              deterministic?: boolean | undefined;
            }
          | {
              kind: "fal";
              inputs: Record<string, unknown>;
              endpointId: string;
              mediaType: "image" | "video" | "audio";
              inputLabels?: Record<string, string> | undefined;
              turboInputs?: Record<string, unknown> | undefined;
              deterministic?: boolean | undefined;
            }
          | {
              kind: "local";
              inputs: Record<string, unknown>;
              mediaType: "image" | "video" | "audio";
              operation: "trim" | "resize" | "crop" | "blank" | "retime" | "frame" | "render";
              deterministic?: boolean | undefined;
            }
        >
      | undefined;
    prompts?: readonly PromptOccurrence[] | undefined;
    pins?: readonly PinOccurrence[] | undefined;
    waivers?: Record<string, string> | undefined;
    timelineSoundtracks?: readonly SoundtrackEntry<string>[] | undefined;
    timelineFn?: TimelineFunction | undefined;
    imageInputs?: readonly ImageInputOccurrence[] | undefined;
    prevPanelReaders?: readonly string[] | undefined;
    respellings?:
      | {
          line: string;
          as: string;
          shot?: string | undefined;
        }[]
      | undefined;
    plates?:
      | Record<
          string,
          | {
              kind: "comfy";
              workflow: string;
              inputs: Record<string, unknown>;
              prunedNodes?: string[] | undefined;
              prunedPassThroughs?: Record<string, string> | undefined;
              outputNodeId?: string | undefined;
              models?:
                | {
                    type:
                      | "checkpoint"
                      | "lora"
                      | "VAE"
                      | "clip"
                      | "diffusion_model"
                      | "controlnet"
                      | "upscale"
                      | "embeddings"
                      | "clip_vision"
                      | "unet";
                    url: string;
                    filename: string;
                    nodeId?: string | undefined;
                    savePath?: string | undefined;
                    base?: string | undefined;
                    displayName?: string | undefined;
                  }[]
                | undefined;
              nodes?:
                | {
                    id: string;
                  }[]
                | undefined;
              inputLabels?: Record<string, string> | undefined;
              turboInputs?: Record<string, unknown> | undefined;
              deterministic?: boolean | undefined;
            }
          | {
              kind: "file";
              path: string;
              type?: "image" | "video" | "audio" | undefined;
              deterministic?: boolean | undefined;
            }
          | {
              kind: "fal";
              inputs: Record<string, unknown>;
              endpointId: string;
              mediaType: "image" | "video" | "audio";
              inputLabels?: Record<string, string> | undefined;
              turboInputs?: Record<string, unknown> | undefined;
              deterministic?: boolean | undefined;
            }
          | {
              kind: "local";
              inputs: Record<string, unknown>;
              mediaType: "image" | "video" | "audio";
              operation: "trim" | "resize" | "crop" | "blank" | "retime" | "frame" | "render";
              deterministic?: boolean | undefined;
            }
        >
      | undefined;
    exposedPlateIds?: string[] | undefined;
    platePrompts?: Record<string, string> | undefined;
  }
>;
export type AnimaticDefinition = z.infer<typeof AnimaticDefinitionSchema>;
/**
 * The dramatic function a role performs — the five-stage skeleton the classical arc schemas share
 * (Freytag's pyramid, three-act, kishōtenketsu): ground establishes a state, turn breaks it, build
 * escalates it, payoff lands the climax, settle lets it ring.
 */
export type BeatFunction = "ground" | "turn" | "build" | "payoff" | "settle";
export type ArcItem<Role extends string> = {
  id: string;
  role: Role;
  synopsis: string;
  duration?: number;
  framing?: string;
  location?: string;
  join?: string;
  axis?: string;
  afterGap?: true;
};
export type Beat<Role extends string> = {
  role: Role;
  fn?: BeatFunction;
  required?: boolean;
  minConsecutive?: number;
  maxConsecutive?: number;
  minShare?: number;
  maxShare?: number;
};
export type LensSpec<Role extends string> = {
  name: string;
  beats: Beat<Role>[];
  payoff: Role;
};
/**
 * Fixed contract, like KonteErrorCode: doctor / waiver keys / scripts branch on these. The same
 * codes are reused at both scales — the subject (role / id / range) distinguishes instances.
 */
export type DirectionFindingCode =
  | "missing-beat"
  | "no-payoff"
  | "beat-out-of-order"
  | "lens-role-mismatch"
  | "too-many-consecutive"
  | "too-few-consecutive"
  | "empty-synopsis"
  | "unearned-payoff"
  | "unrealized"
  | "stage-order-mismatch"
  | "beat-overweight"
  | "beat-underweight"
  | "character-unreferenced"
  | "unused-character"
  | "character-voice-missing"
  | "character-voice-unreferenced"
  | "unused-character-voice"
  | "narrator-missing"
  | "narrator-unreferenced"
  | "unused-narrator"
  | "prop-unreferenced"
  | "unused-prop"
  | "location-unreferenced"
  | "unused-location"
  | "setup-unrealized"
  | "plate-unanchored"
  | "setup-unconsumed"
  | "plate-unnested"
  | "axis-unrealized"
  | "unused-setup"
  | "setup-indistinct"
  | "setup-atomized"
  | "unexpected-script"
  | "multi-sentence-action"
  | "off-grid-duration"
  | "undeclared-continuity"
  | "re-established-wide"
  | "fonts-undeclared"
  | "lineup-flipped"
  | "lineup-gap"
  | "lineup-vacuous"
  | "lineup-inconsistent"
  | "character-unconsumed"
  | "slot-order-mismatch"
  | "plate-undescribed"
  | "join-lineup-mismatch"
  | "join-unpinned"
  | "join-unshown"
  | "panel-unlinked"
  | "landmark-flipped"
  | "subject-unnamed"
  | "plate-unnamed";
export type DirectionFinding = {
  code: DirectionFindingCode;
  subject?: string;
  path?: readonly string[];
  message: string;
};
export type CheckArcOptions = {
  realizedIds?: readonly string[];
  coverageIds?: readonly string[];
  noun?: string;
  textLabel?: string;
  exposedFramings?: readonly string[];
  establishingFraming?: string;
};
export declare function checkArc<Role extends string>(
  lens: LensSpec<Role>,
  items: ArcItem<Role>[],
  options?: CheckArcOptions,
): DirectionFinding[];
/**
 * The emotional reward a video aims for — orthogonal to the lens (structure): a `mini-drama` can be
 * `cute` or `scary`. Every node names one, root and child alike.
 */
export type Pleasure =
  | "cute"
  | "funny"
  | "cool"
  | "beautiful"
  | "scary"
  | "satisfying"
  | "surprising"
  | "emotional"
  | "mysterious"
  | "awe";
/**
 * The built-in lenses. Each beat names a `role` and the dramatic `fn` it performs in this lens, so
 * the engine checks theory ("a climax must be earned") off the beat itself. A beat with no `fn` is a
 * container, exempt from the function checks — no built-in declares one; a project opts out of the
 * arc engine in its own `defineLens`. Share budgets are act-ratio guards — a grounding beat past ~40%
 * of the runtime is front-loaded, a settling beat past ~25% outstays the climax it is meant to let
 * ring. Both are waivable pacing findings, never targets. A lens over shots and a lens over sequences
 * live in one registry: any node names any lens, and the checker only flags a role its lens does not
 * declare (a waivable `lens-role-mismatch`).
 */
export declare const BUILTIN_LENSES: readonly [
  {
    readonly name: "mini-drama";
    readonly payoff: "hero";
    readonly beats: [
      {
        readonly role: "ordinary";
        readonly fn: "ground";
        readonly maxShare: 0.4;
      },
      {
        readonly role: "disruption";
        readonly fn: "turn";
      },
      {
        readonly role: "pressure";
        readonly fn: "build";
        readonly maxConsecutive: 3;
      },
      {
        readonly role: "hero";
        readonly fn: "payoff";
      },
      {
        readonly role: "release";
        readonly fn: "settle";
        readonly required: false;
        readonly maxShare: 0.25;
      },
    ];
  },
  {
    readonly name: "comedy";
    readonly payoff: "button";
    readonly beats: [
      {
        readonly role: "setup";
        readonly fn: "ground";
      },
      {
        readonly role: "violation";
        readonly fn: "turn";
      },
      {
        readonly role: "escalation";
        readonly fn: "build";
        readonly required: false;
      },
      {
        readonly role: "button";
        readonly fn: "payoff";
      },
    ];
  },
  {
    readonly name: "satisfying-process";
    readonly payoff: "completion";
    readonly beats: [
      {
        readonly role: "before";
        readonly fn: "ground";
        readonly maxShare: 0.4;
      },
      {
        readonly role: "method";
        readonly fn: "build";
      },
      {
        readonly role: "rhythm";
        readonly fn: "build";
        readonly minConsecutive: 2;
      },
      {
        readonly role: "completion";
        readonly fn: "payoff";
      },
      {
        readonly role: "after-glow";
        readonly fn: "settle";
        readonly required: false;
        readonly maxShare: 0.25;
      },
    ];
  },
  {
    readonly name: "mood-piece";
    readonly payoff: "peak";
    readonly beats: [
      {
        readonly role: "atmosphere";
        readonly fn: "ground";
      },
      {
        readonly role: "motif";
        readonly fn: "build";
      },
      {
        readonly role: "variation";
        readonly fn: "build";
      },
      {
        readonly role: "peak";
        readonly fn: "payoff";
      },
      {
        readonly role: "fade";
        readonly fn: "settle";
        readonly required: false;
        readonly maxShare: 0.25;
      },
    ];
  },
  {
    readonly name: "transformation";
    readonly payoff: "reveal";
    readonly beats: [
      {
        readonly role: "before";
        readonly fn: "ground";
        readonly maxShare: 0.4;
      },
      {
        readonly role: "process";
        readonly fn: "build";
        readonly minConsecutive: 2;
      },
      {
        readonly role: "reveal";
        readonly fn: "payoff";
      },
      {
        readonly role: "after-glow";
        readonly fn: "settle";
        readonly required: false;
        readonly maxShare: 0.25;
      },
    ];
  },
  {
    readonly name: "product-demo";
    readonly payoff: "result";
    readonly beats: [
      {
        readonly role: "problem";
        readonly fn: "ground";
        readonly maxShare: 0.4;
      },
      {
        readonly role: "solution";
        readonly fn: "turn";
      },
      {
        readonly role: "demonstration";
        readonly fn: "build";
      },
      {
        readonly role: "result";
        readonly fn: "payoff";
      },
      {
        readonly role: "call-to-action";
        readonly fn: "settle";
        readonly required: false;
        readonly maxShare: 0.2;
      },
    ];
  },
  {
    readonly name: "kishotenketsu";
    readonly payoff: "ketsu";
    readonly beats: [
      {
        readonly role: "ki";
        readonly fn: "ground";
        readonly maxShare: 0.4;
      },
      {
        readonly role: "sho";
        readonly fn: "build";
      },
      {
        readonly role: "ten";
        readonly fn: "turn";
      },
      {
        readonly role: "ketsu";
        readonly fn: "payoff";
      },
    ];
  },
  {
    readonly name: "three-act";
    readonly payoff: "climax-act";
    readonly beats: [
      {
        readonly role: "setup-act";
        readonly fn: "ground";
        readonly maxShare: 0.4;
      },
      {
        readonly role: "confrontation-act";
        readonly fn: "build";
      },
      {
        readonly role: "climax-act";
        readonly fn: "payoff";
        readonly minShare: 0.15;
      },
      {
        readonly role: "resolution-act";
        readonly fn: "settle";
        readonly required: false;
      },
    ];
  },
];
/**
 * One built-in lens, with its name and role literals intact — what the type layer reads to pin a
 * node's `role` to the lens it names. A `defineLens` spec widens to `LensSpec<string>`, so a custom
 * lens is not in this union and its roles fall through to `lens-role-mismatch`.
 */
export type BuiltinLens = (typeof BUILTIN_LENSES)[number];
export declare function findBuiltinLens(name: string): LensSpec<string> | undefined;
export type LensSpecInput = {
  name: string;
  payoff: string;
  beats: readonly Beat<string>[];
};
export declare function defineLens(spec: LensSpecInput): LensSpec<string>;
export type CanvasSize = {
  width: number;
  height: number;
};
/**
 * The authored half of `policy.format.size`: what ships, and what it may cost to get there.
 */
export type CanvasBudget = {
  megapixels: number;
  delivery: CanvasSize;
};
/**
 * A reference sheet's shape: a character is portrait, a location is a master, and a prop is squared,
 * as is anything outside the rosters.
 */
export type ReferenceShape = "portrait" | "square" | "master";
declare const ScriptLineSchema: z.ZodUnion<
  [
    z.ZodObject<
      {
        character: z.ZodString;
        text: z.ZodString;
        acting: z.ZodOptional<z.ZodString>;
      },
      "strip",
      z.ZodTypeAny,
      {
        text: string;
        character: string;
        acting?: string | undefined;
      },
      {
        text: string;
        character: string;
        acting?: string | undefined;
      }
    >,
    z.ZodObject<
      {
        speaker: z.ZodString;
        text: z.ZodString;
        acting: z.ZodOptional<z.ZodNever>;
      },
      "strip",
      z.ZodTypeAny,
      {
        text: string;
        speaker: string;
        acting?: undefined;
      },
      {
        text: string;
        speaker: string;
        acting?: undefined;
      }
    >,
    z.ZodObject<
      {
        narration: z.ZodString;
        acting: z.ZodOptional<z.ZodNever>;
      },
      "strip",
      z.ZodTypeAny,
      {
        narration: string;
        acting?: undefined;
      },
      {
        narration: string;
        acting?: undefined;
      }
    >,
  ]
>;
export type ScriptLine = z.infer<typeof ScriptLineSchema>;
declare const SHOT_LINES: unique symbol;
export type WhoOf<L> = L extends {
  character: infer C extends string;
}
  ? C
  : L extends {
        speaker: string;
      }
    ? "speaker"
    : "narration";
export type TextOf<L> = L extends {
  narration: infer N extends string;
}
  ? N
  : L extends {
        text: infer T extends string;
      }
    ? T
    : string;
export type SpeakerOf<S extends readonly unknown[]> = WhoOf<S[number]>;
export type TextsBy<
  S extends readonly unknown[],
  W extends string,
  Acc extends readonly string[] = [],
> = S extends readonly [infer H, ...infer T]
  ? TextsBy<T, W, WhoOf<H> extends W ? [...Acc, TextOf<H>] : Acc>
  : S extends readonly []
    ? Acc
    : readonly string[];
/**
 * What a stage's `build`/`animatic` receives as `script`: the shot's words keyed by who says them
 * (`script.cat[0]`, `script.narration[0]`).
 */
export type ShotScript<S extends readonly ScriptLine[] = readonly ScriptLine[]> = {
  readonly [W in SpeakerOf<S>]: TextsBy<S, W>;
} & {
  readonly [SHOT_LINES]: readonly ScriptLine[];
};
/**
 * One animatic shot as `video.tsx` reaches it: its takes by name and kind, plus the `stem` konte
 * mixes from the shot's cues, which an audio-driven motion model takes, and the `narrationStem` it
 * mixes from the narration apart, which only `<Audio>` places.
 *
 * The board shot's own rendering is not reachable; a V2V route wants `#composition` rendered to video
 * first.
 *
 * Each accessor names the media kind it expects and is checked against what the shot actually
 * declared: an unknown name, a kind mismatch, or an undeveloped (pendingShot) target throws while the
 * definition loads.
 */
export interface AnimaticShotRef extends ShotHandle {
  readonly stem: MediaAsset<"audio">;
  readonly narrationStem: NarrationStem;
}
export interface AnimaticRef {
  shot(id: string): AnimaticShotRef;
}
export type MapIds<
  S extends readonly {
    id: string;
  }[],
> = {
  [K in keyof S]: S[K]["id"];
};
export type NodeIdTuple<N> = N extends {
  shots: infer S extends readonly {
    id: string;
  }[];
}
  ? MapIds<S>
  : N extends {
        sequences: infer Q extends readonly unknown[];
      }
    ? FlattenNodeIds<Q>
    : [];
export type FlattenNodeIds<
  Q extends readonly unknown[],
  Acc extends string[] = [],
> = Q extends readonly [infer H, ...infer T extends readonly unknown[]]
  ? FlattenNodeIds<T, [...Acc, ...NodeIdTuple<H>]>
  : Acc;
export type DirectionIdTuple<D> = D extends {
  sequence: infer Root;
}
  ? NodeIdTuple<Root>
  : never;
export type NodeShotTuple<N> = N extends {
  shots: infer S extends readonly {
    id: string;
  }[];
}
  ? S
  : N extends {
        sequences: infer Q extends readonly unknown[];
      }
    ? FlattenNodeShots<Q>
    : [];
export type FlattenNodeShots<
  Q extends readonly unknown[],
  Acc extends readonly {
    id: string;
  }[] = [],
> = Q extends readonly [infer H, ...infer T extends readonly unknown[]]
  ? FlattenNodeShots<T, [...Acc, ...NodeShotTuple<H>]>
  : Acc;
export type DirectionShotTuple<D> = D extends {
  sequence: infer Root;
}
  ? NodeShotTuple<Root>
  : never;
export type ShotOf<D, TId extends string> = Extract<
  DirectionShotTuple<D>[number],
  {
    id: TId;
  }
>;
export type ScriptOf<D, TId extends string> = [ShotOf<D, TId>] extends [never]
  ? readonly ScriptLine[]
  : ShotOf<D, TId> extends {
        script: infer S extends readonly ScriptLine[];
      }
    ? S
    : readonly [];
export type LineupOf<D, TId extends string> = [ShotOf<D, TId>] extends [never]
  ? readonly string[]
  : ShotOf<D, TId> extends {
        lineup: infer L extends readonly string[];
      }
    ? L
    : readonly [];
export type LineupToOf<D, TId extends string> = [ShotOf<D, TId>] extends [never]
  ? readonly string[] | null
  : ShotOf<D, TId> extends {
        lineupTo: infer L extends readonly string[];
      }
    ? L
    : null;
export type CutinOf<D, TId extends string> = [ShotOf<D, TId>] extends [never]
  ? StageCutinContext | null
  : ShotOf<D, TId> extends {
        cutin: infer C;
      }
    ? StageCutinContext<
        C extends {
          lineup: infer L extends readonly string[];
        }
          ? L
          : readonly [],
        C extends {
          lineupTo: infer L extends readonly string[];
        }
          ? L
          : null
      >
    : null;
/**
 * The first direction shot — the only id a chain may start at. Everything after is computed, never typed.
 */
export type FirstShotId<D> = Head<DirectionIdTuple<D>>;
export type ChainRest<D> = Tail<DirectionIdTuple<D>>;
export type Head<Ids extends readonly string[]> = Ids extends readonly [
  infer A extends string,
  ...string[],
]
  ? A
  : never;
export type Tail<Ids extends readonly string[]> = Ids extends readonly [
  string,
  ...infer R extends string[],
]
  ? R
  : [];
/**
 * The shot values a stage `build` receives, injected from the direction. `framing` and `location` are
 * read through the shot's `setup`.
 */
export type StageShotContext<
  S extends readonly ScriptLine[],
  L extends readonly string[] | null = readonly string[] | null,
  LT extends readonly string[] | null = readonly string[] | null,
  C extends StageCutinContext | null = StageCutinContext | null,
> = {
  duration: number;
  setup: string;
  framing: Framing;
  location: string;
  script: ShotScript<S>;
  lineup: L;
  lineupTo: LT;
  cutin: C;
};
/**
 * The second camera frame over a shot, as a build receives it: the direction's `cutin` with its
 * `framing` and `location` read through its setup, and its lineup pair handed over unchanged.
 */
export type StageCutinContext<
  L extends readonly string[] = readonly string[],
  LT extends readonly string[] | null = readonly string[] | null,
> = {
  setup: string;
  framing: Framing;
  location: string;
  lineup: L;
  lineupTo: LT;
};
/**
 * The shot values a GRAPHIC build receives.
 */
export type GraphicShotContext<
  S extends readonly ScriptLine[],
  C extends StageCutinContext | null = StageCutinContext | null,
> = {
  duration: number;
  script: ShotScript<S>;
  cutin: C;
};
/**
 * The shot values an ASIDE build receives. The four fields describing a camera view are absent, not
 * blank. Only the video builds an aside.
 */
export type AsideShotContext = {
  duration: number;
  label: string;
};
export type IsAsideShot<D, Id extends string> =
  ShotOf<D, Id> extends {
    kind: "aside";
  }
    ? true
    : false;
export type IsGraphicShot<D, Id extends string> =
  ShotOf<D, Id> extends {
    kind: "graphic";
  }
    ? true
    : false;
export type NarrativeIdOf<D, Id extends string> = [ShotOf<D, Id>] extends [never]
  ? Id
  : IsAsideShot<D, Id> extends true
    ? never
    : IsGraphicShot<D, Id> extends true
      ? never
      : Id;
export type GraphicIdOf<D, Id extends string> = [ShotOf<D, Id>] extends [never]
  ? Id
  : IsGraphicShot<D, Id> extends true
    ? Id
    : never;
export type ArcIdOf<D, Id extends string> = [ShotOf<D, Id>] extends [never]
  ? Id
  : IsAsideShot<D, Id> extends true
    ? never
    : Id;
export type AsideIdOf<D, Id extends string> = [ShotOf<D, Id>] extends [never]
  ? Id
  : IsAsideShot<D, Id> extends true
    ? Id
    : never;
/**
 * A chain that has not yet reached the final direction shot carries this branded string as `__complete`
 * instead of `true`, so returning it from `timeline` fails with a message naming the first gap.
 */
export type ChainIncomplete<Missing extends string> =
  `konte: shot chain is missing shot "${Missing}" — keep calling .nextShot until every direction shot is covered`;
export type ChainComplete<TRest extends readonly string[]> = TRest extends readonly []
  ? true
  : ChainIncomplete<Head<TRest>>;
/**
 * A stage's shot list, built by walking the direction with `.nextShot` / `.nextPendingShot`. The
 * injected `shot(firstId, …)` or `pendingShot(firstId)` starts it (id pinned to `FirstShotId`); each
 * step mints the *successor* shot — its id is computed from the direction, never passed — and hands
 * every shot placed so far to the build as `shot`. `timeline` must return a chain whose `__complete` is
 * `true`, which only holds once the last shot is reached, so order and full coverage are both
 * enforced by the type. `__shotIds` accumulates the covered ids so timeline soundtrack anchors are
 * checked against them. No terminal call: the engine reads `__shots` directly.
 */
export interface StageChain<
  D,
  TRest extends readonly string[],
  TIds extends string,
  TStage extends ShotStage,
> {
  readonly __complete: ChainComplete<TRest>;
  readonly __shots: readonly AnyShotInput[];
  readonly __shotIds: TIds;
  nextShot(
    id: NarrativeIdOf<D, Head<TRest>>,
    build: (
      ctx: StageShotContext<
        ScriptOf<D, Head<TRest>>,
        LineupOf<D, Head<TRest>>,
        LineupToOf<D, Head<TRest>>,
        CutinOf<D, Head<TRest>>
      > & {
        shot: StageShots<TIds>;
      },
    ) => ReturnType<ShotFunction>,
  ): StageChain<D, Tail<TRest>, TIds | Head<TRest>, TStage>;
  nextGraphicShot(
    id: GraphicIdOf<D, Head<TRest>>,
    build: (
      ctx: GraphicShotContext<ScriptOf<D, Head<TRest>>, CutinOf<D, Head<TRest>>> & {
        shot: StageShots<TIds>;
      },
    ) => ReturnType<ShotFunction>,
  ): StageChain<D, Tail<TRest>, TIds | Head<TRest>, TStage>;
  nextPendingShot(
    id: ArcIdOf<D, Head<TRest>>,
  ): StageChain<D, Tail<TRest>, TIds | Head<TRest>, TStage>;
  nextAsideShot(
    id: AsideIdOf<D, Head<TRest>>,
    ...build: TStage extends "video"
      ? [build: (ctx: AsideShotContext) => ReturnType<ShotFunction>]
      : []
  ): StageChain<D, Tail<TRest>, TIds | Head<TRest>, TStage>;
}
/**
 * The structural witness a stage's `timeline.shots` requires: a chain that reached the end.
 */
export type StageTerminal<TIds extends string = string> = {
  readonly __complete: true;
  readonly __shots: readonly AnyShotInput[];
  readonly __shotIds: TIds;
};
/**
 * A stage `timeline` always returns an object: the completed shot chain under `shots` (a bare `[]`
 * for an empty or not-yet-authored stage), plus optional timeline-spanning `soundtracks` whose
 * anchors are checked against the shots' ids.
 */
export type StageTimelineReturn<Ids extends string = string> = {
  shots: StageTerminal<Ids> | readonly never[];
  soundtracks?: ReadonlyArray<SoundtrackEntry<NoInfer<Ids>>>;
};
/**
 * The `setups` roster ids this direction declares — the only keys a plate may be filed under.
 */
export type SetupIdOf<D> = D extends {
  setups: infer S;
}
  ? Extract<keyof S, string>
  : string;
/**
 * One plate as `plates` returns it: the picture, and one English sentence saying what that frame
 * holds. The sentence is required because the picture cannot be read — a crop of a master is bytes
 * konte never looks inside, and two setups cut from one place hold different things.
 */
export type AnimaticPlate = {
  image: MediaAsset<"image">;
  prompt: string;
};
/**
 * The plates a `plates` callback may return: one per shared camera position, keyed by its `setups`
 * roster id. Partial — a setup only one shot names has nothing to hold together and owes none.
 */
export type AnimaticPlates<D> = Partial<Record<SetupIdOf<D>, AnimaticPlate>>;
export interface DefineAnimaticOptions<
  D = unknown,
  Ids extends string = string,
  TPlates extends AnimaticPlates<D> = AnimaticPlates<D>,
> {
  plates?: (args: { format: VideoFormat }) => TPlates;
  waivers?: Record<string, string>;
  timeline: (args: {
    format: VideoFormat;
    shot: StageShotStarter<D, "animatic">;
    graphicShot: StageGraphicShotStarter<D, "animatic">;
    pendingShot: StagePendingShotStarter<D, "animatic">;
    asideShot: StageAsideShotStarter<D>;
    plates: TPlates;
  }) => StageTimelineReturn<Ids>;
}
/**
 * The animatic: the storyboard laid on the direction's clock, with the shot's lines sounding over
 * it. Each shot returns a `<Composition>` whose keyframes are `<Panel>`s and whose spoken lines are
 * `<Audio>`; konte derives the shot's mixed-down `#stem` from those cues, clamped to the shot, and
 * the video stage takes both the keyframes and the stem as its inputs.
 */
export declare function defineAnimatic<
  const D,
  Ids extends string = string,
  TPlates extends AnimaticPlates<D> = AnimaticPlates<D>,
>(
  direction: DirectionEntry<D>,
  opts: DefineAnimaticOptions<D, Ids, TPlates>,
): AnimaticDefinition & AnimaticRef;
export type IdentifierChar =
  | "a"
  | "b"
  | "c"
  | "d"
  | "e"
  | "f"
  | "g"
  | "h"
  | "i"
  | "j"
  | "k"
  | "l"
  | "m"
  | "n"
  | "o"
  | "p"
  | "q"
  | "r"
  | "s"
  | "t"
  | "u"
  | "v"
  | "w"
  | "x"
  | "y"
  | "z"
  | "A"
  | "B"
  | "C"
  | "D"
  | "E"
  | "F"
  | "G"
  | "H"
  | "I"
  | "J"
  | "K"
  | "L"
  | "M"
  | "N"
  | "O"
  | "P"
  | "Q"
  | "R"
  | "S"
  | "T"
  | "U"
  | "V"
  | "W"
  | "X"
  | "Y"
  | "Z"
  | "0"
  | "1"
  | "2"
  | "3"
  | "4"
  | "5"
  | "6"
  | "7"
  | "8"
  | "9"
  | "-"
  | "_";
export type IsIdentifierString<T extends string> = T extends ""
  ? false
  : T extends `${IdentifierChar}${infer Rest}`
    ? Rest extends ""
      ? true
      : IsIdentifierString<Rest>
    : false;
export type Identifier<T extends string> = string extends T
  ? T
  : IsIdentifierString<T> extends true
    ? T
    : never;
/**
 * A branded error carrying the offending id in a required property KEY, so a violation surfaces the
 * whole explanation verbatim ("Property 'konte: id "…" …' is missing").
 */
export type IdentifierViolation<T extends string> = {
  [P in `konte: id "${T}" must use only a-z A-Z 0-9 - _`]: never;
};
export type ValidatedIdentifier<T extends string> =
  Identifier<T> extends never ? IdentifierViolation<T> : T;
export type Voice = {
  id: string;
  description: string;
};
export type Character = {
  name: string;
  promptDepiction: string;
  description: string;
  voice?: Voice;
};
export type Prop = {
  name: string;
  description: string;
};
type Location$1 = {
  name: string;
  description: string;
  landmarks: Record<string, Landmark>;
};
export type Landmark = {
  name: string;
  promptDepiction: string;
  description: string;
};
export type Framing = "wide" | "medium" | "close" | "insert";
export type Setup = {
  name: string;
  description: string;
  location: string;
  framing: Framing;
  holds: readonly string[];
  within?: string | null;
};
export type DirectionBrief = {
  logline: string;
  hook?: string;
  audience?: string;
  tone?: string;
  look?: string;
  outOfScope?: readonly string[];
  tolerances?: readonly string[];
};
export type DirectionFormat = {
  fps: number;
  size: CanvasBudget;
};
export type ResolvedDirectionFormat = {
  fps: number;
  size: CanvasBudget & {
    base: CanvasSize;
  };
};
export type SpeechPolicy = "none" | "no-dialogue" | "free";
export type DirectionPolicy = {
  format: DirectionFormat;
  lang: LanguageTag;
  fonts?: readonly string[];
  speech: SpeechPolicy;
};
export type NarrativeShot = Omit<ArcItem<string>, "synopsis" | "location" | "framing" | "aside"> & {
  kind?: "shot";
  action: string;
  setup: string;
  duration: number;
  script?: readonly ScriptLine[];
  telop?: readonly string[];
  lineup: readonly string[];
  lineupTo?: readonly string[];
  join?: "continuous" | "jump-back" | "jump-forward";
  cutin?: Cutin;
};
export type Cutin = {
  setup: string;
  lineup: readonly string[];
  lineupTo?: readonly string[];
  join?: "continuous" | "jump-back" | "jump-forward";
};
export type GraphicShot = Omit<NarrativeShot, "kind" | "setup" | "lineup" | "lineupTo" | "join"> & {
  kind: "graphic";
  cutin?: Cutin;
};
export type AsideShot = {
  kind: "aside";
  id: string;
  label: string;
  duration: number;
  telop?: readonly string[];
};
export type Shot = NarrativeShot | GraphicShot | AsideShot;
export declare function isAsideShot(shot: Shot): shot is AsideShot;
export declare function isGraphicShot(shot: Shot): shot is GraphicShot;
export type DirectionNode = {
  id?: string;
  role?: string;
  synopsis?: string;
  lens: string;
  pleasure: Pleasure;
  waivers?: Record<string, string>;
  shots?: Shot[];
  sequences?: DirectionNode[];
};
export type Direction = {
  brief: DirectionBrief;
  characters: Record<string, Character>;
  props?: Record<string, Prop>;
  locations: Record<string, Location$1>;
  setups: Record<string, Setup>;
  narrator?: Voice;
  lenses?: LensSpec<string>[];
  policy: DirectionPolicy;
  sequence: DirectionNode;
};
export type NarrativeShotShape = {
  id: string;
  kind?: "shot";
  role: string;
  action: string;
  setup: string;
  duration: number;
  script?: readonly ScriptLine[];
  telop?: readonly string[];
  lineup: readonly string[];
  lineupTo?: readonly string[];
  join?: "continuous" | "jump-back" | "jump-forward";
  cutin?: CutinShape;
};
export type CutinShape = {
  setup: string;
  lineup: readonly string[];
  lineupTo?: readonly string[];
  join?: "continuous" | "jump-back" | "jump-forward";
};
export type GraphicShotShape = {
  id: string;
  kind: "graphic";
  role: string;
  action: string;
  duration: number;
  script?: readonly ScriptLine[];
  telop?: readonly string[];
  cutin?: CutinShape;
  setup?: never;
  lineup?: never;
  lineupTo?: never;
  join?: never;
};
export type AsideShotShape = {
  id: string;
  kind: "aside";
  label: string;
  duration: number;
  telop?: readonly string[];
  cutin?: never;
};
export type ShotShape = NarrativeShotShape | GraphicShotShape | AsideShotShape;
export type NodeBodyShape =
  | {
      shots: readonly ShotShape[];
    }
  | {
      sequences: readonly ChildNodeShape[];
    };
export type NodeCommonShape = {
  lens: string;
  pleasure: Pleasure;
  waivers?: Record<string, string>;
};
export type ChildNodeShape = NodeCommonShape & {
  id: string;
  role: string;
  synopsis: string;
} & NodeBodyShape;
export type RootNodeShape = NodeCommonShape & NodeBodyShape;
export type DirectionInput = {
  brief: DirectionBrief;
  characters: Record<string, Character>;
  props?: Record<string, Prop>;
  locations: Record<string, Location$1>;
  setups: Record<string, Setup>;
  narrator?: Voice;
  lenses?: readonly LensSpec<string>[];
  policy: DirectionPolicy;
  sequence: RootNodeShape;
};
export type ConstrainRosterIds<R> = R & {
  [K in keyof R & string as ValidatedIdentifier<K> extends string
    ? never
    : K]: ValidatedIdentifier<K>;
};
export type SubjectIdOf<D extends DirectionInput> = Extract<keyof D["characters"], string>;
export type LineupSubjectViolation<T extends string> = {
  [P in `konte: lineup id "${T}" is not a declared character id`]: never;
};
export type ConstrainLineup<L, Subjects extends string> = {
  [K in keyof L]: string extends L[K]
    ? L[K]
    : L[K] extends Subjects
      ? L[K]
      : L[K] extends string
        ? LineupSubjectViolation<L[K]>
        : never;
};
export type DeclaredLensNameOf<D> = D extends {
  lenses: readonly (infer L)[];
}
  ? L extends {
      name: infer N;
    }
    ? N
    : never
  : never;
export type LensRolesOf<Name, Declared> = string extends Name
  ? string
  : [Declared] extends [never]
    ? BuiltinLensRolesOf<Name>
    : [Name] extends [Declared]
      ? string
      : BuiltinLensRolesOf<Name>;
export type BuiltinLensRolesOf<Name> =
  Extract<
    BuiltinLens,
    {
      name: Name;
    }
  > extends infer L
    ? [L] extends [never]
      ? string
      : L extends {
            beats: infer B extends readonly {
              role: string;
            }[];
          }
        ? B[number]["role"]
        : string
    : string;
export type ConstrainRole<Item, Roles extends string> = Item extends {
  role: infer R;
}
  ? string extends R
    ? unknown
    : string extends Roles
      ? unknown
      : [R] extends [Roles]
        ? unknown
        : {
            role: DirectionViolation<`konte: "${R & string}" is not a beat role this node's lens declares`>;
          }
  : unknown;
export type IsWidenedArray<A> = A extends readonly unknown[]
  ? number extends A["length"]
    ? true
    : false
  : false;
export type DirectionViolation<M extends string> = {
  [P in M]: never;
};
export type ConstrainLineupTo<F, LT> = F extends {
  lineup: infer L extends readonly string[];
}
  ? IsWidenedArray<L> extends true
    ? unknown
    : IsWidenedArray<LT> extends true
      ? unknown
      : [L] extends [LT]
        ? [LT] extends [L]
          ? {
              lineupTo: DirectionViolation<"konte: this `lineupTo` is the `lineup` again \u2014 write the order the shot leaves behind, or drop it">;
            }
          : unknown
        : unknown
  : unknown;
export type ConstrainFrameLineups<F, Subjects extends string> = (F extends {
  lineup: infer L extends readonly string[];
}
  ? {
      lineup: ConstrainLineup<L, Subjects>;
    }
  : unknown) &
  (F extends {
    lineupTo: infer L extends readonly string[];
  }
    ? {
        lineupTo: ConstrainLineup<L, Subjects>;
      } & ConstrainLineupTo<F, L>
    : unknown);
export type ConstrainDuration<B> = B extends {
  kind: "aside";
}
  ? unknown
  : B extends {
        duration: infer N;
      }
    ? number extends N
      ? unknown
      : `${N & number}` extends `${string}.${infer Decimals}`
        ? Decimals extends "5"
          ? unknown
          : {
              duration: DirectionViolation<"konte: a shot's duration is a multiple of 0.5s, so it lands a whole frame at every fps">;
            }
        : [N] extends [0]
          ? {
              duration: DirectionViolation<"konte: a shot's duration is a multiple of 0.5s, so it lands a whole frame at every fps">;
            }
          : unknown
    : unknown;
export type ConstrainAction<B> = B extends {
  action: infer A;
}
  ? [A] extends [""]
    ? {
        action: DirectionViolation<"konte: `action` is the one thing this shot lands \u2014 it cannot be empty">;
      }
    : unknown
  : unknown;
export type ConstrainSynopsis<N> = N extends {
  synopsis: infer S;
}
  ? [S] extends [""]
    ? {
        synopsis: DirectionViolation<"konte: `synopsis` is what this act of the arc IS \u2014 it cannot be empty">;
      }
    : unknown
  : unknown;
export type SpokenLines<S> = Extract<
  S,
  | {
      character: unknown;
    }
  | {
      speaker: unknown;
    }
>;
export type ConstrainSpeech<B, Speech> = SpeechPolicy extends Speech
  ? unknown
  : B extends {
        script: infer S extends readonly ScriptLine[];
      }
    ? IsWidenedArray<S> extends true
      ? unknown
      : [Speech] extends ["none"]
        ? [S] extends [readonly []]
          ? unknown
          : {
              script: DirectionViolation<'konte: policy.speech is "none", so no shot declares a script line'>;
            }
        : [Speech] extends ["no-dialogue"]
          ? [SpokenLines<S[number]>] extends [never]
            ? unknown
            : {
                script: DirectionViolation<'konte: policy.speech is "no-dialogue", so a shot narrates but nobody speaks'>;
              }
          : unknown
    : unknown;
export type ShotBefore<Shots, Id extends string, Prev = null> = Shots extends readonly [
  infer H extends {
    id: string;
  },
  ...infer T extends readonly {
    id: string;
  }[],
]
  ? H extends {
      id: Id;
    }
    ? Prev
    : ShotBefore<T, Id, H>
  : never;
export type SameSetup<PS, S> = string extends PS
  ? true
  : string extends S
    ? true
    : [PS] extends [S]
      ? [S] extends [PS]
        ? true
        : false
      : false;
export type RunsOnFrom<P, S> = [P] extends [never]
  ? true
  : P extends null
    ? false
    : P extends {
          kind: "aside" | "graphic";
        }
      ? false
      : P extends {
            setup: infer PS;
          }
        ? SameSetup<PS, S>
        : false;
export type CutinRunsOnFrom<P, S> = [P] extends [never]
  ? true
  : P extends {
        cutin: {
          setup: infer PS;
        };
      }
    ? SameSetup<PS, S>
    : false;
export type ConstrainJoin<B, Shots> = B extends {
  join: "continuous";
  id: infer Id extends string;
  setup: infer S;
}
  ? RunsOnFrom<ShotBefore<Shots, Id>, S> extends true
    ? unknown
    : {
        join: DirectionViolation<"konte: `continuous` is one unbroken take with the shot before it on the clock, so that shot is a narrative shot on this same setup \u2014 declare a jump, or drop the join">;
      }
  : unknown;
export type ConstrainCutinJoin<B, Shots> = B extends {
  id: infer Id extends string;
  cutin: {
    join: "continuous";
    setup: infer S;
  };
}
  ? CutinRunsOnFrom<ShotBefore<Shots, Id>, S> extends true
    ? unknown
    : {
        cutin: {
          join: DirectionViolation<"konte: a `continuous` cutin runs on from the cutin over the shot before it on the clock, so that shot carries a cutin on this same setup \u2014 declare a jump, or drop the join">;
        };
      }
  : unknown;
export type ConstrainShotIds<Arr, Subjects extends string, Speech, Roles extends string, Shots> = {
  [K in keyof Arr]: Omit<Arr[K], "id" | "lineup" | "lineupTo" | "cutin"> & {
    id: ValidatedIdentifier<
      Arr[K] extends {
        id: infer I extends string;
      }
        ? I
        : never
    >;
  } & ConstrainFrameLineups<Arr[K], Subjects> &
    ConstrainDuration<Arr[K]> &
    ConstrainAction<Arr[K]> &
    ConstrainSpeech<Arr[K], Speech> &
    ConstrainRole<Arr[K], Roles> &
    ConstrainJoin<Arr[K], Shots> &
    ConstrainCutinJoin<Arr[K], Shots> &
    (Arr[K] extends {
      cutin: infer C;
    }
      ? {
          cutin: Omit<C, "lineup" | "lineupTo"> & ConstrainFrameLineups<C, Subjects>;
        }
      : unknown);
};
export type ConstrainNodeIds<N, Subjects extends string, Speech, Lenses, Shots> = N &
  (N extends {
    id: infer I extends string;
  }
    ? {
        id: ValidatedIdentifier<I>;
      }
    : unknown) &
  ConstrainSynopsis<N> &
  (N extends {
    shots: infer S;
  }
    ? {
        shots: ConstrainShotIds<S, Subjects, Speech, LensRolesOf<LensNameOf<N>, Lenses>, Shots>;
      }
    : unknown) &
  (N extends {
    sequences: infer Q;
  }
    ? {
        sequences: ConstrainSequenceIds<
          Q,
          Subjects,
          Speech,
          Lenses,
          LensRolesOf<LensNameOf<N>, Lenses>,
          Shots
        >;
      }
    : unknown);
export type LensNameOf<N> = N extends {
  lens: infer L;
}
  ? L
  : string;
export type ConstrainSequenceIds<
  Arr,
  Subjects extends string,
  Speech,
  Lenses,
  ParentRoles extends string,
  Shots,
> = {
  [K in keyof Arr]: ConstrainNodeIds<Arr[K], Subjects, Speech, Lenses, Shots> &
    ConstrainRole<Arr[K], ParentRoles>;
};
export type ConstrainVoiceId<V> = V extends {
  id: infer I extends string;
}
  ? {
      id: ValidatedIdentifier<I>;
    }
  : unknown;
export type ConstrainCastVoiceIds<R> = {
  [K in keyof R]: R[K] &
    (R[K] extends {
      voice: infer V;
    }
      ? {
          voice: ConstrainVoiceId<V>;
        }
      : unknown);
};
export type ConstrainLandmarkIds<R> = {
  [K in keyof R]: R[K] &
    (R[K] extends {
      landmarks: infer L;
    }
      ? {
          landmarks: ConstrainRosterIds<L>;
        }
      : unknown);
};
export type LandmarkIdOf<D extends DirectionInput, S> = S extends {
  location: infer L;
}
  ? L extends keyof D["locations"]
    ? D["locations"][L] extends {
        landmarks: infer M;
      }
      ? Extract<keyof M, string>
      : string
    : string
  : string;
export type HoldsLandmarkViolation<T extends string> = {
  [P in `konte: holds id "${T}" is not a landmark of this setup's location`]: never;
};
export type ConstrainHolds<H, Ids extends string> = {
  [K in keyof H]: string extends H[K]
    ? H[K]
    : H[K] extends Ids
      ? H[K]
      : H[K] extends string
        ? HoldsLandmarkViolation<H[K]>
        : never;
};
export type HoldsRequired = {
  "konte: this setup is not an insert, so `holds` must name at least one landmark": never;
};
export type ConstrainSetupHolds<S, Ids extends string> = S extends {
  holds: infer H;
}
  ? {
      holds: ConstrainHolds<H, Ids>;
    } & (S extends {
      framing: infer F;
    }
      ? "insert" extends F
        ? unknown
        : H extends readonly []
          ? {
              holds: readonly [HoldsRequired];
            }
          : unknown
      : unknown)
  : unknown;
export type WiderThan<F> = F extends "close"
  ? "wide" | "medium"
  : F extends "medium"
    ? "wide"
    : never;
export type WithinViolation<M extends string> = {
  [P in M]: never;
};
export type ConstrainWithinTarget<S, T, W extends string, F> = T extends {
  location: infer TL;
  framing: infer TF;
}
  ? S extends {
      location: infer SL;
    }
    ? string extends SL
      ? unknown
      : string extends TL
        ? unknown
        : [SL] extends [TL]
          ? Framing extends TF
            ? unknown
            : [TF] extends [WiderThan<F>]
              ? unknown
              : {
                  within: WithinViolation<`konte: within "${W}" is ${TF & string}, not wider than this ${F & string}`>;
                }
          : {
              within: WithinViolation<`konte: within "${W}" is set in another location`>;
            }
    : unknown
  : unknown;
export type ConstrainSetupWithin<S, Setups> = S extends {
  within: infer W;
}
  ? [W] extends [null | undefined]
    ? unknown
    : string extends W
      ? unknown
      : S extends {
            framing: infer F;
          }
        ? Framing extends F
          ? unknown
          : [F] extends ["insert"]
            ? {
                within: WithinViolation<"konte: an insert holds nothing, so it is no window">;
              }
            : W extends keyof Setups & string
              ? ConstrainWithinTarget<S, Setups[W], W, F>
              : W extends string
                ? {
                    within: WithinViolation<`konte: within id "${W}" is not a declared setup`>;
                  }
                : unknown
        : unknown
  : unknown;
export type ConstrainSetupIds<D extends DirectionInput> = ConstrainRosterIds<D["setups"]> & {
  [K in keyof D["setups"]]: ConstrainSetupHolds<D["setups"][K], LandmarkIdOf<D, D["setups"][K]>> &
    ConstrainSetupWithin<D["setups"][K], D["setups"]>;
};
export type SpeechOf<D extends DirectionInput> = D["policy"] extends {
  speech: infer S;
}
  ? S
  : SpeechPolicy;
export type ConstrainIds<D extends DirectionInput> = {
  characters: ConstrainRosterIds<D["characters"]> & ConstrainCastVoiceIds<D["characters"]>;
  locations: ConstrainRosterIds<D["locations"]> & ConstrainLandmarkIds<D["locations"]>;
  setups: ConstrainSetupIds<D>;
  sequence: ConstrainNodeIds<
    D["sequence"],
    SubjectIdOf<D>,
    SpeechOf<D>,
    DeclaredLensNameOf<D>,
    DirectionShotTuple<D>
  >;
} & (D extends {
  props: infer P;
}
  ? {
      props: ConstrainRosterIds<P>;
    }
  : unknown) &
  (D extends {
    narrator: infer N;
  }
    ? {
        narrator: ConstrainVoiceId<N>;
      }
    : unknown);
export type ShotIdOf<D> = DirectionIdTuple<D>[number];
export interface DirectionIndex {
  format: ResolvedDirectionFormat;
  typography: Typography;
  durationById: Map<string, number>;
  actionById: Map<string, string>;
  setupById: Map<string, string>;
  framingById: Map<string, Framing>;
  locationById: Map<string, string>;
  scriptById: Map<string, readonly ScriptLine[]>;
  lineupById: Map<string, readonly string[]>;
  lineupToById: Map<string, readonly string[]>;
  continuedById: Map<
    string,
    {
      main?: string;
      cutin?: string;
    }
  >;
  graphicIds: Set<string>;
  cutinById: Map<string, Cutin>;
  cutinFrameById: Map<
    string,
    {
      framing: Framing;
      location: string;
    }
  >;
  asideIds: Set<string>;
  labelById: Map<string, string>;
  referenceShapeById: Map<string, ReferenceShape>;
}
declare const DIRECTION: unique symbol;
export type DirectionHandle<D> = DirectionIndex & {
  readonly __direction?: D;
};
export type DirectionEntry<D> = D & {
  readonly [DIRECTION]: DirectionHandle<D>;
};
export type StageShotStarter<D, TStage extends ShotStage> = <
  TId extends NarrativeIdOf<D, FirstShotId<D>>,
>(
  id: TId,
  build: (
    ctx: StageShotContext<
      ScriptOf<D, TId>,
      LineupOf<D, TId>,
      LineupToOf<D, TId>,
      CutinOf<D, TId>
    > & {
      shot: StageShots<never>;
    },
  ) => ReturnType<ShotFunction>,
) => StageChain<D, ChainRest<D>, TId, TStage>;
export type StageGraphicShotStarter<D, TStage extends ShotStage> = <
  TId extends GraphicIdOf<D, FirstShotId<D>>,
>(
  id: TId,
  build: (
    ctx: GraphicShotContext<ScriptOf<D, TId>, CutinOf<D, TId>> & {
      shot: StageShots<never>;
    },
  ) => ReturnType<ShotFunction>,
) => StageChain<D, ChainRest<D>, TId, TStage>;
export type StagePendingShotStarter<D, TStage extends ShotStage> = <
  TId extends ArcIdOf<D, FirstShotId<D>>,
>(
  id: TId,
) => StageChain<D, ChainRest<D>, TId, TStage>;
export type StageAsideShotStarter<D> = <TId extends AsideIdOf<D, FirstShotId<D>>>(
  id: TId,
) => StageChain<D, ChainRest<D>, TId, "animatic">;
export type VideoAsideShotStarter<D> = <TId extends AsideIdOf<D, FirstShotId<D>>>(
  id: TId,
  build: (ctx: AsideShotContext) => ReturnType<ShotFunction>,
) => StageChain<D, ChainRest<D>, TId, "video">;
export declare function defineDirection<const D extends DirectionInput>(
  direction: D & ConstrainIds<D>,
): DirectionEntry<D>;
/** How far a bed yields to the lines over it, and how quickly. */
export interface DuckOptions {
  /** Gain the bed is held at under a line; 1 is no duck. Default 0.35 (≈ −9 dB). */
  depth?: number;
  /** Seconds the bed takes to drop, ending as the line starts. Default 0.15. */
  attack?: number;
  /** Seconds the bed takes to come back. Default 0.4. */
  release?: number;
  /** Seconds the bed stays down after the line before releasing. Default 0.2. */
  hold?: number;
}
/** `duck` as authored: `true` takes the defaults, `false` yields to nothing. */
export type Duck = boolean | DuckOptions;
export type MediaKind = "image" | "video" | "audio";
export interface MediaAsset<T extends MediaKind = MediaKind> {
  readonly src: string;
  readonly __kind?: T;
}
/**
 * A board shot's narration mix, `animatic.shot(id).narrationStem`. Only `<Audio>` takes it: nothing
 * on screen speaks narration, so no model input accepts it.
 */
export interface NarrationStem {
  readonly src: string;
  readonly __kind?: "narrationStem";
}
export interface ShotOptions {
  duration: number;
}
export interface VideoShotOptions extends ShotOptions {
  action: string;
}
/**
 * One developed shot of either stage: its id, the closure that builds its `<Composition>`, and the
 * shot facts the direction injected.
 */
export interface ShotInput<TId extends string = string> {
  __shotInput: true;
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
export type AnyShotInput<TId extends string = string> =
  | ShotInput<TId>
  | PendingShotInput<TId>
  | AsideShotInput<TId>;
export interface ShotAnchor<TId extends string = string> {
  /** The shot this anchor is relative to. */
  shot: TId;
  /** Seconds from that shot's start. Defaults: `from`→0 (shot head), `until`→the shot's end. */
  at?: number;
}
export interface SoundtrackOptions<TId extends string = string> {
  /**
   * Whether this bed yields to the spoken lines over it — `true` for the default curve, `false` for
   * a bed that holds its level through them. Required: konte cannot tell which lines a bed runs
   * under until the shots have real durations, long after this is written.
   */
  duck: Duck;
  /** Span start anchor. Omitted = the timeline start (0). */
  from?: ShotAnchor<TId>;
  /** Span end anchor. Omitted = the timeline end. */
  until?: ShotAnchor<TId>;
  /** Offset into the source media in seconds. */
  mediaStart?: number;
  /** Gain 0–MAX_AUDIO_GAIN (+12 dB), 1 = unity. */
  volume?: number;
  /** Fade-in seconds. */
  fadeIn?: number;
  /** Fade-out seconds. */
  fadeOut?: number;
  /** Loop the source to fill the span if it is shorter than the span. Defaults to true. */
  loop?: boolean;
}
export interface SoundtrackEntry<TId extends string = string> {
  __soundtrackEntry: true;
  id: string;
  src: MediaAsset<"audio">;
  options: SoundtrackOptions<TId>;
}
/**
 * A timeline-spanning audio bed / music track. Placed in the `soundtracks` array of the
 * `timeline()` return — not inside a shot composition. `from`/`until` anchor the span to shot
 * positions (shot-internal seconds, resolved to absolute time at render via accumulated actual
 * durations). Beds loop to fill their span and may overlap (each is its own muxed track).
 */
export declare function soundtrack<const TId extends string = never>(
  id: string,
  src: MediaAsset<"audio">,
  options: SoundtrackOptions<TId>,
): SoundtrackEntry<TId>;
/**
 * One already-placed shot's assets by name. Each accessor names the media kind it expects and checks
 * it against what that shot declared: an unknown name, a kind mismatch, or an undeveloped
 * (pendingShot) target throws while the definition loads.
 */
export interface ShotHandle {
  video(assetName: string): MediaAsset<"video">;
  image(assetName: string): MediaAsset<"image">;
  audio(assetName: string): MediaAsset<"audio">;
}
/**
 * The `shot` accessor every stage build receives — any shot the chain has ALREADY placed, by id.
 * `TIds` is the chain's covered-id cursor, so a later shot, an unknown id, and the shot being built
 * are all type errors. A video shot normally references the animatic, not a prior video shot; to
 * share an asset with a shot that is not downstream of it, hoist it to a timeline or reference asset
 * (which stays in scope).
 */
export type StageShots<TIds extends string = string> = (shotId: TIds) => ShotHandle;
/**
 * The video's export wiring. It carries no delivery `size` — the delivery resolution is
 * `direction.policy.format.size.delivery`; here the author only wires HOW to reach it (the upscaler).
 * Provide `delivery.upscale` iff the direction declares a `size.delivery`.
 */
export interface DefineVideoExport {
  delivery?: {
    upscale: {
      video?: DeliveryUpscaleFn;
      frame?: DeliveryUpscaleFn;
    };
  };
}
export interface DefineVideoOptions<D = unknown, Ids extends string = string> {
  waivers?: Record<string, string>;
  export?: DefineVideoExport;
  timeline: (args: {
    format: VideoFormat;
    shot: StageShotStarter<D, "video">;
    graphicShot: StageGraphicShotStarter<D, "video">;
    pendingShot: StagePendingShotStarter<D, "video">;
    asideShot: VideoAsideShotStarter<D>;
  }) => StageTimelineReturn<Ids>;
}
export declare function defineVideo<const D, Ids extends string = string>(
  direction: DirectionEntry<D>,
  opts: DefineVideoOptions<D, Ids>,
): VideoDefinition;
declare const ComfyModelTypeSchema: z.ZodEnum<
  [
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
  ]
>;
export type ComfyModelType = z.infer<typeof ComfyModelTypeSchema>;
declare const ComfyModelDeclarationSchema: z.ZodObject<
  {
    filename: z.ZodString;
    type: z.ZodEnum<
      [
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
      ]
    >;
    nodeId: z.ZodOptional<z.ZodString>;
    url: z.ZodString;
    savePath: z.ZodOptional<z.ZodString>;
    base: z.ZodOptional<z.ZodString>;
    displayName: z.ZodOptional<z.ZodString>;
  },
  "strip",
  z.ZodTypeAny,
  {
    type:
      | "checkpoint"
      | "lora"
      | "VAE"
      | "clip"
      | "diffusion_model"
      | "controlnet"
      | "upscale"
      | "embeddings"
      | "clip_vision"
      | "unet";
    url: string;
    filename: string;
    nodeId?: string | undefined;
    savePath?: string | undefined;
    base?: string | undefined;
    displayName?: string | undefined;
  },
  {
    type:
      | "checkpoint"
      | "lora"
      | "VAE"
      | "clip"
      | "diffusion_model"
      | "controlnet"
      | "upscale"
      | "embeddings"
      | "clip_vision"
      | "unet";
    url: string;
    filename: string;
    nodeId?: string | undefined;
    savePath?: string | undefined;
    base?: string | undefined;
    displayName?: string | undefined;
  }
>;
export type ComfyModelDeclaration = z.infer<typeof ComfyModelDeclarationSchema>;
declare const ComfyNodeDeclarationSchema: z.ZodObject<
  {
    id: z.ZodString;
  },
  "strip",
  z.ZodTypeAny,
  {
    id: string;
  },
  {
    id: string;
  }
>;
export type ComfyNodeDeclaration = z.infer<typeof ComfyNodeDeclarationSchema>;
declare const ComfyAssetDefinitionSchema: z.ZodObject<
  {
    deterministic: z.ZodOptional<z.ZodBoolean>;
    kind: z.ZodLiteral<"comfy">;
    workflow: z.ZodString;
    inputs: z.ZodRecord<z.ZodString, z.ZodUnknown>;
    prunedNodes: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
    prunedPassThroughs: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>;
    outputNodeId: z.ZodOptional<z.ZodString>;
    models: z.ZodOptional<
      z.ZodArray<
        z.ZodObject<
          {
            filename: z.ZodString;
            type: z.ZodEnum<
              [
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
              ]
            >;
            nodeId: z.ZodOptional<z.ZodString>;
            url: z.ZodString;
            savePath: z.ZodOptional<z.ZodString>;
            base: z.ZodOptional<z.ZodString>;
            displayName: z.ZodOptional<z.ZodString>;
          },
          "strip",
          z.ZodTypeAny,
          {
            type:
              | "checkpoint"
              | "lora"
              | "VAE"
              | "clip"
              | "diffusion_model"
              | "controlnet"
              | "upscale"
              | "embeddings"
              | "clip_vision"
              | "unet";
            url: string;
            filename: string;
            nodeId?: string | undefined;
            savePath?: string | undefined;
            base?: string | undefined;
            displayName?: string | undefined;
          },
          {
            type:
              | "checkpoint"
              | "lora"
              | "VAE"
              | "clip"
              | "diffusion_model"
              | "controlnet"
              | "upscale"
              | "embeddings"
              | "clip_vision"
              | "unet";
            url: string;
            filename: string;
            nodeId?: string | undefined;
            savePath?: string | undefined;
            base?: string | undefined;
            displayName?: string | undefined;
          }
        >,
        "many"
      >
    >;
    nodes: z.ZodOptional<
      z.ZodArray<
        z.ZodObject<
          {
            id: z.ZodString;
          },
          "strip",
          z.ZodTypeAny,
          {
            id: string;
          },
          {
            id: string;
          }
        >,
        "many"
      >
    >;
    inputLabels: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>;
    turboInputs: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
  },
  "strip",
  z.ZodTypeAny,
  {
    kind: "comfy";
    workflow: string;
    inputs: Record<string, unknown>;
    prunedNodes?: string[] | undefined;
    prunedPassThroughs?: Record<string, string> | undefined;
    outputNodeId?: string | undefined;
    models?:
      | {
          type:
            | "checkpoint"
            | "lora"
            | "VAE"
            | "clip"
            | "diffusion_model"
            | "controlnet"
            | "upscale"
            | "embeddings"
            | "clip_vision"
            | "unet";
          url: string;
          filename: string;
          nodeId?: string | undefined;
          savePath?: string | undefined;
          base?: string | undefined;
          displayName?: string | undefined;
        }[]
      | undefined;
    nodes?:
      | {
          id: string;
        }[]
      | undefined;
    inputLabels?: Record<string, string> | undefined;
    turboInputs?: Record<string, unknown> | undefined;
    deterministic?: boolean | undefined;
  },
  {
    kind: "comfy";
    workflow: string;
    inputs: Record<string, unknown>;
    prunedNodes?: string[] | undefined;
    prunedPassThroughs?: Record<string, string> | undefined;
    outputNodeId?: string | undefined;
    models?:
      | {
          type:
            | "checkpoint"
            | "lora"
            | "VAE"
            | "clip"
            | "diffusion_model"
            | "controlnet"
            | "upscale"
            | "embeddings"
            | "clip_vision"
            | "unet";
          url: string;
          filename: string;
          nodeId?: string | undefined;
          savePath?: string | undefined;
          base?: string | undefined;
          displayName?: string | undefined;
        }[]
      | undefined;
    nodes?:
      | {
          id: string;
        }[]
      | undefined;
    inputLabels?: Record<string, string> | undefined;
    turboInputs?: Record<string, unknown> | undefined;
    deterministic?: boolean | undefined;
  }
>;
export type ComfyAssetDefinition = z.infer<typeof ComfyAssetDefinitionSchema>;
declare const FileAssetDefinitionSchema: z.ZodObject<
  {
    deterministic: z.ZodOptional<z.ZodBoolean>;
    kind: z.ZodLiteral<"file">;
    path: z.ZodString;
    type: z.ZodOptional<z.ZodEnum<["image", "video", "audio"]>>;
  },
  "strip",
  z.ZodTypeAny,
  {
    kind: "file";
    path: string;
    type?: "image" | "video" | "audio" | undefined;
    deterministic?: boolean | undefined;
  },
  {
    kind: "file";
    path: string;
    type?: "image" | "video" | "audio" | undefined;
    deterministic?: boolean | undefined;
  }
>;
export type FileAssetDefinition = z.infer<typeof FileAssetDefinitionSchema>;
declare const FalAssetDefinitionSchema: z.ZodObject<
  {
    deterministic: z.ZodOptional<z.ZodBoolean>;
    kind: z.ZodLiteral<"fal">;
    endpointId: z.ZodString;
    mediaType: z.ZodEnum<["image", "video", "audio"]>;
    inputs: z.ZodRecord<z.ZodString, z.ZodUnknown>;
    inputLabels: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>;
    turboInputs: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
  },
  "strip",
  z.ZodTypeAny,
  {
    kind: "fal";
    inputs: Record<string, unknown>;
    endpointId: string;
    mediaType: "image" | "video" | "audio";
    inputLabels?: Record<string, string> | undefined;
    turboInputs?: Record<string, unknown> | undefined;
    deterministic?: boolean | undefined;
  },
  {
    kind: "fal";
    inputs: Record<string, unknown>;
    endpointId: string;
    mediaType: "image" | "video" | "audio";
    inputLabels?: Record<string, string> | undefined;
    turboInputs?: Record<string, unknown> | undefined;
    deterministic?: boolean | undefined;
  }
>;
export type FalAssetDefinition = z.infer<typeof FalAssetDefinitionSchema>;
declare const LocalAssetDefinitionSchema: z.ZodObject<
  {
    deterministic: z.ZodOptional<z.ZodBoolean>;
    kind: z.ZodLiteral<"local">;
    operation: z.ZodEnum<["resize", "crop", "blank", "trim", "retime", "frame", "render"]>;
    mediaType: z.ZodEnum<["image", "video", "audio"]>;
    inputs: z.ZodRecord<z.ZodString, z.ZodUnknown>;
  },
  "strip",
  z.ZodTypeAny,
  {
    kind: "local";
    inputs: Record<string, unknown>;
    mediaType: "image" | "video" | "audio";
    operation: "trim" | "resize" | "crop" | "blank" | "retime" | "frame" | "render";
    deterministic?: boolean | undefined;
  },
  {
    kind: "local";
    inputs: Record<string, unknown>;
    mediaType: "image" | "video" | "audio";
    operation: "trim" | "resize" | "crop" | "blank" | "retime" | "frame" | "render";
    deterministic?: boolean | undefined;
  }
>;
export type LocalAssetDefinition = z.infer<typeof LocalAssetDefinitionSchema>;
declare const AssetDefinitionSchema: z.ZodDiscriminatedUnion<
  "kind",
  [
    z.ZodObject<
      {
        deterministic: z.ZodOptional<z.ZodBoolean>;
        kind: z.ZodLiteral<"comfy">;
        workflow: z.ZodString;
        inputs: z.ZodRecord<z.ZodString, z.ZodUnknown>;
        prunedNodes: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
        prunedPassThroughs: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>;
        outputNodeId: z.ZodOptional<z.ZodString>;
        models: z.ZodOptional<
          z.ZodArray<
            z.ZodObject<
              {
                filename: z.ZodString;
                type: z.ZodEnum<
                  [
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
                  ]
                >;
                nodeId: z.ZodOptional<z.ZodString>;
                url: z.ZodString;
                savePath: z.ZodOptional<z.ZodString>;
                base: z.ZodOptional<z.ZodString>;
                displayName: z.ZodOptional<z.ZodString>;
              },
              "strip",
              z.ZodTypeAny,
              {
                type:
                  | "checkpoint"
                  | "lora"
                  | "VAE"
                  | "clip"
                  | "diffusion_model"
                  | "controlnet"
                  | "upscale"
                  | "embeddings"
                  | "clip_vision"
                  | "unet";
                url: string;
                filename: string;
                nodeId?: string | undefined;
                savePath?: string | undefined;
                base?: string | undefined;
                displayName?: string | undefined;
              },
              {
                type:
                  | "checkpoint"
                  | "lora"
                  | "VAE"
                  | "clip"
                  | "diffusion_model"
                  | "controlnet"
                  | "upscale"
                  | "embeddings"
                  | "clip_vision"
                  | "unet";
                url: string;
                filename: string;
                nodeId?: string | undefined;
                savePath?: string | undefined;
                base?: string | undefined;
                displayName?: string | undefined;
              }
            >,
            "many"
          >
        >;
        nodes: z.ZodOptional<
          z.ZodArray<
            z.ZodObject<
              {
                id: z.ZodString;
              },
              "strip",
              z.ZodTypeAny,
              {
                id: string;
              },
              {
                id: string;
              }
            >,
            "many"
          >
        >;
        inputLabels: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>;
        turboInputs: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
      },
      "strip",
      z.ZodTypeAny,
      {
        kind: "comfy";
        workflow: string;
        inputs: Record<string, unknown>;
        prunedNodes?: string[] | undefined;
        prunedPassThroughs?: Record<string, string> | undefined;
        outputNodeId?: string | undefined;
        models?:
          | {
              type:
                | "checkpoint"
                | "lora"
                | "VAE"
                | "clip"
                | "diffusion_model"
                | "controlnet"
                | "upscale"
                | "embeddings"
                | "clip_vision"
                | "unet";
              url: string;
              filename: string;
              nodeId?: string | undefined;
              savePath?: string | undefined;
              base?: string | undefined;
              displayName?: string | undefined;
            }[]
          | undefined;
        nodes?:
          | {
              id: string;
            }[]
          | undefined;
        inputLabels?: Record<string, string> | undefined;
        turboInputs?: Record<string, unknown> | undefined;
        deterministic?: boolean | undefined;
      },
      {
        kind: "comfy";
        workflow: string;
        inputs: Record<string, unknown>;
        prunedNodes?: string[] | undefined;
        prunedPassThroughs?: Record<string, string> | undefined;
        outputNodeId?: string | undefined;
        models?:
          | {
              type:
                | "checkpoint"
                | "lora"
                | "VAE"
                | "clip"
                | "diffusion_model"
                | "controlnet"
                | "upscale"
                | "embeddings"
                | "clip_vision"
                | "unet";
              url: string;
              filename: string;
              nodeId?: string | undefined;
              savePath?: string | undefined;
              base?: string | undefined;
              displayName?: string | undefined;
            }[]
          | undefined;
        nodes?:
          | {
              id: string;
            }[]
          | undefined;
        inputLabels?: Record<string, string> | undefined;
        turboInputs?: Record<string, unknown> | undefined;
        deterministic?: boolean | undefined;
      }
    >,
    z.ZodObject<
      {
        deterministic: z.ZodOptional<z.ZodBoolean>;
        kind: z.ZodLiteral<"file">;
        path: z.ZodString;
        type: z.ZodOptional<z.ZodEnum<["image", "video", "audio"]>>;
      },
      "strip",
      z.ZodTypeAny,
      {
        kind: "file";
        path: string;
        type?: "image" | "video" | "audio" | undefined;
        deterministic?: boolean | undefined;
      },
      {
        kind: "file";
        path: string;
        type?: "image" | "video" | "audio" | undefined;
        deterministic?: boolean | undefined;
      }
    >,
    z.ZodObject<
      {
        deterministic: z.ZodOptional<z.ZodBoolean>;
        kind: z.ZodLiteral<"fal">;
        endpointId: z.ZodString;
        mediaType: z.ZodEnum<["image", "video", "audio"]>;
        inputs: z.ZodRecord<z.ZodString, z.ZodUnknown>;
        inputLabels: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>;
        turboInputs: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
      },
      "strip",
      z.ZodTypeAny,
      {
        kind: "fal";
        inputs: Record<string, unknown>;
        endpointId: string;
        mediaType: "image" | "video" | "audio";
        inputLabels?: Record<string, string> | undefined;
        turboInputs?: Record<string, unknown> | undefined;
        deterministic?: boolean | undefined;
      },
      {
        kind: "fal";
        inputs: Record<string, unknown>;
        endpointId: string;
        mediaType: "image" | "video" | "audio";
        inputLabels?: Record<string, string> | undefined;
        turboInputs?: Record<string, unknown> | undefined;
        deterministic?: boolean | undefined;
      }
    >,
    z.ZodObject<
      {
        deterministic: z.ZodOptional<z.ZodBoolean>;
        kind: z.ZodLiteral<"local">;
        operation: z.ZodEnum<["resize", "crop", "blank", "trim", "retime", "frame", "render"]>;
        mediaType: z.ZodEnum<["image", "video", "audio"]>;
        inputs: z.ZodRecord<z.ZodString, z.ZodUnknown>;
      },
      "strip",
      z.ZodTypeAny,
      {
        kind: "local";
        inputs: Record<string, unknown>;
        mediaType: "image" | "video" | "audio";
        operation: "trim" | "resize" | "crop" | "blank" | "retime" | "frame" | "render";
        deterministic?: boolean | undefined;
      },
      {
        kind: "local";
        inputs: Record<string, unknown>;
        mediaType: "image" | "video" | "audio";
        operation: "trim" | "resize" | "crop" | "blank" | "retime" | "frame" | "render";
        deterministic?: boolean | undefined;
      }
    >,
  ]
>;
export type AssetDefinition = z.infer<typeof AssetDefinitionSchema>;
declare const PanelDefinitionSchema: z.ZodObject<
  {
    assetName: z.ZodString;
    assetPath: z.ZodString;
    start: z.ZodNumber;
    duration: z.ZodNumber;
    blocking: z.ZodOptional<z.ZodString>;
    camera: z.ZodOptional<z.ZodString>;
  },
  "strip",
  z.ZodTypeAny,
  {
    duration: number;
    assetName: string;
    assetPath: string;
    start: number;
    blocking?: string | undefined;
    camera?: string | undefined;
  },
  {
    duration: number;
    assetName: string;
    assetPath: string;
    start: number;
    blocking?: string | undefined;
    camera?: string | undefined;
  }
>;
export type PanelDefinition = z.infer<typeof PanelDefinitionSchema>;
declare const ShotDefinitionSchema: z.ZodObject<
  {
    id: z.ZodString;
    duration: z.ZodNumber;
    action: z.ZodString;
    assets: z.ZodRecord<
      z.ZodString,
      z.ZodDiscriminatedUnion<
        "kind",
        [
          z.ZodObject<
            {
              deterministic: z.ZodOptional<z.ZodBoolean>;
              kind: z.ZodLiteral<"comfy">;
              workflow: z.ZodString;
              inputs: z.ZodRecord<z.ZodString, z.ZodUnknown>;
              prunedNodes: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
              prunedPassThroughs: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>;
              outputNodeId: z.ZodOptional<z.ZodString>;
              models: z.ZodOptional<
                z.ZodArray<
                  z.ZodObject<
                    {
                      filename: z.ZodString;
                      type: z.ZodEnum<
                        [
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
                        ]
                      >;
                      nodeId: z.ZodOptional<z.ZodString>;
                      url: z.ZodString;
                      savePath: z.ZodOptional<z.ZodString>;
                      base: z.ZodOptional<z.ZodString>;
                      displayName: z.ZodOptional<z.ZodString>;
                    },
                    "strip",
                    z.ZodTypeAny,
                    {
                      type:
                        | "checkpoint"
                        | "lora"
                        | "VAE"
                        | "clip"
                        | "diffusion_model"
                        | "controlnet"
                        | "upscale"
                        | "embeddings"
                        | "clip_vision"
                        | "unet";
                      url: string;
                      filename: string;
                      nodeId?: string | undefined;
                      savePath?: string | undefined;
                      base?: string | undefined;
                      displayName?: string | undefined;
                    },
                    {
                      type:
                        | "checkpoint"
                        | "lora"
                        | "VAE"
                        | "clip"
                        | "diffusion_model"
                        | "controlnet"
                        | "upscale"
                        | "embeddings"
                        | "clip_vision"
                        | "unet";
                      url: string;
                      filename: string;
                      nodeId?: string | undefined;
                      savePath?: string | undefined;
                      base?: string | undefined;
                      displayName?: string | undefined;
                    }
                  >,
                  "many"
                >
              >;
              nodes: z.ZodOptional<
                z.ZodArray<
                  z.ZodObject<
                    {
                      id: z.ZodString;
                    },
                    "strip",
                    z.ZodTypeAny,
                    {
                      id: string;
                    },
                    {
                      id: string;
                    }
                  >,
                  "many"
                >
              >;
              inputLabels: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>;
              turboInputs: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
            },
            "strip",
            z.ZodTypeAny,
            {
              kind: "comfy";
              workflow: string;
              inputs: Record<string, unknown>;
              prunedNodes?: string[] | undefined;
              prunedPassThroughs?: Record<string, string> | undefined;
              outputNodeId?: string | undefined;
              models?:
                | {
                    type:
                      | "checkpoint"
                      | "lora"
                      | "VAE"
                      | "clip"
                      | "diffusion_model"
                      | "controlnet"
                      | "upscale"
                      | "embeddings"
                      | "clip_vision"
                      | "unet";
                    url: string;
                    filename: string;
                    nodeId?: string | undefined;
                    savePath?: string | undefined;
                    base?: string | undefined;
                    displayName?: string | undefined;
                  }[]
                | undefined;
              nodes?:
                | {
                    id: string;
                  }[]
                | undefined;
              inputLabels?: Record<string, string> | undefined;
              turboInputs?: Record<string, unknown> | undefined;
              deterministic?: boolean | undefined;
            },
            {
              kind: "comfy";
              workflow: string;
              inputs: Record<string, unknown>;
              prunedNodes?: string[] | undefined;
              prunedPassThroughs?: Record<string, string> | undefined;
              outputNodeId?: string | undefined;
              models?:
                | {
                    type:
                      | "checkpoint"
                      | "lora"
                      | "VAE"
                      | "clip"
                      | "diffusion_model"
                      | "controlnet"
                      | "upscale"
                      | "embeddings"
                      | "clip_vision"
                      | "unet";
                    url: string;
                    filename: string;
                    nodeId?: string | undefined;
                    savePath?: string | undefined;
                    base?: string | undefined;
                    displayName?: string | undefined;
                  }[]
                | undefined;
              nodes?:
                | {
                    id: string;
                  }[]
                | undefined;
              inputLabels?: Record<string, string> | undefined;
              turboInputs?: Record<string, unknown> | undefined;
              deterministic?: boolean | undefined;
            }
          >,
          z.ZodObject<
            {
              deterministic: z.ZodOptional<z.ZodBoolean>;
              kind: z.ZodLiteral<"file">;
              path: z.ZodString;
              type: z.ZodOptional<z.ZodEnum<["image", "video", "audio"]>>;
            },
            "strip",
            z.ZodTypeAny,
            {
              kind: "file";
              path: string;
              type?: "image" | "video" | "audio" | undefined;
              deterministic?: boolean | undefined;
            },
            {
              kind: "file";
              path: string;
              type?: "image" | "video" | "audio" | undefined;
              deterministic?: boolean | undefined;
            }
          >,
          z.ZodObject<
            {
              deterministic: z.ZodOptional<z.ZodBoolean>;
              kind: z.ZodLiteral<"fal">;
              endpointId: z.ZodString;
              mediaType: z.ZodEnum<["image", "video", "audio"]>;
              inputs: z.ZodRecord<z.ZodString, z.ZodUnknown>;
              inputLabels: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>;
              turboInputs: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
            },
            "strip",
            z.ZodTypeAny,
            {
              kind: "fal";
              inputs: Record<string, unknown>;
              endpointId: string;
              mediaType: "image" | "video" | "audio";
              inputLabels?: Record<string, string> | undefined;
              turboInputs?: Record<string, unknown> | undefined;
              deterministic?: boolean | undefined;
            },
            {
              kind: "fal";
              inputs: Record<string, unknown>;
              endpointId: string;
              mediaType: "image" | "video" | "audio";
              inputLabels?: Record<string, string> | undefined;
              turboInputs?: Record<string, unknown> | undefined;
              deterministic?: boolean | undefined;
            }
          >,
          z.ZodObject<
            {
              deterministic: z.ZodOptional<z.ZodBoolean>;
              kind: z.ZodLiteral<"local">;
              operation: z.ZodEnum<
                ["resize", "crop", "blank", "trim", "retime", "frame", "render"]
              >;
              mediaType: z.ZodEnum<["image", "video", "audio"]>;
              inputs: z.ZodRecord<z.ZodString, z.ZodUnknown>;
            },
            "strip",
            z.ZodTypeAny,
            {
              kind: "local";
              inputs: Record<string, unknown>;
              mediaType: "image" | "video" | "audio";
              operation: "trim" | "resize" | "crop" | "blank" | "retime" | "frame" | "render";
              deterministic?: boolean | undefined;
            },
            {
              kind: "local";
              inputs: Record<string, unknown>;
              mediaType: "image" | "video" | "audio";
              operation: "trim" | "resize" | "crop" | "blank" | "retime" | "frame" | "render";
              deterministic?: boolean | undefined;
            }
          >,
        ]
      >
    >;
    shotFn: z.ZodOptional<z.ZodType<ShotFunction, z.ZodTypeDef, ShotFunction>>;
    compositionRefs: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
    pictureRefs: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
    stemRefs: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
    narrationStemRefs: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
    cueKinds: z.ZodOptional<
      z.ZodRecord<z.ZodString, z.ZodEnum<["voice", "narration", "mob", "sfx"]>>
    >;
    panels: z.ZodOptional<
      z.ZodArray<
        z.ZodObject<
          {
            assetName: z.ZodString;
            assetPath: z.ZodString;
            start: z.ZodNumber;
            duration: z.ZodNumber;
            blocking: z.ZodOptional<z.ZodString>;
            camera: z.ZodOptional<z.ZodString>;
          },
          "strip",
          z.ZodTypeAny,
          {
            duration: number;
            assetName: string;
            assetPath: string;
            start: number;
            blocking?: string | undefined;
            camera?: string | undefined;
          },
          {
            duration: number;
            assetName: string;
            assetPath: string;
            start: number;
            blocking?: string | undefined;
            camera?: string | undefined;
          }
        >,
        "many"
      >
    >;
    continuedBy: z.ZodOptional<
      z.ZodObject<
        {
          main: z.ZodOptional<z.ZodString>;
          cutin: z.ZodOptional<z.ZodString>;
        },
        "strip",
        z.ZodTypeAny,
        {
          main?: string | undefined;
          cutin?: string | undefined;
        },
        {
          main?: string | undefined;
          cutin?: string | undefined;
        }
      >
    >;
    cutin: z.ZodOptional<
      z.ZodObject<
        {
          refs: z.ZodArray<z.ZodString, "many">;
          sharedRefs: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
          panels: z.ZodOptional<
            z.ZodArray<
              z.ZodObject<
                {
                  assetName: z.ZodString;
                  assetPath: z.ZodString;
                  start: z.ZodNumber;
                  duration: z.ZodNumber;
                  blocking: z.ZodOptional<z.ZodString>;
                  camera: z.ZodOptional<z.ZodString>;
                },
                "strip",
                z.ZodTypeAny,
                {
                  duration: number;
                  assetName: string;
                  assetPath: string;
                  start: number;
                  blocking?: string | undefined;
                  camera?: string | undefined;
                },
                {
                  duration: number;
                  assetName: string;
                  assetPath: string;
                  start: number;
                  blocking?: string | undefined;
                  camera?: string | undefined;
                }
              >,
              "many"
            >
          >;
        },
        "strip",
        z.ZodTypeAny,
        {
          refs: string[];
          panels?:
            | {
                duration: number;
                assetName: string;
                assetPath: string;
                start: number;
                blocking?: string | undefined;
                camera?: string | undefined;
              }[]
            | undefined;
          sharedRefs?: string[] | undefined;
        },
        {
          refs: string[];
          panels?:
            | {
                duration: number;
                assetName: string;
                assetPath: string;
                start: number;
                blocking?: string | undefined;
                camera?: string | undefined;
              }[]
            | undefined;
          sharedRefs?: string[] | undefined;
        }
      >
    >;
    graphic: z.ZodOptional<z.ZodLiteral<true>>;
    pending: z.ZodOptional<z.ZodLiteral<true>>;
    aside: z.ZodOptional<z.ZodLiteral<true>>;
  },
  "strip",
  z.ZodTypeAny,
  {
    duration: number;
    id: string;
    assets: Record<
      string,
      | {
          kind: "comfy";
          workflow: string;
          inputs: Record<string, unknown>;
          prunedNodes?: string[] | undefined;
          prunedPassThroughs?: Record<string, string> | undefined;
          outputNodeId?: string | undefined;
          models?:
            | {
                type:
                  | "checkpoint"
                  | "lora"
                  | "VAE"
                  | "clip"
                  | "diffusion_model"
                  | "controlnet"
                  | "upscale"
                  | "embeddings"
                  | "clip_vision"
                  | "unet";
                url: string;
                filename: string;
                nodeId?: string | undefined;
                savePath?: string | undefined;
                base?: string | undefined;
                displayName?: string | undefined;
              }[]
            | undefined;
          nodes?:
            | {
                id: string;
              }[]
            | undefined;
          inputLabels?: Record<string, string> | undefined;
          turboInputs?: Record<string, unknown> | undefined;
          deterministic?: boolean | undefined;
        }
      | {
          kind: "file";
          path: string;
          type?: "image" | "video" | "audio" | undefined;
          deterministic?: boolean | undefined;
        }
      | {
          kind: "fal";
          inputs: Record<string, unknown>;
          endpointId: string;
          mediaType: "image" | "video" | "audio";
          inputLabels?: Record<string, string> | undefined;
          turboInputs?: Record<string, unknown> | undefined;
          deterministic?: boolean | undefined;
        }
      | {
          kind: "local";
          inputs: Record<string, unknown>;
          mediaType: "image" | "video" | "audio";
          operation: "trim" | "resize" | "crop" | "blank" | "retime" | "frame" | "render";
          deterministic?: boolean | undefined;
        }
    >;
    action: string;
    pending?: true | undefined;
    shotFn?: ShotFunction | undefined;
    compositionRefs?: string[] | undefined;
    pictureRefs?: string[] | undefined;
    stemRefs?: string[] | undefined;
    narrationStemRefs?: string[] | undefined;
    cueKinds?: Record<string, "voice" | "narration" | "mob" | "sfx"> | undefined;
    panels?:
      | {
          duration: number;
          assetName: string;
          assetPath: string;
          start: number;
          blocking?: string | undefined;
          camera?: string | undefined;
        }[]
      | undefined;
    cutin?:
      | {
          refs: string[];
          panels?:
            | {
                duration: number;
                assetName: string;
                assetPath: string;
                start: number;
                blocking?: string | undefined;
                camera?: string | undefined;
              }[]
            | undefined;
          sharedRefs?: string[] | undefined;
        }
      | undefined;
    continuedBy?:
      | {
          main?: string | undefined;
          cutin?: string | undefined;
        }
      | undefined;
    graphic?: true | undefined;
    aside?: true | undefined;
  },
  {
    duration: number;
    id: string;
    assets: Record<
      string,
      | {
          kind: "comfy";
          workflow: string;
          inputs: Record<string, unknown>;
          prunedNodes?: string[] | undefined;
          prunedPassThroughs?: Record<string, string> | undefined;
          outputNodeId?: string | undefined;
          models?:
            | {
                type:
                  | "checkpoint"
                  | "lora"
                  | "VAE"
                  | "clip"
                  | "diffusion_model"
                  | "controlnet"
                  | "upscale"
                  | "embeddings"
                  | "clip_vision"
                  | "unet";
                url: string;
                filename: string;
                nodeId?: string | undefined;
                savePath?: string | undefined;
                base?: string | undefined;
                displayName?: string | undefined;
              }[]
            | undefined;
          nodes?:
            | {
                id: string;
              }[]
            | undefined;
          inputLabels?: Record<string, string> | undefined;
          turboInputs?: Record<string, unknown> | undefined;
          deterministic?: boolean | undefined;
        }
      | {
          kind: "file";
          path: string;
          type?: "image" | "video" | "audio" | undefined;
          deterministic?: boolean | undefined;
        }
      | {
          kind: "fal";
          inputs: Record<string, unknown>;
          endpointId: string;
          mediaType: "image" | "video" | "audio";
          inputLabels?: Record<string, string> | undefined;
          turboInputs?: Record<string, unknown> | undefined;
          deterministic?: boolean | undefined;
        }
      | {
          kind: "local";
          inputs: Record<string, unknown>;
          mediaType: "image" | "video" | "audio";
          operation: "trim" | "resize" | "crop" | "blank" | "retime" | "frame" | "render";
          deterministic?: boolean | undefined;
        }
    >;
    action: string;
    pending?: true | undefined;
    shotFn?: ShotFunction | undefined;
    compositionRefs?: string[] | undefined;
    pictureRefs?: string[] | undefined;
    stemRefs?: string[] | undefined;
    narrationStemRefs?: string[] | undefined;
    cueKinds?: Record<string, "voice" | "narration" | "mob" | "sfx"> | undefined;
    panels?:
      | {
          duration: number;
          assetName: string;
          assetPath: string;
          start: number;
          blocking?: string | undefined;
          camera?: string | undefined;
        }[]
      | undefined;
    cutin?:
      | {
          refs: string[];
          panels?:
            | {
                duration: number;
                assetName: string;
                assetPath: string;
                start: number;
                blocking?: string | undefined;
                camera?: string | undefined;
              }[]
            | undefined;
          sharedRefs?: string[] | undefined;
        }
      | undefined;
    continuedBy?:
      | {
          main?: string | undefined;
          cutin?: string | undefined;
        }
      | undefined;
    graphic?: true | undefined;
    aside?: true | undefined;
  }
>;
export type ShotDefinition = z.infer<typeof ShotDefinitionSchema>;
/**
 * A composition stage's `timeline` callback. It both declares top-level (timeline) assets as a side
 * effect and returns the shot inputs; the shot starters it closes over are injected by the builder,
 * so callers pass only `{ format }` (the render size/fps assets may derive their inputs from).
 */
export type TimelineFunction = (args: { format: VideoFormat }) => {
  shots: Array<{
    id: string;
    fn: ShotFunction;
  }>;
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
declare const DeliverySchema: z.ZodObject<
  {
    size: z.ZodOptional<
      z.ZodObject<
        {
          width: z.ZodNumber;
          height: z.ZodNumber;
        },
        "strip",
        z.ZodTypeAny,
        {
          width: number;
          height: number;
        },
        {
          width: number;
          height: number;
        }
      >
    >;
    upscale: z.ZodOptional<
      z.ZodObject<
        {
          video: z.ZodOptional<z.ZodType<DeliveryUpscaleFn, z.ZodTypeDef, DeliveryUpscaleFn>>;
          frame: z.ZodOptional<z.ZodType<DeliveryUpscaleFn, z.ZodTypeDef, DeliveryUpscaleFn>>;
        },
        "strip",
        z.ZodTypeAny,
        {
          video?: DeliveryUpscaleFn | undefined;
          frame?: DeliveryUpscaleFn | undefined;
        },
        {
          video?: DeliveryUpscaleFn | undefined;
          frame?: DeliveryUpscaleFn | undefined;
        }
      >
    >;
  },
  "strip",
  z.ZodTypeAny,
  {
    upscale?:
      | {
          video?: DeliveryUpscaleFn | undefined;
          frame?: DeliveryUpscaleFn | undefined;
        }
      | undefined;
    size?:
      | {
          width: number;
          height: number;
        }
      | undefined;
  },
  {
    upscale?:
      | {
          video?: DeliveryUpscaleFn | undefined;
          frame?: DeliveryUpscaleFn | undefined;
        }
      | undefined;
    size?:
      | {
          width: number;
          height: number;
        }
      | undefined;
  }
>;
export type Delivery = z.infer<typeof DeliverySchema>;
declare const VideoFormatSchema: z.ZodObject<
  {
    size: z.ZodObject<
      {
        width: z.ZodNumber;
        height: z.ZodNumber;
      },
      "strip",
      z.ZodTypeAny,
      {
        width: number;
        height: number;
      },
      {
        width: number;
        height: number;
      }
    >;
    fps: z.ZodNumber;
  },
  "strip",
  z.ZodTypeAny,
  {
    fps: number;
    size: {
      width: number;
      height: number;
    };
  },
  {
    fps: number;
    size: {
      width: number;
      height: number;
    };
  }
>;
export type VideoFormat = z.infer<typeof VideoFormatSchema>;
declare const ExportSchema: z.ZodObject<
  {
    delivery: z.ZodOptional<
      z.ZodObject<
        {
          size: z.ZodOptional<
            z.ZodObject<
              {
                width: z.ZodNumber;
                height: z.ZodNumber;
              },
              "strip",
              z.ZodTypeAny,
              {
                width: number;
                height: number;
              },
              {
                width: number;
                height: number;
              }
            >
          >;
          upscale: z.ZodOptional<
            z.ZodObject<
              {
                video: z.ZodOptional<z.ZodType<DeliveryUpscaleFn, z.ZodTypeDef, DeliveryUpscaleFn>>;
                frame: z.ZodOptional<z.ZodType<DeliveryUpscaleFn, z.ZodTypeDef, DeliveryUpscaleFn>>;
              },
              "strip",
              z.ZodTypeAny,
              {
                video?: DeliveryUpscaleFn | undefined;
                frame?: DeliveryUpscaleFn | undefined;
              },
              {
                video?: DeliveryUpscaleFn | undefined;
                frame?: DeliveryUpscaleFn | undefined;
              }
            >
          >;
        },
        "strip",
        z.ZodTypeAny,
        {
          upscale?:
            | {
                video?: DeliveryUpscaleFn | undefined;
                frame?: DeliveryUpscaleFn | undefined;
              }
            | undefined;
          size?:
            | {
                width: number;
                height: number;
              }
            | undefined;
        },
        {
          upscale?:
            | {
                video?: DeliveryUpscaleFn | undefined;
                frame?: DeliveryUpscaleFn | undefined;
              }
            | undefined;
          size?:
            | {
                width: number;
                height: number;
              }
            | undefined;
        }
      >
    >;
  },
  "strip",
  z.ZodTypeAny,
  {
    delivery?:
      | {
          upscale?:
            | {
                video?: DeliveryUpscaleFn | undefined;
                frame?: DeliveryUpscaleFn | undefined;
              }
            | undefined;
          size?:
            | {
                width: number;
                height: number;
              }
            | undefined;
        }
      | undefined;
  },
  {
    delivery?:
      | {
          upscale?:
            | {
                video?: DeliveryUpscaleFn | undefined;
                frame?: DeliveryUpscaleFn | undefined;
              }
            | undefined;
          size?:
            | {
                width: number;
                height: number;
              }
            | undefined;
        }
      | undefined;
  }
>;
export type Export = z.infer<typeof ExportSchema>;
declare const TypographySchema: z.ZodObject<
  {
    lang: z.ZodType<LanguageTag, z.ZodTypeDef, LanguageTag>;
    fonts: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
  },
  "strip",
  z.ZodTypeAny,
  {
    lang: LanguageTag;
    fonts?: string[] | undefined;
  },
  {
    lang: LanguageTag;
    fonts?: string[] | undefined;
  }
>;
export type Typography = z.infer<typeof TypographySchema>;
declare const VideoDefinitionSchema: z.ZodObject<
  {
    format: z.ZodObject<
      {
        size: z.ZodObject<
          {
            width: z.ZodNumber;
            height: z.ZodNumber;
          },
          "strip",
          z.ZodTypeAny,
          {
            width: number;
            height: number;
          },
          {
            width: number;
            height: number;
          }
        >;
        fps: z.ZodNumber;
      },
      "strip",
      z.ZodTypeAny,
      {
        fps: number;
        size: {
          width: number;
          height: number;
        };
      },
      {
        fps: number;
        size: {
          width: number;
          height: number;
        };
      }
    >;
    typography: z.ZodObject<
      {
        lang: z.ZodType<LanguageTag, z.ZodTypeDef, LanguageTag>;
        fonts: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
      },
      "strip",
      z.ZodTypeAny,
      {
        lang: LanguageTag;
        fonts?: string[] | undefined;
      },
      {
        lang: LanguageTag;
        fonts?: string[] | undefined;
      }
    >;
    shots: z.ZodArray<
      z.ZodObject<
        {
          id: z.ZodString;
          duration: z.ZodNumber;
          action: z.ZodString;
          assets: z.ZodRecord<
            z.ZodString,
            z.ZodDiscriminatedUnion<
              "kind",
              [
                z.ZodObject<
                  {
                    deterministic: z.ZodOptional<z.ZodBoolean>;
                    kind: z.ZodLiteral<"comfy">;
                    workflow: z.ZodString;
                    inputs: z.ZodRecord<z.ZodString, z.ZodUnknown>;
                    prunedNodes: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
                    prunedPassThroughs: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>;
                    outputNodeId: z.ZodOptional<z.ZodString>;
                    models: z.ZodOptional<
                      z.ZodArray<
                        z.ZodObject<
                          {
                            filename: z.ZodString;
                            type: z.ZodEnum<
                              [
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
                              ]
                            >;
                            nodeId: z.ZodOptional<z.ZodString>;
                            url: z.ZodString;
                            savePath: z.ZodOptional<z.ZodString>;
                            base: z.ZodOptional<z.ZodString>;
                            displayName: z.ZodOptional<z.ZodString>;
                          },
                          "strip",
                          z.ZodTypeAny,
                          {
                            type:
                              | "checkpoint"
                              | "lora"
                              | "VAE"
                              | "clip"
                              | "diffusion_model"
                              | "controlnet"
                              | "upscale"
                              | "embeddings"
                              | "clip_vision"
                              | "unet";
                            url: string;
                            filename: string;
                            nodeId?: string | undefined;
                            savePath?: string | undefined;
                            base?: string | undefined;
                            displayName?: string | undefined;
                          },
                          {
                            type:
                              | "checkpoint"
                              | "lora"
                              | "VAE"
                              | "clip"
                              | "diffusion_model"
                              | "controlnet"
                              | "upscale"
                              | "embeddings"
                              | "clip_vision"
                              | "unet";
                            url: string;
                            filename: string;
                            nodeId?: string | undefined;
                            savePath?: string | undefined;
                            base?: string | undefined;
                            displayName?: string | undefined;
                          }
                        >,
                        "many"
                      >
                    >;
                    nodes: z.ZodOptional<
                      z.ZodArray<
                        z.ZodObject<
                          {
                            id: z.ZodString;
                          },
                          "strip",
                          z.ZodTypeAny,
                          {
                            id: string;
                          },
                          {
                            id: string;
                          }
                        >,
                        "many"
                      >
                    >;
                    inputLabels: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>;
                    turboInputs: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
                  },
                  "strip",
                  z.ZodTypeAny,
                  {
                    kind: "comfy";
                    workflow: string;
                    inputs: Record<string, unknown>;
                    prunedNodes?: string[] | undefined;
                    prunedPassThroughs?: Record<string, string> | undefined;
                    outputNodeId?: string | undefined;
                    models?:
                      | {
                          type:
                            | "checkpoint"
                            | "lora"
                            | "VAE"
                            | "clip"
                            | "diffusion_model"
                            | "controlnet"
                            | "upscale"
                            | "embeddings"
                            | "clip_vision"
                            | "unet";
                          url: string;
                          filename: string;
                          nodeId?: string | undefined;
                          savePath?: string | undefined;
                          base?: string | undefined;
                          displayName?: string | undefined;
                        }[]
                      | undefined;
                    nodes?:
                      | {
                          id: string;
                        }[]
                      | undefined;
                    inputLabels?: Record<string, string> | undefined;
                    turboInputs?: Record<string, unknown> | undefined;
                    deterministic?: boolean | undefined;
                  },
                  {
                    kind: "comfy";
                    workflow: string;
                    inputs: Record<string, unknown>;
                    prunedNodes?: string[] | undefined;
                    prunedPassThroughs?: Record<string, string> | undefined;
                    outputNodeId?: string | undefined;
                    models?:
                      | {
                          type:
                            | "checkpoint"
                            | "lora"
                            | "VAE"
                            | "clip"
                            | "diffusion_model"
                            | "controlnet"
                            | "upscale"
                            | "embeddings"
                            | "clip_vision"
                            | "unet";
                          url: string;
                          filename: string;
                          nodeId?: string | undefined;
                          savePath?: string | undefined;
                          base?: string | undefined;
                          displayName?: string | undefined;
                        }[]
                      | undefined;
                    nodes?:
                      | {
                          id: string;
                        }[]
                      | undefined;
                    inputLabels?: Record<string, string> | undefined;
                    turboInputs?: Record<string, unknown> | undefined;
                    deterministic?: boolean | undefined;
                  }
                >,
                z.ZodObject<
                  {
                    deterministic: z.ZodOptional<z.ZodBoolean>;
                    kind: z.ZodLiteral<"file">;
                    path: z.ZodString;
                    type: z.ZodOptional<z.ZodEnum<["image", "video", "audio"]>>;
                  },
                  "strip",
                  z.ZodTypeAny,
                  {
                    kind: "file";
                    path: string;
                    type?: "image" | "video" | "audio" | undefined;
                    deterministic?: boolean | undefined;
                  },
                  {
                    kind: "file";
                    path: string;
                    type?: "image" | "video" | "audio" | undefined;
                    deterministic?: boolean | undefined;
                  }
                >,
                z.ZodObject<
                  {
                    deterministic: z.ZodOptional<z.ZodBoolean>;
                    kind: z.ZodLiteral<"fal">;
                    endpointId: z.ZodString;
                    mediaType: z.ZodEnum<["image", "video", "audio"]>;
                    inputs: z.ZodRecord<z.ZodString, z.ZodUnknown>;
                    inputLabels: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>;
                    turboInputs: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
                  },
                  "strip",
                  z.ZodTypeAny,
                  {
                    kind: "fal";
                    inputs: Record<string, unknown>;
                    endpointId: string;
                    mediaType: "image" | "video" | "audio";
                    inputLabels?: Record<string, string> | undefined;
                    turboInputs?: Record<string, unknown> | undefined;
                    deterministic?: boolean | undefined;
                  },
                  {
                    kind: "fal";
                    inputs: Record<string, unknown>;
                    endpointId: string;
                    mediaType: "image" | "video" | "audio";
                    inputLabels?: Record<string, string> | undefined;
                    turboInputs?: Record<string, unknown> | undefined;
                    deterministic?: boolean | undefined;
                  }
                >,
                z.ZodObject<
                  {
                    deterministic: z.ZodOptional<z.ZodBoolean>;
                    kind: z.ZodLiteral<"local">;
                    operation: z.ZodEnum<
                      ["resize", "crop", "blank", "trim", "retime", "frame", "render"]
                    >;
                    mediaType: z.ZodEnum<["image", "video", "audio"]>;
                    inputs: z.ZodRecord<z.ZodString, z.ZodUnknown>;
                  },
                  "strip",
                  z.ZodTypeAny,
                  {
                    kind: "local";
                    inputs: Record<string, unknown>;
                    mediaType: "image" | "video" | "audio";
                    operation: "trim" | "resize" | "crop" | "blank" | "retime" | "frame" | "render";
                    deterministic?: boolean | undefined;
                  },
                  {
                    kind: "local";
                    inputs: Record<string, unknown>;
                    mediaType: "image" | "video" | "audio";
                    operation: "trim" | "resize" | "crop" | "blank" | "retime" | "frame" | "render";
                    deterministic?: boolean | undefined;
                  }
                >,
              ]
            >
          >;
          shotFn: z.ZodOptional<z.ZodType<ShotFunction, z.ZodTypeDef, ShotFunction>>;
          compositionRefs: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
          pictureRefs: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
          stemRefs: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
          narrationStemRefs: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
          cueKinds: z.ZodOptional<
            z.ZodRecord<z.ZodString, z.ZodEnum<["voice", "narration", "mob", "sfx"]>>
          >;
          panels: z.ZodOptional<
            z.ZodArray<
              z.ZodObject<
                {
                  assetName: z.ZodString;
                  assetPath: z.ZodString;
                  start: z.ZodNumber;
                  duration: z.ZodNumber;
                  blocking: z.ZodOptional<z.ZodString>;
                  camera: z.ZodOptional<z.ZodString>;
                },
                "strip",
                z.ZodTypeAny,
                {
                  duration: number;
                  assetName: string;
                  assetPath: string;
                  start: number;
                  blocking?: string | undefined;
                  camera?: string | undefined;
                },
                {
                  duration: number;
                  assetName: string;
                  assetPath: string;
                  start: number;
                  blocking?: string | undefined;
                  camera?: string | undefined;
                }
              >,
              "many"
            >
          >;
          continuedBy: z.ZodOptional<
            z.ZodObject<
              {
                main: z.ZodOptional<z.ZodString>;
                cutin: z.ZodOptional<z.ZodString>;
              },
              "strip",
              z.ZodTypeAny,
              {
                main?: string | undefined;
                cutin?: string | undefined;
              },
              {
                main?: string | undefined;
                cutin?: string | undefined;
              }
            >
          >;
          cutin: z.ZodOptional<
            z.ZodObject<
              {
                refs: z.ZodArray<z.ZodString, "many">;
                sharedRefs: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
                panels: z.ZodOptional<
                  z.ZodArray<
                    z.ZodObject<
                      {
                        assetName: z.ZodString;
                        assetPath: z.ZodString;
                        start: z.ZodNumber;
                        duration: z.ZodNumber;
                        blocking: z.ZodOptional<z.ZodString>;
                        camera: z.ZodOptional<z.ZodString>;
                      },
                      "strip",
                      z.ZodTypeAny,
                      {
                        duration: number;
                        assetName: string;
                        assetPath: string;
                        start: number;
                        blocking?: string | undefined;
                        camera?: string | undefined;
                      },
                      {
                        duration: number;
                        assetName: string;
                        assetPath: string;
                        start: number;
                        blocking?: string | undefined;
                        camera?: string | undefined;
                      }
                    >,
                    "many"
                  >
                >;
              },
              "strip",
              z.ZodTypeAny,
              {
                refs: string[];
                panels?:
                  | {
                      duration: number;
                      assetName: string;
                      assetPath: string;
                      start: number;
                      blocking?: string | undefined;
                      camera?: string | undefined;
                    }[]
                  | undefined;
                sharedRefs?: string[] | undefined;
              },
              {
                refs: string[];
                panels?:
                  | {
                      duration: number;
                      assetName: string;
                      assetPath: string;
                      start: number;
                      blocking?: string | undefined;
                      camera?: string | undefined;
                    }[]
                  | undefined;
                sharedRefs?: string[] | undefined;
              }
            >
          >;
          graphic: z.ZodOptional<z.ZodLiteral<true>>;
          pending: z.ZodOptional<z.ZodLiteral<true>>;
          aside: z.ZodOptional<z.ZodLiteral<true>>;
        },
        "strip",
        z.ZodTypeAny,
        {
          duration: number;
          id: string;
          assets: Record<
            string,
            | {
                kind: "comfy";
                workflow: string;
                inputs: Record<string, unknown>;
                prunedNodes?: string[] | undefined;
                prunedPassThroughs?: Record<string, string> | undefined;
                outputNodeId?: string | undefined;
                models?:
                  | {
                      type:
                        | "checkpoint"
                        | "lora"
                        | "VAE"
                        | "clip"
                        | "diffusion_model"
                        | "controlnet"
                        | "upscale"
                        | "embeddings"
                        | "clip_vision"
                        | "unet";
                      url: string;
                      filename: string;
                      nodeId?: string | undefined;
                      savePath?: string | undefined;
                      base?: string | undefined;
                      displayName?: string | undefined;
                    }[]
                  | undefined;
                nodes?:
                  | {
                      id: string;
                    }[]
                  | undefined;
                inputLabels?: Record<string, string> | undefined;
                turboInputs?: Record<string, unknown> | undefined;
                deterministic?: boolean | undefined;
              }
            | {
                kind: "file";
                path: string;
                type?: "image" | "video" | "audio" | undefined;
                deterministic?: boolean | undefined;
              }
            | {
                kind: "fal";
                inputs: Record<string, unknown>;
                endpointId: string;
                mediaType: "image" | "video" | "audio";
                inputLabels?: Record<string, string> | undefined;
                turboInputs?: Record<string, unknown> | undefined;
                deterministic?: boolean | undefined;
              }
            | {
                kind: "local";
                inputs: Record<string, unknown>;
                mediaType: "image" | "video" | "audio";
                operation: "trim" | "resize" | "crop" | "blank" | "retime" | "frame" | "render";
                deterministic?: boolean | undefined;
              }
          >;
          action: string;
          pending?: true | undefined;
          shotFn?: ShotFunction | undefined;
          compositionRefs?: string[] | undefined;
          pictureRefs?: string[] | undefined;
          stemRefs?: string[] | undefined;
          narrationStemRefs?: string[] | undefined;
          cueKinds?: Record<string, "voice" | "narration" | "mob" | "sfx"> | undefined;
          panels?:
            | {
                duration: number;
                assetName: string;
                assetPath: string;
                start: number;
                blocking?: string | undefined;
                camera?: string | undefined;
              }[]
            | undefined;
          cutin?:
            | {
                refs: string[];
                panels?:
                  | {
                      duration: number;
                      assetName: string;
                      assetPath: string;
                      start: number;
                      blocking?: string | undefined;
                      camera?: string | undefined;
                    }[]
                  | undefined;
                sharedRefs?: string[] | undefined;
              }
            | undefined;
          continuedBy?:
            | {
                main?: string | undefined;
                cutin?: string | undefined;
              }
            | undefined;
          graphic?: true | undefined;
          aside?: true | undefined;
        },
        {
          duration: number;
          id: string;
          assets: Record<
            string,
            | {
                kind: "comfy";
                workflow: string;
                inputs: Record<string, unknown>;
                prunedNodes?: string[] | undefined;
                prunedPassThroughs?: Record<string, string> | undefined;
                outputNodeId?: string | undefined;
                models?:
                  | {
                      type:
                        | "checkpoint"
                        | "lora"
                        | "VAE"
                        | "clip"
                        | "diffusion_model"
                        | "controlnet"
                        | "upscale"
                        | "embeddings"
                        | "clip_vision"
                        | "unet";
                      url: string;
                      filename: string;
                      nodeId?: string | undefined;
                      savePath?: string | undefined;
                      base?: string | undefined;
                      displayName?: string | undefined;
                    }[]
                  | undefined;
                nodes?:
                  | {
                      id: string;
                    }[]
                  | undefined;
                inputLabels?: Record<string, string> | undefined;
                turboInputs?: Record<string, unknown> | undefined;
                deterministic?: boolean | undefined;
              }
            | {
                kind: "file";
                path: string;
                type?: "image" | "video" | "audio" | undefined;
                deterministic?: boolean | undefined;
              }
            | {
                kind: "fal";
                inputs: Record<string, unknown>;
                endpointId: string;
                mediaType: "image" | "video" | "audio";
                inputLabels?: Record<string, string> | undefined;
                turboInputs?: Record<string, unknown> | undefined;
                deterministic?: boolean | undefined;
              }
            | {
                kind: "local";
                inputs: Record<string, unknown>;
                mediaType: "image" | "video" | "audio";
                operation: "trim" | "resize" | "crop" | "blank" | "retime" | "frame" | "render";
                deterministic?: boolean | undefined;
              }
          >;
          action: string;
          pending?: true | undefined;
          shotFn?: ShotFunction | undefined;
          compositionRefs?: string[] | undefined;
          pictureRefs?: string[] | undefined;
          stemRefs?: string[] | undefined;
          narrationStemRefs?: string[] | undefined;
          cueKinds?: Record<string, "voice" | "narration" | "mob" | "sfx"> | undefined;
          panels?:
            | {
                duration: number;
                assetName: string;
                assetPath: string;
                start: number;
                blocking?: string | undefined;
                camera?: string | undefined;
              }[]
            | undefined;
          cutin?:
            | {
                refs: string[];
                panels?:
                  | {
                      duration: number;
                      assetName: string;
                      assetPath: string;
                      start: number;
                      blocking?: string | undefined;
                      camera?: string | undefined;
                    }[]
                  | undefined;
                sharedRefs?: string[] | undefined;
              }
            | undefined;
          continuedBy?:
            | {
                main?: string | undefined;
                cutin?: string | undefined;
              }
            | undefined;
          graphic?: true | undefined;
          aside?: true | undefined;
        }
      >,
      "many"
    >;
    topLevelAssets: z.ZodOptional<
      z.ZodRecord<
        z.ZodString,
        z.ZodDiscriminatedUnion<
          "kind",
          [
            z.ZodObject<
              {
                deterministic: z.ZodOptional<z.ZodBoolean>;
                kind: z.ZodLiteral<"comfy">;
                workflow: z.ZodString;
                inputs: z.ZodRecord<z.ZodString, z.ZodUnknown>;
                prunedNodes: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
                prunedPassThroughs: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>;
                outputNodeId: z.ZodOptional<z.ZodString>;
                models: z.ZodOptional<
                  z.ZodArray<
                    z.ZodObject<
                      {
                        filename: z.ZodString;
                        type: z.ZodEnum<
                          [
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
                          ]
                        >;
                        nodeId: z.ZodOptional<z.ZodString>;
                        url: z.ZodString;
                        savePath: z.ZodOptional<z.ZodString>;
                        base: z.ZodOptional<z.ZodString>;
                        displayName: z.ZodOptional<z.ZodString>;
                      },
                      "strip",
                      z.ZodTypeAny,
                      {
                        type:
                          | "checkpoint"
                          | "lora"
                          | "VAE"
                          | "clip"
                          | "diffusion_model"
                          | "controlnet"
                          | "upscale"
                          | "embeddings"
                          | "clip_vision"
                          | "unet";
                        url: string;
                        filename: string;
                        nodeId?: string | undefined;
                        savePath?: string | undefined;
                        base?: string | undefined;
                        displayName?: string | undefined;
                      },
                      {
                        type:
                          | "checkpoint"
                          | "lora"
                          | "VAE"
                          | "clip"
                          | "diffusion_model"
                          | "controlnet"
                          | "upscale"
                          | "embeddings"
                          | "clip_vision"
                          | "unet";
                        url: string;
                        filename: string;
                        nodeId?: string | undefined;
                        savePath?: string | undefined;
                        base?: string | undefined;
                        displayName?: string | undefined;
                      }
                    >,
                    "many"
                  >
                >;
                nodes: z.ZodOptional<
                  z.ZodArray<
                    z.ZodObject<
                      {
                        id: z.ZodString;
                      },
                      "strip",
                      z.ZodTypeAny,
                      {
                        id: string;
                      },
                      {
                        id: string;
                      }
                    >,
                    "many"
                  >
                >;
                inputLabels: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>;
                turboInputs: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
              },
              "strip",
              z.ZodTypeAny,
              {
                kind: "comfy";
                workflow: string;
                inputs: Record<string, unknown>;
                prunedNodes?: string[] | undefined;
                prunedPassThroughs?: Record<string, string> | undefined;
                outputNodeId?: string | undefined;
                models?:
                  | {
                      type:
                        | "checkpoint"
                        | "lora"
                        | "VAE"
                        | "clip"
                        | "diffusion_model"
                        | "controlnet"
                        | "upscale"
                        | "embeddings"
                        | "clip_vision"
                        | "unet";
                      url: string;
                      filename: string;
                      nodeId?: string | undefined;
                      savePath?: string | undefined;
                      base?: string | undefined;
                      displayName?: string | undefined;
                    }[]
                  | undefined;
                nodes?:
                  | {
                      id: string;
                    }[]
                  | undefined;
                inputLabels?: Record<string, string> | undefined;
                turboInputs?: Record<string, unknown> | undefined;
                deterministic?: boolean | undefined;
              },
              {
                kind: "comfy";
                workflow: string;
                inputs: Record<string, unknown>;
                prunedNodes?: string[] | undefined;
                prunedPassThroughs?: Record<string, string> | undefined;
                outputNodeId?: string | undefined;
                models?:
                  | {
                      type:
                        | "checkpoint"
                        | "lora"
                        | "VAE"
                        | "clip"
                        | "diffusion_model"
                        | "controlnet"
                        | "upscale"
                        | "embeddings"
                        | "clip_vision"
                        | "unet";
                      url: string;
                      filename: string;
                      nodeId?: string | undefined;
                      savePath?: string | undefined;
                      base?: string | undefined;
                      displayName?: string | undefined;
                    }[]
                  | undefined;
                nodes?:
                  | {
                      id: string;
                    }[]
                  | undefined;
                inputLabels?: Record<string, string> | undefined;
                turboInputs?: Record<string, unknown> | undefined;
                deterministic?: boolean | undefined;
              }
            >,
            z.ZodObject<
              {
                deterministic: z.ZodOptional<z.ZodBoolean>;
                kind: z.ZodLiteral<"file">;
                path: z.ZodString;
                type: z.ZodOptional<z.ZodEnum<["image", "video", "audio"]>>;
              },
              "strip",
              z.ZodTypeAny,
              {
                kind: "file";
                path: string;
                type?: "image" | "video" | "audio" | undefined;
                deterministic?: boolean | undefined;
              },
              {
                kind: "file";
                path: string;
                type?: "image" | "video" | "audio" | undefined;
                deterministic?: boolean | undefined;
              }
            >,
            z.ZodObject<
              {
                deterministic: z.ZodOptional<z.ZodBoolean>;
                kind: z.ZodLiteral<"fal">;
                endpointId: z.ZodString;
                mediaType: z.ZodEnum<["image", "video", "audio"]>;
                inputs: z.ZodRecord<z.ZodString, z.ZodUnknown>;
                inputLabels: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>;
                turboInputs: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
              },
              "strip",
              z.ZodTypeAny,
              {
                kind: "fal";
                inputs: Record<string, unknown>;
                endpointId: string;
                mediaType: "image" | "video" | "audio";
                inputLabels?: Record<string, string> | undefined;
                turboInputs?: Record<string, unknown> | undefined;
                deterministic?: boolean | undefined;
              },
              {
                kind: "fal";
                inputs: Record<string, unknown>;
                endpointId: string;
                mediaType: "image" | "video" | "audio";
                inputLabels?: Record<string, string> | undefined;
                turboInputs?: Record<string, unknown> | undefined;
                deterministic?: boolean | undefined;
              }
            >,
            z.ZodObject<
              {
                deterministic: z.ZodOptional<z.ZodBoolean>;
                kind: z.ZodLiteral<"local">;
                operation: z.ZodEnum<
                  ["resize", "crop", "blank", "trim", "retime", "frame", "render"]
                >;
                mediaType: z.ZodEnum<["image", "video", "audio"]>;
                inputs: z.ZodRecord<z.ZodString, z.ZodUnknown>;
              },
              "strip",
              z.ZodTypeAny,
              {
                kind: "local";
                inputs: Record<string, unknown>;
                mediaType: "image" | "video" | "audio";
                operation: "trim" | "resize" | "crop" | "blank" | "retime" | "frame" | "render";
                deterministic?: boolean | undefined;
              },
              {
                kind: "local";
                inputs: Record<string, unknown>;
                mediaType: "image" | "video" | "audio";
                operation: "trim" | "resize" | "crop" | "blank" | "retime" | "frame" | "render";
                deterministic?: boolean | undefined;
              }
            >,
          ]
        >
      >
    >;
    timelineSoundtracks: z.ZodOptional<
      z.ZodType<
        readonly SoundtrackEntry<string>[],
        z.ZodTypeDef,
        readonly SoundtrackEntry<string>[]
      >
    >;
    timelineFn: z.ZodOptional<z.ZodType<TimelineFunction, z.ZodTypeDef, TimelineFunction>>;
    prompts: z.ZodOptional<
      z.ZodType<readonly PromptOccurrence[], z.ZodTypeDef, readonly PromptOccurrence[]>
    >;
    pins: z.ZodOptional<
      z.ZodType<readonly PinOccurrence[], z.ZodTypeDef, readonly PinOccurrence[]>
    >;
    imageInputs: z.ZodOptional<
      z.ZodType<readonly ImageInputOccurrence[], z.ZodTypeDef, readonly ImageInputOccurrence[]>
    >;
    prevPanelReaders: z.ZodOptional<z.ZodType<readonly string[], z.ZodTypeDef, readonly string[]>>;
    waivers: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>;
    respellings: z.ZodOptional<
      z.ZodArray<
        z.ZodObject<
          {
            shot: z.ZodOptional<z.ZodString>;
            line: z.ZodString;
            as: z.ZodString;
          },
          "strip",
          z.ZodTypeAny,
          {
            line: string;
            as: string;
            shot?: string | undefined;
          },
          {
            line: string;
            as: string;
            shot?: string | undefined;
          }
        >,
        "many"
      >
    >;
  } & {
    stage: z.ZodLiteral<"video">;
    export: z.ZodOptional<
      z.ZodObject<
        {
          delivery: z.ZodOptional<
            z.ZodObject<
              {
                size: z.ZodOptional<
                  z.ZodObject<
                    {
                      width: z.ZodNumber;
                      height: z.ZodNumber;
                    },
                    "strip",
                    z.ZodTypeAny,
                    {
                      width: number;
                      height: number;
                    },
                    {
                      width: number;
                      height: number;
                    }
                  >
                >;
                upscale: z.ZodOptional<
                  z.ZodObject<
                    {
                      video: z.ZodOptional<
                        z.ZodType<DeliveryUpscaleFn, z.ZodTypeDef, DeliveryUpscaleFn>
                      >;
                      frame: z.ZodOptional<
                        z.ZodType<DeliveryUpscaleFn, z.ZodTypeDef, DeliveryUpscaleFn>
                      >;
                    },
                    "strip",
                    z.ZodTypeAny,
                    {
                      video?: DeliveryUpscaleFn | undefined;
                      frame?: DeliveryUpscaleFn | undefined;
                    },
                    {
                      video?: DeliveryUpscaleFn | undefined;
                      frame?: DeliveryUpscaleFn | undefined;
                    }
                  >
                >;
              },
              "strip",
              z.ZodTypeAny,
              {
                upscale?:
                  | {
                      video?: DeliveryUpscaleFn | undefined;
                      frame?: DeliveryUpscaleFn | undefined;
                    }
                  | undefined;
                size?:
                  | {
                      width: number;
                      height: number;
                    }
                  | undefined;
              },
              {
                upscale?:
                  | {
                      video?: DeliveryUpscaleFn | undefined;
                      frame?: DeliveryUpscaleFn | undefined;
                    }
                  | undefined;
                size?:
                  | {
                      width: number;
                      height: number;
                    }
                  | undefined;
              }
            >
          >;
        },
        "strip",
        z.ZodTypeAny,
        {
          delivery?:
            | {
                upscale?:
                  | {
                      video?: DeliveryUpscaleFn | undefined;
                      frame?: DeliveryUpscaleFn | undefined;
                    }
                  | undefined;
                size?:
                  | {
                      width: number;
                      height: number;
                    }
                  | undefined;
              }
            | undefined;
        },
        {
          delivery?:
            | {
                upscale?:
                  | {
                      video?: DeliveryUpscaleFn | undefined;
                      frame?: DeliveryUpscaleFn | undefined;
                    }
                  | undefined;
                size?:
                  | {
                      width: number;
                      height: number;
                    }
                  | undefined;
              }
            | undefined;
        }
      >
    >;
  },
  "strip",
  z.ZodTypeAny,
  {
    stage: "video";
    shots: {
      duration: number;
      id: string;
      assets: Record<
        string,
        | {
            kind: "comfy";
            workflow: string;
            inputs: Record<string, unknown>;
            prunedNodes?: string[] | undefined;
            prunedPassThroughs?: Record<string, string> | undefined;
            outputNodeId?: string | undefined;
            models?:
              | {
                  type:
                    | "checkpoint"
                    | "lora"
                    | "VAE"
                    | "clip"
                    | "diffusion_model"
                    | "controlnet"
                    | "upscale"
                    | "embeddings"
                    | "clip_vision"
                    | "unet";
                  url: string;
                  filename: string;
                  nodeId?: string | undefined;
                  savePath?: string | undefined;
                  base?: string | undefined;
                  displayName?: string | undefined;
                }[]
              | undefined;
            nodes?:
              | {
                  id: string;
                }[]
              | undefined;
            inputLabels?: Record<string, string> | undefined;
            turboInputs?: Record<string, unknown> | undefined;
            deterministic?: boolean | undefined;
          }
        | {
            kind: "file";
            path: string;
            type?: "image" | "video" | "audio" | undefined;
            deterministic?: boolean | undefined;
          }
        | {
            kind: "fal";
            inputs: Record<string, unknown>;
            endpointId: string;
            mediaType: "image" | "video" | "audio";
            inputLabels?: Record<string, string> | undefined;
            turboInputs?: Record<string, unknown> | undefined;
            deterministic?: boolean | undefined;
          }
        | {
            kind: "local";
            inputs: Record<string, unknown>;
            mediaType: "image" | "video" | "audio";
            operation: "trim" | "resize" | "crop" | "blank" | "retime" | "frame" | "render";
            deterministic?: boolean | undefined;
          }
      >;
      action: string;
      pending?: true | undefined;
      shotFn?: ShotFunction | undefined;
      compositionRefs?: string[] | undefined;
      pictureRefs?: string[] | undefined;
      stemRefs?: string[] | undefined;
      narrationStemRefs?: string[] | undefined;
      cueKinds?: Record<string, "voice" | "narration" | "mob" | "sfx"> | undefined;
      panels?:
        | {
            duration: number;
            assetName: string;
            assetPath: string;
            start: number;
            blocking?: string | undefined;
            camera?: string | undefined;
          }[]
        | undefined;
      cutin?:
        | {
            refs: string[];
            panels?:
              | {
                  duration: number;
                  assetName: string;
                  assetPath: string;
                  start: number;
                  blocking?: string | undefined;
                  camera?: string | undefined;
                }[]
              | undefined;
            sharedRefs?: string[] | undefined;
          }
        | undefined;
      continuedBy?:
        | {
            main?: string | undefined;
            cutin?: string | undefined;
          }
        | undefined;
      graphic?: true | undefined;
      aside?: true | undefined;
    }[];
    format: {
      fps: number;
      size: {
        width: number;
        height: number;
      };
    };
    typography: {
      lang: LanguageTag;
      fonts?: string[] | undefined;
    };
    export?:
      | {
          delivery?:
            | {
                upscale?:
                  | {
                      video?: DeliveryUpscaleFn | undefined;
                      frame?: DeliveryUpscaleFn | undefined;
                    }
                  | undefined;
                size?:
                  | {
                      width: number;
                      height: number;
                    }
                  | undefined;
              }
            | undefined;
        }
      | undefined;
    topLevelAssets?:
      | Record<
          string,
          | {
              kind: "comfy";
              workflow: string;
              inputs: Record<string, unknown>;
              prunedNodes?: string[] | undefined;
              prunedPassThroughs?: Record<string, string> | undefined;
              outputNodeId?: string | undefined;
              models?:
                | {
                    type:
                      | "checkpoint"
                      | "lora"
                      | "VAE"
                      | "clip"
                      | "diffusion_model"
                      | "controlnet"
                      | "upscale"
                      | "embeddings"
                      | "clip_vision"
                      | "unet";
                    url: string;
                    filename: string;
                    nodeId?: string | undefined;
                    savePath?: string | undefined;
                    base?: string | undefined;
                    displayName?: string | undefined;
                  }[]
                | undefined;
              nodes?:
                | {
                    id: string;
                  }[]
                | undefined;
              inputLabels?: Record<string, string> | undefined;
              turboInputs?: Record<string, unknown> | undefined;
              deterministic?: boolean | undefined;
            }
          | {
              kind: "file";
              path: string;
              type?: "image" | "video" | "audio" | undefined;
              deterministic?: boolean | undefined;
            }
          | {
              kind: "fal";
              inputs: Record<string, unknown>;
              endpointId: string;
              mediaType: "image" | "video" | "audio";
              inputLabels?: Record<string, string> | undefined;
              turboInputs?: Record<string, unknown> | undefined;
              deterministic?: boolean | undefined;
            }
          | {
              kind: "local";
              inputs: Record<string, unknown>;
              mediaType: "image" | "video" | "audio";
              operation: "trim" | "resize" | "crop" | "blank" | "retime" | "frame" | "render";
              deterministic?: boolean | undefined;
            }
        >
      | undefined;
    prompts?: readonly PromptOccurrence[] | undefined;
    pins?: readonly PinOccurrence[] | undefined;
    waivers?: Record<string, string> | undefined;
    timelineSoundtracks?: readonly SoundtrackEntry<string>[] | undefined;
    timelineFn?: TimelineFunction | undefined;
    imageInputs?: readonly ImageInputOccurrence[] | undefined;
    prevPanelReaders?: readonly string[] | undefined;
    respellings?:
      | {
          line: string;
          as: string;
          shot?: string | undefined;
        }[]
      | undefined;
  },
  {
    stage: "video";
    shots: {
      duration: number;
      id: string;
      assets: Record<
        string,
        | {
            kind: "comfy";
            workflow: string;
            inputs: Record<string, unknown>;
            prunedNodes?: string[] | undefined;
            prunedPassThroughs?: Record<string, string> | undefined;
            outputNodeId?: string | undefined;
            models?:
              | {
                  type:
                    | "checkpoint"
                    | "lora"
                    | "VAE"
                    | "clip"
                    | "diffusion_model"
                    | "controlnet"
                    | "upscale"
                    | "embeddings"
                    | "clip_vision"
                    | "unet";
                  url: string;
                  filename: string;
                  nodeId?: string | undefined;
                  savePath?: string | undefined;
                  base?: string | undefined;
                  displayName?: string | undefined;
                }[]
              | undefined;
            nodes?:
              | {
                  id: string;
                }[]
              | undefined;
            inputLabels?: Record<string, string> | undefined;
            turboInputs?: Record<string, unknown> | undefined;
            deterministic?: boolean | undefined;
          }
        | {
            kind: "file";
            path: string;
            type?: "image" | "video" | "audio" | undefined;
            deterministic?: boolean | undefined;
          }
        | {
            kind: "fal";
            inputs: Record<string, unknown>;
            endpointId: string;
            mediaType: "image" | "video" | "audio";
            inputLabels?: Record<string, string> | undefined;
            turboInputs?: Record<string, unknown> | undefined;
            deterministic?: boolean | undefined;
          }
        | {
            kind: "local";
            inputs: Record<string, unknown>;
            mediaType: "image" | "video" | "audio";
            operation: "trim" | "resize" | "crop" | "blank" | "retime" | "frame" | "render";
            deterministic?: boolean | undefined;
          }
      >;
      action: string;
      pending?: true | undefined;
      shotFn?: ShotFunction | undefined;
      compositionRefs?: string[] | undefined;
      pictureRefs?: string[] | undefined;
      stemRefs?: string[] | undefined;
      narrationStemRefs?: string[] | undefined;
      cueKinds?: Record<string, "voice" | "narration" | "mob" | "sfx"> | undefined;
      panels?:
        | {
            duration: number;
            assetName: string;
            assetPath: string;
            start: number;
            blocking?: string | undefined;
            camera?: string | undefined;
          }[]
        | undefined;
      cutin?:
        | {
            refs: string[];
            panels?:
              | {
                  duration: number;
                  assetName: string;
                  assetPath: string;
                  start: number;
                  blocking?: string | undefined;
                  camera?: string | undefined;
                }[]
              | undefined;
            sharedRefs?: string[] | undefined;
          }
        | undefined;
      continuedBy?:
        | {
            main?: string | undefined;
            cutin?: string | undefined;
          }
        | undefined;
      graphic?: true | undefined;
      aside?: true | undefined;
    }[];
    format: {
      fps: number;
      size: {
        width: number;
        height: number;
      };
    };
    typography: {
      lang: LanguageTag;
      fonts?: string[] | undefined;
    };
    export?:
      | {
          delivery?:
            | {
                upscale?:
                  | {
                      video?: DeliveryUpscaleFn | undefined;
                      frame?: DeliveryUpscaleFn | undefined;
                    }
                  | undefined;
                size?:
                  | {
                      width: number;
                      height: number;
                    }
                  | undefined;
              }
            | undefined;
        }
      | undefined;
    topLevelAssets?:
      | Record<
          string,
          | {
              kind: "comfy";
              workflow: string;
              inputs: Record<string, unknown>;
              prunedNodes?: string[] | undefined;
              prunedPassThroughs?: Record<string, string> | undefined;
              outputNodeId?: string | undefined;
              models?:
                | {
                    type:
                      | "checkpoint"
                      | "lora"
                      | "VAE"
                      | "clip"
                      | "diffusion_model"
                      | "controlnet"
                      | "upscale"
                      | "embeddings"
                      | "clip_vision"
                      | "unet";
                    url: string;
                    filename: string;
                    nodeId?: string | undefined;
                    savePath?: string | undefined;
                    base?: string | undefined;
                    displayName?: string | undefined;
                  }[]
                | undefined;
              nodes?:
                | {
                    id: string;
                  }[]
                | undefined;
              inputLabels?: Record<string, string> | undefined;
              turboInputs?: Record<string, unknown> | undefined;
              deterministic?: boolean | undefined;
            }
          | {
              kind: "file";
              path: string;
              type?: "image" | "video" | "audio" | undefined;
              deterministic?: boolean | undefined;
            }
          | {
              kind: "fal";
              inputs: Record<string, unknown>;
              endpointId: string;
              mediaType: "image" | "video" | "audio";
              inputLabels?: Record<string, string> | undefined;
              turboInputs?: Record<string, unknown> | undefined;
              deterministic?: boolean | undefined;
            }
          | {
              kind: "local";
              inputs: Record<string, unknown>;
              mediaType: "image" | "video" | "audio";
              operation: "trim" | "resize" | "crop" | "blank" | "retime" | "frame" | "render";
              deterministic?: boolean | undefined;
            }
        >
      | undefined;
    prompts?: readonly PromptOccurrence[] | undefined;
    pins?: readonly PinOccurrence[] | undefined;
    waivers?: Record<string, string> | undefined;
    timelineSoundtracks?: readonly SoundtrackEntry<string>[] | undefined;
    timelineFn?: TimelineFunction | undefined;
    imageInputs?: readonly ImageInputOccurrence[] | undefined;
    prevPanelReaders?: readonly string[] | undefined;
    respellings?:
      | {
          line: string;
          as: string;
          shot?: string | undefined;
        }[]
      | undefined;
  }
>;
export type VideoDefinition = z.infer<typeof VideoDefinitionSchema>;
/**
 * One field of a structured `"prompt"` input. `render` turns the caller's value into its section;
 * its parameter type is the type the caller passes. A `render` taking no argument is a constant
 * section: always written, never passed.
 */
export interface PromptStructureField {
  render: (value: never) => string;
  required?: boolean;
  description?: string;
}
/**
 * How a `"prompt"` input is assembled from fields: each field that has a value, rendered, in
 * declaration order, joined by `join`.
 */
export interface PromptStructure {
  join: string;
  fields: Record<string, PromptStructureField>;
}
export type Fields<S extends PromptStructure> = S["fields"];
export type ValuedFieldKey<S extends PromptStructure> = {
  [K in keyof Fields<S>]: Parameters<Fields<S>[K]["render"]> extends [] ? never : K;
}[keyof Fields<S>];
export type RequiredFieldKey<S extends PromptStructure> = {
  [K in ValuedFieldKey<S>]: Fields<S>[K] extends {
    required: true;
  }
    ? K
    : never;
}[ValuedFieldKey<S>];
export type FieldValue<F extends PromptStructureField> = Parameters<F["render"]>[0];
export type PromptStructureValue<S extends PromptStructure> = {
  [K in RequiredFieldKey<S>]: FieldValue<Fields<S>[K]>;
} & {
  [K in Exclude<ValuedFieldKey<S>, RequiredFieldKey<S>>]?: FieldValue<Fields<S>[K]>;
};
/** A structured prompt on the meta: the fields a caller passes, and the assembly `asset()` runs. */
export interface PromptStructureMeta {
  fields: Record<
    string,
    {
      required: boolean;
      description?: string;
    }
  >;
  assemble: (value: unknown) => string;
}
/** `seconds` as `mm:ss.mmm`, rounded to the millisecond first (`59.9996` is `01:00.000`). */
export declare function formatCutTime(seconds: number): string;
export type AdapterBackendKind = "comfy" | "fal" | "local" | "file";
/**
 * The five places `asset()` can be called from. A stage build reaches exactly one — a shot build
 * clears the timeline context.
 */
export type AssetDeclarationSite = "patch" | "plate" | "reference" | "timeline" | "shot";
export interface AdapterMetaInput {
  type: string;
  required: boolean;
  default?: string | number | boolean;
  computed?: boolean;
  grid?: {
    step: number;
    offset?: number;
  };
  max?: number;
  clock?: number;
  pin?: "start" | "end";
  values?: readonly string[];
  array?: boolean;
  description?: string;
  structure?: PromptStructureMeta;
}
/**
 * What `konte adapter list`/`show` reports about an adapter without calling it: enough
 * to pick one (backend, media kind, required inputs, prose) and to write the asset()
 * call. `ref` is the backend's own identifier — a workflow filename, an endpoint id,
 * a model slug, an ffmpeg operation.
 */
export interface AdapterMeta {
  backend: AdapterBackendKind;
  mediaType: MediaKind;
  description: string;
  ref: string;
  inputs: Record<string, AdapterMetaInput>;
  guide?: string | readonly string[];
  allowedIn?: readonly AssetDeclarationSite[];
  promptExemptions?: readonly RegExp[];
  spokenTextPattern?: RegExp;
  readsPrevPanel?: true;
  turbo?: Record<string, string | number | boolean>;
}
export interface AssetAdapter<TInputs extends Record<string, unknown>, TOutput extends MediaKind> {
  type: TOutput;
  meta: AdapterMeta;
  createDefinition(inputs: TInputs): AssetDefinition;
}
export type DeclaredPin =
  | "start"
  | "end"
  | {
      end: {
        nodeId: string;
        field: string;
      };
    };
export type AdapterInputs<T> = T extends AssetAdapter<infer I, any> ? I : never;
export type AdapterOutput<T> = T extends AssetAdapter<any, infer O> ? O : never;
export type BrandedMediaAsset<
  TName extends string,
  TAdapter extends AssetAdapter<any, any>,
> = MediaAsset<AdapterOutput<TAdapter>> & {
  readonly __partName: TName;
};
/**
 * Declares an asset in the active context: a stage asset inside a `timeline()`/`shot()`, or a
 * shared asset inside `defineReference()` (addressed `reference:<name>`).
 */
export declare function asset<TName extends string, TAdapter extends AssetAdapter<any, any>>(
  name: TName & Identifier<TName>,
  adapter: TAdapter,
  inputs: AdapterInputs<TAdapter>,
): BrandedMediaAsset<TName, TAdapter>;
export type FileAdapterInputs = {
  path: `assets/files/${string}`;
};
export declare const imageFile: AssetAdapter<FileAdapterInputs, "image">;
export declare const videoFile: AssetAdapter<FileAdapterInputs, "video">;
export declare const audioFile: AssetAdapter<FileAdapterInputs, "audio">;
export type ColorString = `#${string}`;
export type ImageResizeInputs = {
  image: MediaAsset<"image">;
  width: number;
  height: number;
};
export type TrimInputs<T extends "video" | "audio"> = {
  source: MediaAsset<T>;
  start: number;
  duration: number;
};
export type ImageCropInputs = {
  image: MediaAsset<"image">;
  x: number;
  y: number;
  width: number;
  height: number;
  outWidth?: number;
  outHeight?: number;
};
export type AudioRetimeInputs = {
  source: MediaAsset<"audio">;
  duration: number;
  waiver?: string;
};
export type VideoFrameInputs = {
  source: MediaAsset<"video">;
  at?: number | "last";
};
/** The canvas the build lays out against — the resolved pixel size of the image it returns. */
export type JsxImageCanvas = {
  width: number;
  height: number;
};
export type JsxImageInputs = {
  /** Omitted, the image is the `background` alone at the resolved canvas size. */
  build?: (canvas: JsxImageCanvas) => React.ReactElement;
  /** Defaults to the canvas the stage resolves for this asset; required where there is none. */
  width?: number;
  height?: number;
  /** `"transparent"` yields an alpha PNG. Defaults to `#000000`. */
  background?: ColorString | "transparent";
};
/**
 * Renders a JSX tree to a PNG through the same headless Chromium, `<Composition>` head and font
 * stack a shot's composition renders with. Every asset the tree references (`<Image src={…}>`)
 * becomes a dependency edge.
 *
 *   const card = asset("titleCard", adapters.jsxImage, {
 *     build: ({ height }) => (
 *       <div className="flex h-full items-center justify-center">
 *         <h1 style={{ fontSize: height * 0.1 }}>タイトル</h1>
 *       </div>
 *     ),
 *   });
 */
export declare const jsxImage: AssetAdapter<JsxImageInputs, "image">;
/**
 * The line as one model has to be spelled it: `respell(script.ane[0], "かあちゃん、飴玉ちょうだい。")`
 * returns the second string and files it as standing for the first.
 *
 * The respelling is written at the take that needs it: two takes of one line may spell it
 * differently, and swapping a speech model never touches `direction.ts`, which keeps the words a
 * subtitle and every review surface show. The voiced check then accepts either spelling, the mix
 * reads the cue as that line's voice, and the prompt check skips it as the line quoted verbatim.
 * No hash reads it.
 */
export declare function respell(line: string, as: string): string;
/**
 * Apply an upscale adapter to its inputs, returning the definition (AssetDefinition). Used
 * inside `export.delivery.upscale.video` / `.frame` to wire konte's injected
 * inputs into the chosen adapter:
 *
 *   upscale: {
 *     video: ({ video, scale }) => upscale(falVideoUpscale, { video, scale }),
 *     // or, for an absolute/preset upscaler:
 *     frame: ({ video, width, height }) => upscale(someUpscaler, { video, width, height }),
 *   }
 *
 * The adapter's input names drive completion, so you only pass what that upscaler takes.
 *
 * A delivery upscale is the one generated asset declared outside `asset()`, so an adapter that names
 * the `asset()` sites it takes is refused here.
 */
export declare function upscale<A extends AssetAdapter<any, any>>(
  adapter: A,
  given: AdapterInputs<A>,
): AssetDefinition;
/**
 * A cross-input constraint the adapter's schema cannot express (H3's `<Picture N>` ordinals). It is
 * handed the resolved inputs keyed by input name — caller value, default or format-derived, with an
 * omitted one absent — and returns why it rejects them, or nothing when they pass. Must be pure and
 * deterministic: a media value is a `__konte:…__` placeholder during discovery and a file path
 * during a render, and only its presence is the same in both.
 */
export type AdapterValidator = ((
  inputs: Readonly<Record<string, unknown>>,
  context?: AdapterValidatorContext,
) => string | undefined) & {
  inputs?: readonly string[];
};
/**
 * The adapter's own shape: `promptInput` is the name of its one `"prompt"` input, undefined when it
 * declares none or several. `shotId` is the shot the asset is declared in, undefined outside one.
 */
export type AdapterValidatorContext = {
  promptInput?: string;
  shotId?: string;
};
/**
 * The value (or values) an input carries when it is not set — an empty string, a `"Auto"` menu
 * entry, the space a workflow leaves in a negative prompt. An absent input is always unset.
 */
export type UnsetValue = string | number | boolean | readonly (string | number | boolean)[];
/**
 * An equality match over other resolved inputs. It holds when every entry does.
 */
export type InputMatch = Readonly<Record<string, string | number | boolean>>;
export interface InertInputsSpec {
  inputs: Readonly<Record<string, UnsetValue>>;
  when?: InputMatch;
  whenNot?: InputMatch;
  whenUnset?: Readonly<Record<string, UnsetValue>>;
  reason: string;
  fix: string;
}
/**
 * Rejects an input the model will not read in the configuration it was given: a negative prompt
 * under a sampler running at CFG 1, a preset menu overridden by a prose description. Nothing fails
 * at generation time — the take comes back as if the input had never been written.
 */
export declare function inertInputs(spec: InertInputsSpec): AdapterValidator;
export interface RequireOneOfSpec {
  inputs: Readonly<Record<string, UnsetValue>>;
  reason: string;
}
/**
 * Rejects a combination in which nothing supplies something the model requires. Each input alone is
 * optional — it is their all being unset that the model rejects.
 */
export declare function requireOneOf(spec: RequireOneOfSpec): AdapterValidator;
/**
 * The slots one prompt tag numbers, in the order the model numbers them. A plain array is
 * exhaustive: every wired slot has to be named. `exhaustive: false` drops that half — either because
 * naming a reference is the author's call (Qwen Image Edit's `image 1` need not appear in a
 * local-edit delta), or because the count is only a ceiling (a silent reference clip carries no
 * `<Audio N>`).
 */
export type PromptTagSlots =
  | readonly string[]
  | {
      slots: readonly string[];
      exhaustive: false;
    };
export interface PromptReferenceTagsSpec {
  prompt?: string;
  form?: "bracketed" | "bare";
  tags: Readonly<Record<string, PromptTagSlots>>;
  prevPanel?: {
    tag: string;
    within: (prompt: string) => string | undefined;
  };
}
/**
 * Rejects a prompt whose reference ordinals do not match the references actually wired.
 *
 * A model that tags its references by ordinal (`<Picture N>`) numbers them by the order the wired
 * ones survive, not by slot — so an ordinal with nothing behind it silently lands on another
 * reference. Slots of one numbered family must also fill upward, since a gap renumbers everything
 * above it.
 */
export declare function promptReferenceTags(spec: PromptReferenceTagsSpec): AdapterValidator;
/**
 * Which decode the adapter runs. R2V and R2I always take the six sections; R2A takes them only when
 * a reference is wired, and three named fields when none is.
 */
export type MinimaxH3Mode = "r2i" | "r2a" | "r2v";
export interface MinimaxH3PromptSpec {
  mode: MinimaxH3Mode;
  prompt?: string;
  length?: string;
  references?: readonly string[];
  frameIndex?: string;
}
/**
 * The model reads six named fields (three on a bare R2A) and everything else as prose. Written for
 * a prompt the adapter's `structure` assembles: the section headers, the task-type brackets, the
 * `[Shot N]` numbering and the cut-time format are rendered, so what is checked here is what the
 * author writes inside them, and what spans sections.
 */
export declare function minimaxH3Prompt(spec: MinimaxH3PromptSpec): AdapterValidator;
/**
 * The span of an H3 prompt that names the frame a cut comes from: `[Shot 1]` of a
 * `detailed_description` that cuts to a `[Shot 2]`. Undefined where the description does not cut.
 * `promptReferenceTags`' `prevPanel.within`.
 */
export declare function minimaxH3CutSource(prompt: string): string | undefined;
export declare const minimaxH3Dialogue: RegExp;
export type ReferenceAssetMap = Record<string, MediaAsset<MediaKind>>;
/**
 * The ref surface: `reference.character` / `reference.bgm`, each a MediaAsset placeholder
 * typed to the media kind its asset() produced.
 */
export type ReferenceRef<TAssets extends ReferenceAssetMap> = {
  readonly [K in keyof TAssets]: TAssets[K];
};
export interface DefineReferenceOptions {
  waivers?: Record<string, string>;
}
/**
 * Declares the reference stage: the direction, then a flat callback that returns a named map of
 * asset()s. The returned object IS both the ReferenceDefinition (loaded by konte) and the ref used by
 * animatic/video to fabricate `reference:<name>` placeholders.
 *
 * The direction is taken for its typesetting (`policy.lang` + `policy.fonts`) and for the canvas
 * each sheet is sized off: its long edge, at the shape the asset's roster asks for
 * (`deriveReferenceSize`). An adapter's `width`/`height` are therefore filled in like a stage's;
 * passing them overrides.
 */
export declare function defineReference<TAssets extends ReferenceAssetMap>(
  direction: DirectionEntry<unknown>,
  fn: () => TAssets,
  opts?: DefineReferenceOptions,
): ReferenceDefinition & ReferenceRef<TAssets>;
/**
 * What a patch file's callback receives. `source` is the variant being patched, as a MediaAsset
 * whose placeholder is the variant's own address, so the adapter sees exactly the take named by the
 * file, never whatever currently resolves. Its kind is the type argument, so the take can be fed to a
 * typed adapter input.
 */
export interface PatchContext<TKind extends MediaKind> {
  source: MediaAsset<TKind>;
}
/**
 * The steps a patch declared, and which one is its output. `assets` are addressed
 * `<stage>:patch.<sourceVariantId>.<name>`; the output's definition is what lands as a new variant
 * at the source's own address.
 */
export interface PatchBuild {
  assets: Record<string, AssetDefinition>;
  outputName: string;
  prompts?: readonly PromptOccurrence[];
  pins?: readonly PinOccurrence[];
}
export interface PatchDefinition {
  build(ctx: PatchBuildContext): PatchBuild;
}
export interface PatchBuildContext {
  stage: AssetStage;
  sourceAddress: string;
  sourceVariantId: string;
  format?: BuildFormat;
}
/**
 * Declares a correction to one generated variant, authored in `patches/<variantId>.ts`. The
 * callback runs like a stage's `timeline()`: it declares steps with `asset(...)` and returns the
 * one that is the correction's output. A step is a real generated asset with its own address, so a
 * multi-step fix (resize, then edit) is ordinary graph work.
 *
 * The type argument pins the source's media kind and holds the output to that same kind.
 */
export declare function definePatch<TKind extends MediaKind>(
  fn: (ctx: PatchContext<TKind>) => MediaAsset<TKind>,
): PatchDefinition;
export type AdapterInputType =
  | "string"
  | "prompt"
  | "negativePrompt"
  | "spokenText"
  | "number"
  | "boolean"
  | "seed"
  | "width"
  | "height"
  | "fps"
  | "frames"
  | "seconds"
  | "image"
  | "video"
  | "audio";
/**
 * A `default` may be a value or a pure function of the active build format. The function must be
 * deterministic: its result lands in the hashed AssetDefinition. `format` is undefined outside a
 * discovery pass (a delivery upscale) and `format.duration` is set only inside a video shot, so
 * guard for both and return a static fallback.
 */
export type AdapterInputDefault =
  | string
  | number
  | boolean
  | ((format: BuildFormat | undefined) => string | number | boolean);
/**
 * The arithmetic grid a model accepts a number on: `step * k + offset` for a whole `k >= 0`, so
 * the offset is also the floor. `{ step: 32 }` is a plain multiple (H3's 32-pixel size grid),
 * `{ step: 17, offset: 5 }` an offset one (H3's 5, 22, 39, … frame counts).
 */
export interface AdapterInputGrid {
  step: number;
  offset?: number;
}
export type AdapterInputDef = AdapterInputDefBase &
  (
    | {
        type: Exclude<AdapterInputType, "prompt">;
        structure?: never;
      }
    | {
        type: "prompt";
        structure?: PromptStructure;
      }
  );
export interface AdapterInputDefBase {
  nodeId: string;
  field: string;
  default?: AdapterInputDefault;
  grid?: AdapterInputGrid;
  max?: number;
  clock?: number;
  fill?: "speech";
  pin?: DeclaredPin;
  values?: readonly string[];
  required?: boolean;
  also?: readonly {
    nodeId: string;
    field: string;
  }[];
  branch?: readonly (
    | string
    | {
        nodeId: string;
        passThrough: string;
      }
  )[];
  description?: string;
}
export interface AdapterOutputDef {
  nodeId: string;
  type: MediaKind;
}
export interface ComfyAssetConfig<
  TInputs extends Record<string, AdapterInputDef>,
  TOutputs extends Record<string, AdapterOutputDef>,
> {
  workflow: string;
  description: string;
  inputs: TInputs;
  outputs: TOutputs;
  primary?: keyof TOutputs & string;
  models?: readonly ComfyModelDeclaration[];
  nodes?: readonly ComfyNodeDeclaration[];
  deterministic?: boolean;
  guide?: string | readonly string[];
  validators?: AdapterValidator | readonly AdapterValidator[];
  promptExemptions?: readonly RegExp[];
  spokenTextPattern?: RegExp;
  allowedIn?: readonly AssetDeclarationSite[];
  readsPrevPanel?: true;
  turbo?: ComfyTurbo<TInputs>;
}
export type ComfyTurbo<TInputs extends Record<string, AdapterInputDef>> = {
  [K in keyof TInputs as TInputs[K] extends {
    type: "string" | "number" | "boolean";
  }
    ? K
    : never]?: InputTSType<TInputs[K]>;
};
export type InputTSType<T extends AdapterInputDef> = T extends {
  type: "string";
  values: readonly (infer V)[];
}
  ? V
  : T extends {
        type: "prompt";
        structure: infer S extends PromptStructure;
      }
    ? PromptStructureValue<S>
    : T extends {
          type: "string" | "prompt" | "negativePrompt" | "spokenText";
        }
      ? string
      : T extends {
            type: "number" | "width" | "height" | "fps" | "frames" | "seconds";
          }
        ? number
        : T extends {
              type: "boolean";
            }
          ? boolean
          : T extends {
                type: "seed";
              }
            ? number | string
            : T extends {
                  type: "image";
                }
              ? MediaAsset<"image">
              : T extends {
                    type: "video";
                  }
                ? MediaAsset<"video">
                : T extends {
                      type: "audio";
                    }
                  ? MediaAsset<"audio">
                  : never;
export type ComfyRequiredKeys<T extends Record<string, AdapterInputDef>> = {
  [K in keyof T]: T[K] extends {
    required: true;
  }
    ? K
    : never;
}[keyof T];
export type ComfyOptionalKeys<T extends Record<string, AdapterInputDef>> = Exclude<
  keyof T,
  ComfyRequiredKeys<T>
>;
export type ComfyCallOptions<
  TInputs extends Record<string, AdapterInputDef>,
  TTurboKey extends PropertyKey = never,
> = {
  [K in Exclude<ComfyRequiredKeys<TInputs>, TTurboKey>]: InputTSType<TInputs[K]>;
} & {
  [K in Exclude<ComfyOptionalKeys<TInputs>, TTurboKey>]?: InputTSType<TInputs[K]>;
};
export type PrimaryOutputKind<
  TOutputs extends Record<string, AdapterOutputDef>,
  TPrimary extends (keyof TOutputs & string) | undefined,
> = TPrimary extends string
  ? TOutputs[TPrimary]["type"]
  : TOutputs[keyof TOutputs & string]["type"];
export declare function defineComfyAsset<
  const TInputs extends Record<string, AdapterInputDef>,
  const TOutputs extends Record<string, AdapterOutputDef>,
  TPrimary extends (keyof TOutputs & string) | undefined = undefined,
  const TTurbo extends ComfyTurbo<TInputs> = {},
>(
  config: ComfyAssetConfig<TInputs, TOutputs> & {
    primary?: TPrimary;
    turbo?: TTurbo;
  },
): AssetAdapter<ComfyCallOptions<TInputs, keyof TTurbo>, PrimaryOutputKind<TOutputs, TPrimary>>;
/**
 * `"prompt"` and `"negativePrompt"` are the two halves of the conditioning the prompt check reads,
 * each on its own polarity; see AdapterInputType.
 */
export type FalInputType =
  | "string"
  | "prompt"
  | "negativePrompt"
  | "spokenText"
  | "number"
  | "boolean"
  | "seed"
  | "image"
  | "video"
  | "audio";
export type FalInputDef = FalInputDefBase &
  (
    | {
        type: Exclude<FalInputType, "prompt">;
        structure?: never;
      }
    | {
        type: "prompt";
        structure?: PromptStructure;
      }
  );
export interface FalInputDefBase {
  field: string;
  fixed?: true;
  default?: string | number | boolean;
  pin?: "start" | "end";
  values?: readonly string[];
  required?: boolean;
  array?: boolean;
  description?: string;
}
export interface FalAssetConfig<
  TInputs extends Record<string, FalInputDef>,
  TMedia extends MediaKind = MediaKind,
> {
  endpointId: string;
  description: string;
  mediaType: TMedia;
  inputs: TInputs;
  deterministic?: boolean;
  guide?: string | readonly string[];
  validators?: AdapterValidator | readonly AdapterValidator[];
  promptExemptions?: readonly RegExp[];
  spokenTextPattern?: RegExp;
  allowedIn?: readonly AssetDeclarationSite[];
  readsPrevPanel?: true;
  turbo?: FalTurbo<TInputs>;
}
export type FalTurbo<TInputs extends Record<string, FalInputDef>> = {
  [K in keyof TInputs as TInputs[K] extends {
    type: "string" | "number" | "boolean";
  }
    ? K
    : never]?: FalInputTSType<TInputs[K]>;
};
export type FalInputTSType<T extends FalInputDef> = T extends {
  type: "string";
  values: readonly (infer V)[];
}
  ? V
  : T extends {
        type: "prompt";
        structure: infer S extends PromptStructure;
      }
    ? PromptStructureValue<S>
    : T extends {
          type: "string" | "prompt" | "negativePrompt" | "spokenText";
        }
      ? string
      : T extends {
            type: "number";
          }
        ? number
        : T extends {
              type: "boolean";
            }
          ? boolean
          : T extends {
                type: "seed";
              }
            ? number | string
            : T extends {
                  type: "image";
                }
              ? T extends {
                  array: true;
                }
                ? MediaAsset<"image">[]
                : MediaAsset<"image">
              : T extends {
                    type: "video";
                  }
                ? T extends {
                    array: true;
                  }
                  ? MediaAsset<"video">[]
                  : MediaAsset<"video">
                : T extends {
                      type: "audio";
                    }
                  ? T extends {
                      array: true;
                    }
                    ? MediaAsset<"audio">[]
                    : MediaAsset<"audio">
                  : never;
export type FalFixedKeys<T extends Record<string, FalInputDef>> = {
  [K in keyof T]: T[K] extends {
    fixed: true;
  }
    ? K
    : never;
}[keyof T];
export type FalRequiredKeys<T extends Record<string, FalInputDef>> = {
  [K in keyof T]: T[K] extends {
    fixed: true;
  }
    ? never
    : T[K] extends {
          required: true;
        }
      ? K
      : never;
}[keyof T];
export type FalOptionalKeys<T extends Record<string, FalInputDef>> = Exclude<
  keyof T,
  FalRequiredKeys<T> | FalFixedKeys<T>
>;
export type FalCallOptions<
  TInputs extends Record<string, FalInputDef>,
  TTurboKey extends PropertyKey = never,
> = {
  [K in Exclude<FalRequiredKeys<TInputs>, TTurboKey>]: FalInputTSType<TInputs[K]>;
} & {
  [K in Exclude<FalOptionalKeys<TInputs>, TTurboKey>]?: FalInputTSType<TInputs[K]>;
};
export declare function defineFalAsset<
  const TInputs extends Record<string, FalInputDef>,
  const TMedia extends MediaKind,
  const TTurbo extends FalTurbo<TInputs> = {},
>(
  config: FalAssetConfig<TInputs, TMedia> & {
    turbo?: TTurbo;
  },
): AssetAdapter<FalCallOptions<TInputs, keyof TTurbo>, TMedia>;
export interface GsapTimeline {
  to(target: string, vars: Record<string, unknown>, position?: number | string): GsapTimeline;
  from(target: string, vars: Record<string, unknown>, position?: number | string): GsapTimeline;
  fromTo(
    target: string,
    fromVars: Record<string, unknown>,
    toVars: Record<string, unknown>,
    position?: number | string,
  ): GsapTimeline;
  set(target: string, vars: Record<string, unknown>, position?: number | string): GsapTimeline;
  add(child: unknown, position?: number | string): GsapTimeline;
  addLabel(label: string, position?: number | string): GsapTimeline;
  call(fn: () => void, position?: number | string): GsapTimeline;
}
export declare function Animate({
  script,
}: {
  script?: (ctx: { timeline: GsapTimeline }) => void;
}): React.ReactElement;
export type AudioElementProps = React.ComponentPropsWithoutRef<"audio">;
export type AudioProps = Omit<AudioElementProps, "src" | "id"> & {
  src: MediaAsset<"audio"> | NarrationStem;
  /**
   * Stable cue id, local to the shot (data-konte-cue) — a display label for the review timeline and
   * `konte probe`. Not an address: `#` is konte's reserved namespace (see address.ts), and a cue id
   * is authored, so a cue is never addressed `…#<id>`. Accept and focus route through the shot.
   */
  id?: string;
  /** Timeline start in seconds, local to the shot it is placed in (data-start). Defaults to 0. */
  start?: number;
  /** Clip duration in seconds (data-duration). Defaults to the source length. */
  duration?: number;
  /**
   * Offset into the source media in seconds (data-media-start). Omitted on a sound effect, the
   * silence its take leads with is skipped, so `start` is where the sound lands.
   */
  mediaStart?: number;
  /** Gain 0–MAX_AUDIO_GAIN (+12 dB), 1 = unity (data-volume). */
  volume?: number;
  /** Fade-in seconds (data-fade-in). */
  fadeIn?: number;
  /** Fade-out seconds (data-fade-out). */
  fadeOut?: number;
};
/**
 * A one-shot sound placed in a shot's composition (dialogue, SFX, narration). Plays once at full
 * length from `start`, extending past the shot boundary if longer than the shot. Muxed onto the
 * final timeline, never baked per shot. For a timeline-spanning bed/music, use the `soundtrack()`
 * entries in the timeline return's `soundtracks` array.
 */
declare function Audio$1({
  src,
  children,
  id,
  start,
  duration,
  mediaStart,
  volume,
  fadeIn,
  fadeOut,
  ...rest
}: AudioProps): React.ReactElement;
export declare function Composition({
  children,
}: {
  children?: React.ReactNode;
}): React.ReactElement;
type Cutin$1 = Cutin;
export type CutinCorner = "top-left" | "top-right" | "bottom-left" | "bottom-right";
export type CutinProps = {
  /** The corner the frame sits in. Defaults to `"bottom-right"`. */
  at?: CutinCorner;
  /** The frame's width as a fraction of the canvas width, `0 < size ≤ 1`; it keeps the canvas aspect. Defaults to 0.3. */
  size?: number;
  /** The gap to the two edges it sits against, as a fraction of the canvas width, `0 ≤ inset < 0.5`. Defaults to 0.03. */
  inset?: number;
  className?: string;
  style?: React.ComponentPropsWithoutRef<"div">["style"];
  children?: React.ReactNode;
};
/**
 * A second camera frame laid over the shot for its whole duration — the wipe the direction declares
 * as the shot's `cutin`. On the animatic its children are that frame's `<Panel>`s, on the video its
 * `<Video>`; a keyframe inside it keys the cutin. Where it sits and how
 * big it is are this component's alone: the direction declares only who the frame holds.
 */
declare function Cutin$1({
  at,
  size,
  inset,
  className,
  style,
  children,
}: CutinProps): React.ReactElement;
export type ImgElementProps = React.ComponentPropsWithoutRef<"img">;
export type ImageProps = Omit<ImgElementProps, "src" | "children"> & {
  src: MediaAsset<"image">;
  /** Timeline start in seconds, local to the shot it is placed in (data-start). Defaults to 0. */
  start?: number;
  /** How long the image shows in seconds (data-duration). Defaults to the shot duration. */
  duration?: number;
  /** A full-stage, cover-fit layer (`konte-clip`); Tailwind utilities in `className` override it. */
  fill?: boolean;
};
/**
 * A still image placed in a shot's composition (a reference logo/character/product, a background
 * plate, an overlay). Render a generated or `file` image asset by its `src`. Defaults to the whole
 * shot; `start`/`duration` window it. `fill` makes it a full-frame layer — without it, position it
 * with Tailwind/inline styles like any `<img>`.
 */
declare function Image$1({
  src,
  start,
  duration,
  fill,
  className,
  alt,
  ...rest
}: ImageProps): React.ReactElement;
type ImgElementProps$1 = React.ComponentPropsWithoutRef<"img">;
export type PanelProps = Omit<ImgElementProps$1, "src" | "children" | "start"> & {
  src: MediaAsset<"image">;
  /**
   * When this keyframe takes over, in shot-local seconds. Omitted, the panel takes its share of
   * whatever the PINNED panels around it leave — with nothing pinned, the shot's panels divide its
   * duration equally in document order. Each panel holds until the next one's `start` (the last
   * until the shot's end) and then CUTS — konte never interpolates between two frames; write a
   * dissolve with `<Animate>`.
   */
  start?: number;
  /** The subject movement carrying this keyframe to the next one (or, on the only panel, to the shot's end). */
  blocking?: string;
  /** The camera's behaviour over that same transit. */
  camera?: string;
};
/**
 * A keyframe of an animatic shot: a part name (the leaf of its `src` address — what
 * `animatic.shot("01").image("first")` reaches from `video.tsx`), a slot on the shot's clock, the
 * movement leaving it, and a frame in the contact sheet. A plain `<Image>` in the same composition
 * is a layer, not a keyframe — use it for a background plate or a title card.
 */
export declare function Panel({
  src,
  start,
  blocking,
  camera,
  className,
  alt,
  ...rest
}: PanelProps): React.ReactElement;
export type DivElementProps = React.ComponentPropsWithoutRef<"div">;
export interface SubtitleEntry {
  start: number;
  end: number;
  text: string;
}
export type SubtitleProps = DivElementProps & {
  entries: SubtitleEntry[];
};
export declare function Subtitle({ entries, ...rest }: SubtitleProps): React.ReactElement | null;
export type VideoElementProps = React.ComponentPropsWithoutRef<"video">;
export type VideoProps = Omit<VideoElementProps, "src"> & {
  src: MediaAsset<"video">;
  /** Timeline start in seconds (data-start). Defaults to 0. */
  start?: number;
  /** Clip duration in seconds (data-duration). Defaults to the shot duration. */
  duration?: number;
  /** Offset into the source media in seconds (data-media-start). */
  mediaStart?: number;
  /** Include the video's audio in the mix (data-has-audio). */
  hasAudio?: boolean;
  /** Audio gain 0–MAX_AUDIO_GAIN (+12 dB), 1 = unity (data-volume). Only applies when hasAudio is true. */
  volume?: number;
  /** Appended to `konte-clip` — a full-stage, cover-fit layer; Tailwind utilities here override it. */
  className?: string;
};
export declare function Video({
  src,
  children,
  muted,
  playsInline,
  start,
  duration,
  mediaStart,
  hasAudio,
  volume,
  className,
  ...rest
}: VideoProps): React.ReactElement;
export declare const adapters: {
  imageFile: AssetAdapter<FileAdapterInputs, "image">;
  videoFile: AssetAdapter<FileAdapterInputs, "video">;
  audioFile: AssetAdapter<FileAdapterInputs, "audio">;
  imageResize: AssetAdapter<ImageResizeInputs, "image">;
  imageCrop: AssetAdapter<ImageCropInputs, "image">;
  videoTrim: AssetAdapter<TrimInputs<"video">, "video">;
  audioTrim: AssetAdapter<TrimInputs<"audio">, "audio">;
  audioRetime: AssetAdapter<AudioRetimeInputs, "audio">;
  videoFrame: AssetAdapter<VideoFrameInputs, "image">;
  jsxImage: AssetAdapter<JsxImageInputs, "image">;
};
export declare function seed(): string & {
  readonly __brand: "KontePlaceholder";
};

export { Audio$1 as Audio, Image$1 as Image };

export type { Location$1 as Location };
export declare const Cutin: typeof Cutin$1;

export declare function jsx(type: any, props: any, key?: string): React.ReactElement;
export declare function jsxs(type: any, props: any, key?: string): React.ReactElement;
export declare function Fragment(props: { children?: any }): React.ReactElement;
