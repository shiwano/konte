import { KonteError } from "../../errors.js";
import type { LocalAssetDefinition } from "../../types/index.js";
import type { AssetAdapter } from "../adapter.js";
import { getActiveFormat } from "../shot-context.js";
import { buildJsxStage, type JsxCanvas, resolveJsxCanvas } from "./jsx-document.js";
import type { ColorString } from "./local.js";

export type JsxVideoInputs = {
  /** `(canvas) => JSX` — the document body; an `<Animate>` in it may run its own clock. */
  build: (canvas: JsxCanvas) => React.ReactElement;
  /** Seconds. Defaults to the length of the shot it is declared in; required elsewhere. */
  duration?: number;
  /** Defaults to the canvas the stage resolves for this asset; required where there is none. */
  width?: number;
  height?: number;
  /** Defaults to `#000000`. */
  background?: ColorString;
};

/**
 * Bakes a JSX tree to an MP4 through the same headless Chromium, `<Composition>` head and font stack
 * a shot's composition renders with, one frame after another from t=0. `requestAnimationFrame`,
 * `performance.now`, `Date`, timers and `Math.random` run on the bake's clock, so a game loop or a
 * simulation comes out the same on every bake.
 *
 *   const race = asset("race", adapters.jsxVideo, {
 *     build: ({ width, height }) => (
 *       <>
 *         <canvas id="game" width={width} height={height} />
 *         <Animate data={course} script={({ data }) => { … requestAnimationFrame(loop) … }} />
 *       </>
 *     ),
 *   });
 */
export const jsxVideo: AssetAdapter<JsxVideoInputs, "video"> = {
  type: "video",
  meta: {
    backend: "local",
    mediaType: "video",
    description:
      "Chromium bake of a JSX tree to an MP4 on a frame-stepped clock — a game, a simulation or a canvas drawn by requestAnimationFrame.",
    ref: "render",
    guide: "konte/guides/jsx-video.md",
    inputs: {
      build: {
        type: "jsx",
        required: true,
        description:
          "`({ width, height }) => JSX` — the document body, laid out against the resolved canvas. An `<Animate>` script in it may use requestAnimationFrame and timers.",
      },
      duration: { type: "number", required: false, computed: true },
      width: { type: "number", required: false, computed: true },
      height: { type: "number", required: false, computed: true },
      background: { type: "string", required: false, default: "#000000" },
    },
  },
  createDefinition(inputs: JsxVideoInputs): LocalAssetDefinition {
    const format = getActiveFormat();
    const duration = inputs.duration ?? format?.duration;
    if (duration === undefined || !(duration > 0)) {
      throw new KonteError(
        "VALIDATION_FAILED",
        "jsxVideo needs a positive duration. Declared outside a shot there is no length to take, " +
          "so pass `duration`.",
      );
    }
    const fps = format?.fps;
    if (fps === undefined) {
      throw new KonteError(
        "VALIDATION_FAILED",
        "jsxVideo takes its frame rate from the stage, and this stage has none. Declare it in " +
          "animatic.tsx or video.tsx.",
      );
    }
    const canvas = resolveJsxCanvas("jsxVideo", inputs);
    const document = buildJsxStage({
      adapter: "jsxVideo",
      canvas,
      duration,
      content: inputs.build(canvas),
      background: inputs.background ?? "#000000",
    });

    return {
      kind: "local",
      operation: "render",
      mediaType: "video",
      deterministic: true,
      inputs: { ...document, fps },
    };
  },
};
