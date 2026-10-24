import type { LocalAssetDefinition } from "../../types/index.js";
import type { AssetAdapter } from "../adapter.js";
import { buildJsxStage, type JsxCanvas, resolveJsxCanvas } from "./jsx-document.js";
import type { ColorString } from "./local.js";

/** The canvas the build lays out against — the resolved pixel size of the image it returns. */
export type JsxImageCanvas = JsxCanvas;

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
    const canvas = resolveJsxCanvas("jsxImage", inputs);
    // The graph reads a dependency off a whole-string placeholder (graph.ts `collectRefs`), and the
    // ones this asset consumes are buried inside `stage` attributes. `refs` lists them so the edges
    // are found and the backend is handed the files to substitute in.
    const document = buildJsxStage({
      adapter: "jsxImage",
      canvas,
      content: inputs.build?.(canvas) ?? null,
      background: inputs.background ?? "#000000",
    });

    return {
      kind: "local",
      operation: "render",
      mediaType: "image",
      deterministic: true,
      inputs: { ...document },
    };
  },
};
