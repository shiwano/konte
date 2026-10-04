import type { ShotStage } from "./address.js";
import { injectBaseTimeline } from "./composition-builder.js";
import { runInRenderMode, type ShotFunction } from "./dsl/shot-context.js";
import { renderToHtml } from "./jsx-html.js";
import type { OverlayDefinition, Typography } from "./types/index.js";

// How the overlay reaches the picture. It is a nested composition — its own `<template>`, its own
// gsap timeline (`shot-overlay`) — so an entrance written on the overlay's clock is sought by
// the runtime at the overlay's own time, whichever shot the frame belongs to. The runtime clamps a
// host's `data-start` at 0, so a host that opened before the composition it sits in starts at 0
// and carries the time it missed as `data-media-start`, which the runtime adds to its timeline's
// clock; the timed elements inside it (a `<Subtitle>` line) are re-based on the host by the
// runtime rather than by the timeline, so their own `data-start` is shifted here instead. The
// capture reads no media inside a nested composition, so an overlay carries none.

// Not a legal shot id (a `.` never is), so it cannot meet a shot's composition.
export const OVERLAY_COMPOSITION_ID = "timeline.overlay";

// The overlay's own composition, bare (no <html>), with a base timeline registered the way a shot's
// is, so the capture's sub-composition handshake resolves for one with no `<Animate>`.
export function renderOverlayBody(opts: {
  stage: ShotStage;
  overlay: OverlayDefinition;
  fn: ShotFunction;
  size: { width: number; height: number };
  typography: Typography;
  resolvedFiles: Record<string, string>;
  absolutePaths?: Record<string, string>;
}): string {
  const id = OVERLAY_COMPOSITION_ID;
  const jsx = runInRenderMode(opts.stage, id, opts.fn, opts.resolvedFiles, opts.absolutePaths);
  const body = renderToHtml(jsx, {
    shotId: id,
    width: opts.size.width,
    height: opts.size.height,
    duration: opts.overlay.duration,
    typography: opts.typography,
    nested: true,
  });
  return injectBaseTimeline(body, id, opts.overlay.duration);
}

// Move every timed element `by` seconds earlier. One that ends before 0 is moved past `windowEnd`,
// where its host never shows it; one that opens before 0 opens at 0 with what is left of it.
export function shiftTimedElements(html: string, by: number, windowEnd: number): string {
  if (by === 0) return html;
  return html.replace(/<([a-z][a-z0-9-]*)\b([^>]*)>/gi, (tag, _name, attrs) => {
    const start = /\sdata-start="([^"]*)"/.exec(attrs as string);
    if (!start) return tag;
    const duration = /\sdata-duration="([^"]*)"/.exec(attrs as string);
    const from = round(Number(start[1]) - by);
    const length = duration ? Number(duration[1]) : Infinity;
    const end = round(from + length);
    let nextStart = from;
    let nextDuration = length;
    if (end <= 0) {
      nextStart = windowEnd + 1;
      nextDuration = 0.001;
    } else if (from < 0) {
      nextStart = 0;
      nextDuration = end;
    }
    let out = tag.replace(/\sdata-start="[^"]*"/, ` data-start="${round(nextStart)}"`);
    if (duration && Number.isFinite(nextDuration)) {
      out = out.replace(/\sdata-duration="[^"]*"/, ` data-duration="${round(nextDuration)}"`);
    }
    return out;
  });
}

function round(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}

// Each shot's start on the whole timeline, where the overlay's clock meets it.
export function overlayShotStarts(
  shots: readonly { id: string; duration: number }[],
): Map<string, number> {
  return new Map(
    shots.map((shot, i) => [shot.id, shots.slice(0, i).reduce((sum, s) => sum + s.duration, 0)]),
  );
}

// Lay the overlay over a standalone composition — one shot's document, `shotStart` into the
// timeline and `shotDuration` long: its host inside `#stage`, above the shot's own layers, carrying
// the overlay's clock from `shotStart`, and its template after it.
export function injectOverlay(
  compositionHtml: string,
  part: { body: string; shotStart: number; shotDuration: number },
): string {
  const id = `shot-${OVERLAY_COMPOSITION_ID}`;
  const mediaStart = part.shotStart > 0 ? ` data-media-start="${round(part.shotStart)}"` : "";
  const hosts = `<div data-composition-id="${id}" data-start="0" data-duration="${round(part.shotDuration)}"${mediaStart} style="position:absolute;top:0;left:0;width:100%;height:100%;"></div>`;
  const templates = `<template id="${id}-template">${shiftTimedElements(part.body, part.shotStart, part.shotDuration)}</template>`;
  const bodyClose = compositionHtml.lastIndexOf("</body>");
  const stageClose = compositionHtml.lastIndexOf("</div>", bodyClose);
  if (bodyClose === -1 || stageClose === -1) return compositionHtml + hosts + templates;
  return (
    compositionHtml.slice(0, stageClose) +
    hosts +
    compositionHtml.slice(stageClose, bodyClose) +
    templates +
    compositionHtml.slice(bodyClose)
  );
}
