import { isAssetPath } from "../../composition-refs.js";
import { KonteError } from "../../errors.js";
import { type HostVisitor, type RenderContext, renderToHtml } from "../../jsx-html.js";
import type { Typography } from "../../types/definition.js";
import { Composition, CompositionDocument } from "../composition/composition.js";
import {
  collectPlaceholderRefs,
  getActiveFormat,
  getActiveTypography,
  makeAddressPlaceholder,
  parsePlaceholder,
} from "../shot-context.js";
import { type ColorString, parseColorString } from "./local.js";

// A whole `__konte:<address>__` placeholder, for the leftover check below.
const PLACEHOLDER_PATTERN = /__konte:([A-Za-z0-9_.:#-]*?)__/g;

export type JsxRenderAdapter = "jsxImage" | "jsxVideo";

// The capture passes no video-frame injector, so a `<video>` yields the black rectangle headless
// Chromium hands back under a deterministic seek, and an `<audio>` pulls its source in as a
// dependency edge while being inaudible.
function assertNoMediaTag(adapter: JsxRenderAdapter, tag: string): void {
  if (tag !== "video" && tag !== "audio") return;
  throw new KonteError(
    "VALIDATION_FAILED",
    `${adapter} renders a <${tag}>, and its capture plays no media — a <video> comes out black and ` +
      `an <audio> is never heard. Use <Image> for the picture; place motion and sound in the ` +
      `shot's own <Composition>.`,
  );
}

// `<script>` and `<style>` hold raw text, not markup — `<Animate>` emits a whole script body, and
// a `<video` spelled inside one is a string. Counting it would fail the load over an inert mention.
const RAW_TEXT_BODY = /<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi;

// The visitor threw on any host `<video>`/`<audio>`, so one still in the HTML came from raw markup
// (dangerouslySetInnerHTML) that no visitor sees.
const mediaTagCount = (html: string, tag: "video" | "audio"): number =>
  html.replace(RAW_TEXT_BODY, "").match(new RegExp(`<${tag}[\\s/>]`, "gi"))?.length ?? 0;

function assertNoRawMediaTag(adapter: JsxRenderAdapter, html: string, seenAudio: number): void {
  const raw =
    mediaTagCount(html, "video") > 0
      ? "video"
      : mediaTagCount(html, "audio") > seenAudio
        ? "audio"
        : null;
  if (!raw) return;
  throw new KonteError(
    "VALIDATION_FAILED",
    `${adapter} emits a raw <${raw}> (via dangerouslySetInnerHTML). konte cannot see it, so it ` +
      `would reach the capture unchecked. Use <Image>.`,
  );
}

// Every `__konte:` the rendered document carries must be one of the refs that will be substituted
// for a file — a ref the graph also ordered and gated. One that neither harvest pass saw reaches the
// browser verbatim and renders as a broken layer, silently, so it fails the load instead. The two
// passes cover a ref reaching a host `src`; what they cannot see is one embedded inside a longer
// string (a CSS `url(...)`), which is what this rejects.
function assertEveryPlaceholderHarvested(
  adapter: JsxRenderAdapter,
  html: string,
  placeholders: readonly string[],
): void {
  let stripped = html;
  // Longest first, for the same reason the backend substitutes that way — see `substituteRefs`.
  for (const placeholder of [...placeholders].sort((a, b) => b.length - a.length)) {
    stripped = stripped.split(placeholder).join("");
  }
  // A whole placeholder whose body addresses an asset — not the bare prefix. A card is free to
  // print the literal text `__konte:` (or `__konte:hello__`, which addresses nothing); only a real
  // unresolvable ref is a broken layer.
  const leftover = [...stripped.matchAll(PLACEHOLDER_PATTERN)]
    .map((m) => m[1] as string)
    .find(isAssetPath);
  if (leftover === undefined) return;
  throw new KonteError(
    "VALIDATION_FAILED",
    `${adapter} found an asset reference it cannot resolve into a file — "${leftover}", embedded in ` +
      "a longer string rather than passed as a `src`. Render it with `<Image src={…}>` (or an " +
      "`<img>`), which is what the dependency graph and the file substitution both read.",
  );
}

/** The canvas a build lays out against — the resolved pixel size of what it renders. */
export type JsxCanvas = { width: number; height: number };

export function resolveJsxCanvas(
  adapter: JsxRenderAdapter,
  inputs: { width?: number; height?: number },
): JsxCanvas {
  const format = getActiveFormat();
  const width = inputs.width ?? format?.size.width;
  const height = inputs.height ?? format?.size.height;
  if (width === undefined || height === undefined) {
    throw new KonteError(
      "VALIDATION_FAILED",
      `${adapter} needs a width and height. The stage this is declared in has no canvas to take ` +
        "them from, so pass both.",
    );
  }
  return { width, height };
}

// The composition ids the documents carry. Constant, so a shot rename leaves every jsxImage and
// jsxVideo in it current. The bake keys a jsxVideo's timeline by its id.
const JSX_IMAGE_SHOT_ID = "still";
export const JSX_VIDEO_SHOT_ID = "clip";

// A jsxImage document's declared length. A still is captured at t=0, but `<Image>`/`<Subtitle>`
// default their clip window to the render context's duration, and a zero-length window shows nothing.
const JSX_IMAGE_DURATION = 1;

/** What a `jsxImage` / `jsxVideo` definition carries to lay its document out from. */
export interface JsxDocumentInputs {
  /** The stage, rendered in nested mode. */
  stage: string;
  width: number;
  height: number;
  typography: Typography;
  /** jsxVideo only, in seconds. */
  duration?: number;
}

const renderContextOf = (
  adapter: JsxRenderAdapter,
  inputs: Omit<JsxDocumentInputs, "stage">,
): RenderContext => ({
  shotId: adapter === "jsxImage" ? JSX_IMAGE_SHOT_ID : JSX_VIDEO_SHOT_ID,
  width: inputs.width,
  height: inputs.height,
  duration: inputs.duration ?? JSX_IMAGE_DURATION,
  ...(adapter === "jsxImage" ? { still: true } : { virtualClock: true }),
  typography: inputs.typography,
});

/** The whole `<Composition>` document a `jsxImage` / `jsxVideo` is captured from. */
export function jsxDocumentHtml(adapter: JsxRenderAdapter, inputs: JsxDocumentInputs): string {
  return renderToHtml(
    <CompositionDocument stageHtml={inputs.stage} />,
    renderContextOf(adapter, inputs),
  );
}

/**
 * Render a build's tree to the stage a `jsxImage` / `jsxVideo` definition carries, with the
 * placeholders of every asset it references.
 */
export function buildJsxStage(opts: {
  adapter: JsxRenderAdapter;
  canvas: JsxCanvas;
  duration?: number;
  content: React.ReactElement | null;
  background: ColorString | "transparent";
}): JsxDocumentInputs & { refs: string[] } {
  const { adapter, canvas } = opts;
  // A png capture forces html/body transparent (the engine's own alpha path), so an opaque ground
  // has to be painted inside the stage. As a rule on `#stage` rather than as a full-bleed element:
  // a positioned one paints in a later stage than the build's in-flow boxes and would cover them.
  const backdrop =
    opts.background === "transparent" ? null : (
      <style>{`#stage { background: ${parseColorString(opts.background)}; }`}</style>
    );

  // Both passes, as a composition's own ref harvest does (`partitionShotRefs`): the raw tree walk
  // sees a ref passed as a prop to a user component, and only the render sees one a function
  // component pulls in from a closure — `function Layer() { return <Image src={reference.logo}/> }`
  // has no props at all. Missing one means a broken layer no gate catches.
  const refs = new Set<string>(collectPlaceholderRefs(opts.content).filter(isAssetPath));
  let seenAudio = 0;
  const visitor: HostVisitor = (tag, props) => {
    if (tag === "audio") seenAudio++;
    assertNoMediaTag(adapter, tag);
    const src = props.src;
    if (typeof src !== "string") return;
    const parsed = parsePlaceholder(src);
    if (parsed && isAssetPath(parsed)) refs.add(parsed);
  };

  const layout: Omit<JsxDocumentInputs, "stage"> = {
    width: canvas.width,
    height: canvas.height,
    typography: getActiveTypography() ?? { lang: "en" },
    ...(opts.duration !== undefined && { duration: opts.duration }),
  };
  const stage = renderToHtml(
    <Composition>
      {backdrop}
      {opts.content}
    </Composition>,
    { ...renderContextOf(adapter, layout), nested: true },
    visitor,
  );

  assertNoRawMediaTag(adapter, stage, seenAudio);
  const placeholders = [...refs].map(makeAddressPlaceholder);
  assertEveryPlaceholderHarvested(adapter, stage, placeholders);
  return { stage, ...layout, refs: placeholders };
}
