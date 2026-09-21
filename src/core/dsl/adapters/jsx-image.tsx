import type { LocalAssetDefinition } from "../../types/index.js";
import { isAssetPath } from "../../composition-refs.js";
import { KonteError } from "../../errors.js";
import { type HostVisitor, renderToHtml } from "../../jsx-html.js";
import type { AssetAdapter } from "../adapter.js";
import { Composition } from "../composition/composition.js";
import {
  collectPlaceholderRefs,
  getActiveFormat,
  getActiveTypography,
  makeAddressPlaceholder,
  parsePlaceholder,
} from "../shot-context.js";
import { type ColorString, parseColorString } from "./local.js";

// The composition id the document carries. Constant, not the surrounding shot's: the HTML is what
// the definition hash is taken over, so a shot rename would otherwise stale every jsxImage in it.
const STILL_SHOT_ID = "still";

// The document's declared length. A still is captured at t=0, but `<Image>`/`<Subtitle>` default
// their clip window to the render context's duration, and a zero-length window shows nothing.
const STILL_DURATION = 1;

// A whole `__konte:<address>__` placeholder, for the leftover check below.
const PLACEHOLDER_PATTERN = /__konte:([A-Za-z0-9_.:#-]*?)__/g;

// The capture passes no video-frame injector, so a `<video>` yields the black rectangle headless
// Chromium hands back under a deterministic seek, and an `<audio>` pulls its source in as a
// dependency edge while being inaudible. `<Animate>` is left alone — its timeline never runs.
function assertStillTag(tag: string): void {
  if (tag !== "video" && tag !== "audio") return;
  throw new KonteError(
    "VALIDATION_FAILED",
    `jsxImage renders a <${tag}>, and it captures one frame with no clock — a <video> comes out ` +
      `black and an <audio> is never heard. Use <Image> for the picture; place motion and sound in ` +
      `the shot's own <Composition>.`,
  );
}

// `<script>` and `<style>` hold raw text, not markup — `<Animate>` emits a whole script body, and
// a `<video` spelled inside one is a string. Counting it would fail the load over an inert mention.
const RAW_TEXT_BODY = /<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi;

// The visitor threw on any host `<video>`/`<audio>`, so one still in the HTML came from raw markup
// (dangerouslySetInnerHTML) that no visitor sees.
const mediaTagCount = (html: string, tag: "video" | "audio"): number =>
  html.replace(RAW_TEXT_BODY, "").match(new RegExp(`<${tag}[\\s/>]`, "gi"))?.length ?? 0;

function assertNoRawMediaTag(html: string, seenAudio: number): void {
  const raw =
    mediaTagCount(html, "video") > 0
      ? "video"
      : mediaTagCount(html, "audio") > seenAudio
        ? "audio"
        : null;
  if (!raw) return;
  throw new KonteError(
    "VALIDATION_FAILED",
    `jsxImage emits a raw <${raw}> (via dangerouslySetInnerHTML). konte cannot see it, so it would ` +
      `reach the capture unchecked. Use <Image>.`,
  );
}

// Every `__konte:` the rendered document carries must be one of the refs that will be substituted
// for a file — a ref the graph also ordered and gated. One that neither harvest pass saw reaches the
// browser verbatim and renders as a broken layer, silently, so it fails the load instead. The two
// passes cover a ref reaching a host `src`; what they cannot see is one embedded inside a longer
// string (a CSS `url(...)`), which is what this rejects.
function assertEveryPlaceholderHarvested(html: string, placeholders: readonly string[]): void {
  let stripped = html;
  // Longest first, for the same reason the backend substitutes that way — see `renderStill`.
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
    `jsxImage found an asset reference it cannot resolve into a file — "${leftover}", embedded in ` +
      "a longer string rather than passed as a `src`. Render it with `<Image src={…}>` (or an " +
      "`<img>`), which is what the dependency graph and the file substitution both read.",
  );
}

/** The canvas the build lays out against — the resolved pixel size of the image it returns. */
export type JsxImageCanvas = { width: number; height: number };

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
export const jsxImage: AssetAdapter<JsxImageInputs, "image"> = {
  type: "image",
  meta: {
    backend: "local",
    mediaType: "image",
    description:
      "Chromium render of a JSX tree to a PNG — a title card, a telop plate, or a composited layout fed to a model as one image.",
    ref: "render",
    guide: "konte/guides/jsx-image.md",
    inputs: {
      build: {
        type: "jsx",
        required: false,
        description:
          "`({ width, height }) => JSX` — the document body, laid out against the resolved canvas. Tailwind classes and the direction's `policy.fonts` are available. Omitted, the image is the `background` alone.",
      },
      width: { type: "number", required: false, computed: true },
      height: { type: "number", required: false, computed: true },
      background: {
        type: "string",
        required: false,
        default: "#000000",
        description: '`"transparent"` yields an alpha PNG.',
      },
    },
  },
  createDefinition(inputs: JsxImageInputs): LocalAssetDefinition {
    const format = getActiveFormat();
    const width = inputs.width ?? format?.size.width;
    const height = inputs.height ?? format?.size.height;
    if (width === undefined || height === undefined) {
      throw new KonteError(
        "VALIDATION_FAILED",
        "jsxImage needs a width and height. The stage this is declared in has no canvas to take " +
          "them from, so pass both.",
      );
    }
    const background = inputs.background ?? "#000000";
    // A png capture forces html/body transparent (the engine's own alpha path), so an opaque ground
    // has to be painted inside the stage. As a rule on `#stage` rather than as a full-bleed element:
    // a positioned one paints in a later stage than the build's in-flow boxes and would cover them.
    const backdrop =
      background === "transparent" ? null : (
        <style>{`#stage { background: ${parseColorString(background)}; }`}</style>
      );

    const content = inputs.build?.({ width, height }) ?? null;

    // Both passes, as a composition's own ref harvest does (`partitionShotRefs`): the raw tree walk
    // sees a ref passed as a prop to a user component, and only the render sees one a function
    // component pulls in from a closure — `function Layer() { return <Image src={reference.logo}/> }`
    // has no props at all. Missing one means a broken layer no gate catches.
    const refs = new Set<string>(collectPlaceholderRefs(content).filter(isAssetPath));
    let seenAudio = 0;
    const visitor: HostVisitor = (tag, props) => {
      if (tag === "audio") seenAudio++;
      assertStillTag(tag);
      const src = props.src;
      if (typeof src !== "string") return;
      const parsed = parsePlaceholder(src);
      if (parsed && isAssetPath(parsed)) refs.add(parsed);
    };

    const html = renderToHtml(
      <Composition>
        {backdrop}
        {content}
      </Composition>,
      {
        shotId: STILL_SHOT_ID,
        width,
        height,
        duration: STILL_DURATION,
        still: true,
        typography: getActiveTypography() ?? { lang: "en" },
      },
      visitor,
    );

    assertNoRawMediaTag(html, seenAudio);
    const placeholders = [...refs].map(makeAddressPlaceholder);
    assertEveryPlaceholderHarvested(html, placeholders);

    return {
      kind: "local",
      operation: "render",
      mediaType: "image",
      deterministic: true,
      inputs: {
        html,
        width,
        height,
        // The graph reads a dependency off a whole-string placeholder (graph.ts `collectRefs`), and
        // the ones this asset consumes are buried inside `html` attributes. List them here so the
        // edges are found and the backend is handed the files to substitute in.
        refs: placeholders,
      },
    };
  },
};
