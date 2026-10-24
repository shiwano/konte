import * as path from "node:path";
import { injectBaseTimeline } from "./composition-builder.js";
import {
  JSX_VIDEO_SHOT_ID,
  type JsxDocumentInputs,
  type JsxRenderAdapter,
  jsxDocumentHtml,
} from "./dsl/adapters/jsx-document.js";
import { parsePlaceholder } from "./dsl/shot-context.js";
import { compositeWithHyperFrames, ensureHyperFrames } from "./hyperframes.js";
import { captureHtmlToImage } from "./still-capture.js";
import type { Typography } from "./types/definition.js";

/** The inputs a `jsxImage` definition carries (see `dsl/adapters/jsx-image.tsx`). */
export interface JsxStillInputs extends JsxDocumentInputs {
  refs?: readonly string[];
}

/** The inputs a `jsxVideo` definition carries (see `dsl/adapters/jsx-video.tsx`). */
export interface JsxClipInputs extends JsxStillInputs {
  duration: number;
  fps: number;
}

export function asJsxStillInputs(inputs: Record<string, unknown>): JsxStillInputs {
  return {
    stage: inputs.stage as string,
    width: inputs.width as number,
    height: inputs.height as number,
    typography: inputs.typography as Typography,
    refs: (inputs.refs ?? []) as readonly string[],
  };
}

export function asJsxClipInputs(inputs: Record<string, unknown>): JsxClipInputs {
  return {
    ...asJsxStillInputs(inputs),
    duration: inputs.duration as number,
    fps: inputs.fps as number,
  };
}

// Intrinsically sized so a tree that lets the image size itself still lays out; a tree that sizes
// the box gets the tile scaled into it.
const TILE = { width: 640, height: 360 };

const escapeXml = (text: string): string =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// Base64 rather than a percent-encoded body: the placeholder is substituted into an HTML attribute
// whose quoting this must not depend on.
function placeholderTile(address: string): string {
  const { width, height } = TILE;
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">` +
    `<rect width="${width}" height="${height}" fill="#26262b"/>` +
    `<rect x="10" y="10" width="${width - 20}" height="${height - 20}" fill="none" stroke="#6b6b78" stroke-width="4" stroke-dasharray="18 12"/>` +
    `<text x="${width / 2}" y="${height / 2 - 14}" fill="#8f8f9c" font-family="monospace" font-size="24" text-anchor="middle">unresolved</text>` +
    `<text x="${width / 2}" y="${height / 2 + 26}" fill="#e4e4ee" font-family="monospace" font-size="22" text-anchor="middle">${escapeXml(address)}</text>` +
    `</svg>`;
  return `data:image/svg+xml;base64,${Buffer.from(svg, "utf-8").toString("base64")}`;
}

type ResolveRef = (placeholder: string) => Promise<string | null>;

/**
 * The refs a `jsxImage` / `jsxVideo` consumes are buried inside its HTML, so each one's placeholder
 * is rewritten to a workspace-relative name and the file linked in under it. Names are indexed
 * rather than derived from the address: an address carries `:` and `.`, which a URL path segment
 * and the file server's own lookup would each read their own way.
 *
 * Longest placeholder first. An asset name may contain underscores, so one placeholder can be a
 * PREFIX of another (`__konte:video:shot.01.a__` of `__konte:video:shot.01.a__b__`) — replacing the
 * short one first would eat the long one's opening and strand the rest as literal text. A prefix is
 * the only overlap possible: `__konte:` contains a `:`, which no asset name may.
 *
 * `resolveRef` returns the absolute file behind a placeholder, or `null` to stand a labelled tile in
 * for it. Generation never passes `null`; the tile is a read surface's affordance only.
 */
async function substituteRefs(
  adapter: JsxRenderAdapter,
  inputs: JsxStillInputs,
  resolveRef: ResolveRef,
): Promise<{ html: string; assetFiles: Record<string, string>; unresolved: string[] }> {
  let html = jsxDocumentHtml(adapter, inputs);
  const assetFiles: Record<string, string> = {};
  const unresolved: string[] = [];
  const refs = [...(inputs.refs ?? [])]
    .filter((placeholder) => parsePlaceholder(placeholder) !== null)
    .sort((a, b) => b.length - a.length);

  for (const [index, placeholder] of refs.entries()) {
    const file = await resolveRef(placeholder);
    if (file === null) {
      const address = parsePlaceholder(placeholder)!;
      unresolved.push(address);
      html = html.split(placeholder).join(placeholderTile(address));
      continue;
    }
    const name = `asset-${index}${path.extname(file)}`;
    assetFiles[name] = file;
    html = html.split(placeholder).join(name);
  }
  return { html, assetFiles, unresolved };
}

/** Render a `jsxImage` definition's HTML to a PNG. */
export async function renderJsxStill(opts: {
  inputs: JsxStillInputs;
  outputFile: string;
  videoRoot: string;
  resolveRef: ResolveRef;
}): Promise<{ unresolved: string[] }> {
  const { html, assetFiles, unresolved } = await substituteRefs(
    "jsxImage",
    opts.inputs,
    opts.resolveRef,
  );

  await captureHtmlToImage({
    html,
    assetFiles,
    outputFile: opts.outputFile,
    videoRoot: opts.videoRoot,
    size: { width: opts.inputs.width, height: opts.inputs.height },
    format: "png",
  });

  return { unresolved };
}

// Run first in <body>, after the engine's own pre-head clock (`__HF_VIRTUAL_TIME__`), which steps
// requestAnimationFrame, performance.now and Date. This adds what it leaves on the wall clock:
// timers fire on the stepped clock before each frame's animation callbacks, and Math.random /
// crypto.getRandomValues draw from a fixed seed. Inside a timer callback performance.now and Date
// read its due time, and a timer it sets counts from there, at least 1ms on, so a chain
// that re-arms itself reaches the frame.
export const JSX_VIDEO_CLOCK_SCRIPT = `<script>(function () {
  var seed = 0x6b6f6e74;
  var random = function () {
    seed = (seed + 0x6d2b79f5) | 0;
    var t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  Math.random = random;
  if (window.crypto) {
    window.crypto.getRandomValues = function (array) {
      var bytes = new Uint8Array(array.buffer, array.byteOffset, array.byteLength);
      for (var i = 0; i < bytes.length; i++) bytes[i] = (random() * 256) | 0;
      return array;
    };
  }
  var clock = window.__HF_VIRTUAL_TIME__;
  if (!clock) return;
  var timers = [];
  var nextId = 1;
  var firingAt = null;
  var now = function () { return firingAt === null ? clock.getTime() : firingAt; };
  try {
    Object.defineProperty(window.performance, "now", { configurable: true, value: now });
  } catch (err) {}
  var FrameDate = window.Date;
  var TimerDate = function () {
    var args = Array.prototype.slice.call(arguments);
    if (!(this instanceof TimerDate)) return new FrameDate(now()).toString();
    return args.length
      ? new (Function.prototype.bind.apply(FrameDate, [null].concat(args)))()
      : new FrameDate(now());
  };
  TimerDate.prototype = FrameDate.prototype;
  Object.setPrototypeOf(TimerDate, FrameDate);
  TimerDate.now = now;
  window.Date = TimerDate;
  var schedule = function (fn, ms, args, repeat) {
    var delay = Math.max(firingAt === null ? 0 : 1, Number(ms) || 0);
    timers.push({ id: nextId, at: now() + delay, every: repeat ? Math.max(1, delay) : 0, fn: fn, args: args });
    return nextId++;
  };
  var cancel = function (id) {
    timers = timers.filter(function (timer) { return timer.id !== id; });
  };
  window.setTimeout = function (fn, ms) { return schedule(fn, ms, Array.prototype.slice.call(arguments, 2), false); };
  window.setInterval = function (fn, ms) { return schedule(fn, ms, Array.prototype.slice.call(arguments, 2), true); };
  window.clearTimeout = cancel;
  window.clearInterval = cancel;
  var seek = clock.seekToTime;
  clock.seekToTime = function (ms) {
    for (;;) {
      var due = null;
      for (var i = 0; i < timers.length; i++) {
        if (timers[i].at <= ms && (!due || timers[i].at < due.at)) due = timers[i];
      }
      if (!due) break;
      firingAt = due.at;
      if (due.every) due.at += due.every; else cancel(due.id);
      if (typeof due.fn === "function") {
        try { due.fn.apply(window, due.args); } catch (err) { console.error(err); }
      }
    }
    firingAt = null;
    return seek(ms);
  };
})();</script>`;

const BODY_OPEN = /<body\b[^>]*>/i;

/**
 * Bake a `jsxVideo` definition's HTML to an MP4 on one capture worker, so the frames are taken in
 * order from t=0 and a loop's state carries from each frame to the next.
 */
export async function renderJsxVideo(opts: {
  inputs: JsxClipInputs;
  outputFile: string;
  videoRoot: string;
  resolveRef: ResolveRef;
  onLog?: (line: string) => void;
}): Promise<{ unresolved: string[]; warnings: string[] }> {
  const { inputs } = opts;
  await ensureHyperFrames();
  const { html, assetFiles, unresolved } = await substituteRefs(
    "jsxVideo",
    inputs,
    opts.resolveRef,
  );
  const clocked = html.replace(BODY_OPEN, (open) => `${open}${JSX_VIDEO_CLOCK_SCRIPT}`);

  const warnings = await compositeWithHyperFrames({
    compositionHtml: injectBaseTimeline(clocked, JSX_VIDEO_SHOT_ID, inputs.duration),
    assetFiles,
    outputFile: opts.outputFile,
    videoRoot: opts.videoRoot,
    fps: inputs.fps,
    size: { width: inputs.width, height: inputs.height },
    duration: inputs.duration,
    quality: "high",
    workers: 1,
    screenshotCapture: true,
    ...(opts.onLog && { onLog: opts.onLog }),
  });

  return { unresolved, warnings };
}
