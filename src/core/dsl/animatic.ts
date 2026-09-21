import { harvestAudioStructure } from "../composition-builder.js";
import { isAssetPath } from "../composition-refs.js";
import { KonteError } from "../errors.js";
import { type RenderContext, renderToHtml } from "../jsx-html.js";
import type { PanelDefinition } from "../types/index.js";
import { beginPanelCollection, endPanelCollection, type PanelOccurrence } from "./panel-collect.js";

// What konte derives from one animatic shot's composition: the keyframes it declared. The shot's
// mixed-down `#stem` — an audio-driven motion model's input — and its `#narrationStem` are leaves
// materialized from the same cues on accept (`materializeShotStem`); discovery only checks that each
// cue can be mixed.

export interface AnimaticShotDiscovery {
  panels: PanelDefinition[];
  // The keyframes inside the shot's `<Cutin>`, windowed on the shot's clock the same way.
  cutinPanels: PanelDefinition[];
}

// What an animatic may render. `<Video>` is not allowed: an animatic with a surface to draw video on
// is an animatic that can hold the motion generation itself, which is exactly how a shot would route
// around the spend gate its accept opens. `<Panel>` / `<Image>` / `<Audio>` / `<Animate>` and plain
// HTML are all fine.
//
// Checked on the RENDERED HTML, not only the host tags: `dangerouslySetInnerHTML` never reaches a
// host visitor, and placeholders inside raw HTML are substituted at render like any other src — so a
// tag-only check leaves the surface reachable. Text children are escaped, so a literal "<video" in a
// subtitle cannot false-positive.
//
// Raw `<audio>` is refused for a different reason: konte cannot see it either, so it would play in
// the review and be missing from the stem the motion model consumes — the animatic would be judged
// on audio the motion never hears. Both must come from a component.
//
// A media tag konte can see is one the visitor was called for. Anything in the HTML beyond that
// count was injected as raw markup, so comparing the two is what separates the legitimate `<Audio>`
// (a host node) from the same tag smuggled past every check.
const mediaTagCount = (html: string, tag: "video" | "audio"): number =>
  html.match(new RegExp(`<${tag}[\\s/>]`, "gi"))?.length ?? 0;

/**
 * Render one animatic shot's composition once: banning `<Video>`, collecting its `<Panel>`s in
 * document order, and harvesting its audio cues. `element` is the shot's discovery-mode render
 * (every `src` still a placeholder), already checked to be a `<Composition>` by the caller.
 */
export function readAnimaticShot(opts: {
  shotId: string;
  element: React.ReactElement;
  context: RenderContext;
  // Per lane, the shot that runs on from this one in one take (`DirectionIndex.continuedById`).
  // That lane's last panel is then no landing frame.
  continuedBy?: { main?: string; cutin?: string };
}): AnimaticShotDiscovery {
  const { shotId, element, context, continuedBy } = opts;
  let seenAudio = 0;
  beginPanelCollection();
  let occurrences: PanelOccurrence[];
  let html: string;
  try {
    html = renderToHtml(element, context, (tag) => {
      if (tag === "audio") seenAudio++;
      if (tag !== "video") return;
      throw new KonteError(
        "ANIMATIC_INVALID",
        `Animatic shot "${shotId}" renders a <video>. The animatic holds the keyframes and the ` +
          `audio that drives the motion; the motion itself belongs in video.tsx, behind the accept ` +
          `this board gates. Use <Panel> for a keyframe.`,
      );
    });
  } finally {
    occurrences = endPanelCollection();
  }
  // The visitor threw on any <video> it saw, so one still in the HTML came from raw markup.
  const rawTag =
    mediaTagCount(html, "video") > 0
      ? "video"
      : mediaTagCount(html, "audio") > seenAudio
        ? "audio"
        : null;
  if (rawTag) {
    throw new KonteError(
      "ANIMATIC_INVALID",
      `Animatic shot "${shotId}" emits a raw <${rawTag}> (via dangerouslySetInnerHTML). konte ` +
        `cannot see it, so a <video> would sidestep the spend gate and an <audio> would play in ` +
        `review while being absent from the stem that drives the motion. Use <Panel> / <Audio>.`,
    );
  }
  assertCuesMixable(shotId, harvestAudioStructure(element, context));

  const lane = (name: PanelOccurrence["lane"]) => occurrences.filter((o) => o.lane === name);
  const panels = resolvePanelWindows(
    shotId,
    lane("main"),
    context.duration,
    continuedBy?.main !== undefined,
  );
  const cutinPanels = resolvePanelWindows(
    shotId,
    lane("cutin"),
    context.duration,
    continuedBy?.cutin !== undefined,
  );
  // The part name is the shot's, whichever frame the keyframe keys: `animatic.shot(id).image(name)`
  // takes no lane.
  for (const cutin of cutinPanels) {
    const main = panels.find((p) => p.assetName === cutin.assetName);
    if (main && main.assetPath !== cutin.assetPath) {
      throw new KonteError(
        "ANIMATIC_INVALID",
        `Animatic shot "${shotId}" has two panels named "${cutin.assetName}" from different assets ` +
          `("${main.assetPath}" vs "${cutin.assetPath}"), one of them in its <Cutin>. Give one a ` +
          `distinct asset name.`,
      );
    }
  }
  return { panels, cutinPanels };
}

// A declared `start` PINS its keyframe; each run of undeclared panels shares the gap between the
// pins bracketing it (the shot's start and end standing in at the ends), the pinned panel opening a
// gap holding its first slot. `[—, 5, —]` over a 6s shot is `[0, 5, 5.5]`; with nothing pinned it
// is the even whole-shot division.
function resolvePanelStarts(occurrences: readonly PanelOccurrence[], duration: number): number[] {
  const total = occurrences.length;
  const starts = new Array<number>(total);
  let i = 0;
  while (i < total) {
    const declared = occurrences[i]!.start;
    if (declared !== null) {
      starts[i] = declared;
      i++;
      continue;
    }
    let end = i;
    while (end < total && occurrences[end]!.start === null) end++;
    const lower = i === 0 ? 0 : starts[i - 1]!;
    const upper = end < total ? occurrences[end]!.start! : duration;
    // The pinned panel opening this gap already occupies its first slot; at the head of the shot
    // there is none, so the run starts on the shot.
    const offset = i === 0 ? 0 : 1;
    const step = (upper - lower) / (end - i + offset);
    for (let k = i; k < end; k++) starts[k] = lower + step * (k - i + offset);
    i = end;
  }
  return starts;
}

// The keyframes' slots on the shot's clock. Each holds until the next one starts — the last to the
// shot's end — and then cuts. `continued` is whether the next shot runs on from this lane in one
// take, which makes the last panel no landing frame.
function resolvePanelWindows(
  shotId: string,
  occurrences: readonly PanelOccurrence[],
  duration: number,
  continued: boolean,
): PanelDefinition[] {
  const total = occurrences.length;
  // Checked before the undeclared ones are derived, so a pair of pins in the wrong order is
  // reported as the author wrote it.
  let lastPin: { index: number; start: number } | null = null;
  for (const [i, o] of occurrences.entries()) {
    if (o.start === null) continue;
    if (lastPin && o.start <= lastPin.start) {
      throw new KonteError(
        "ANIMATIC_INVALID",
        `Animatic shot "${shotId}" panel "${o.assetName}" starts at ${o.start}s, not after ` +
          `"${occurrences[lastPin.index]!.assetName}" (${lastPin.start}s). Panels cut in document ` +
          `order, so their starts must increase.`,
      );
    }
    lastPin = { index: i, start: o.start };
  }
  const starts = resolvePanelStarts(occurrences, duration);
  for (const [i, start] of starts.entries()) {
    if (!(start >= 0 && start < duration)) {
      throw new KonteError(
        "ANIMATIC_INVALID",
        `Animatic shot "${shotId}" panel "${occurrences[i]!.assetName}" starts at ${start}s, ` +
          `outside the shot (0 ≤ start < ${duration}).`,
      );
    }
    if (i > 0 && start <= starts[i - 1]!) {
      throw new KonteError(
        "ANIMATIC_INVALID",
        `Animatic shot "${shotId}" panel "${occurrences[i]!.assetName}" starts at ${start}s, ` +
          `not after "${occurrences[i - 1]!.assetName}" (${starts[i - 1]}s). Panels cut in ` +
          `document order, so their starts must increase.`,
      );
    }
  }
  const byName = new Map<string, string>();
  return occurrences.map((o, i) => {
    // Two panels in one shot claiming the same part name from different assets would make
    // `animatic.shot(id).image(name)` ambiguous, so reject at load.
    const existing = byName.get(o.assetName);
    if (existing !== undefined && existing !== o.assetPath) {
      throw new KonteError(
        "ANIMATIC_INVALID",
        `Animatic shot "${shotId}" has two panels named "${o.assetName}" from different assets ` +
          `("${existing}" vs "${o.assetPath}"). Give one a distinct asset name.`,
      );
    }
    byName.set(o.assetName, o.assetPath);
    assertPanelMoves(shotId, i, total, o, continued);
    return {
      assetName: o.assetName,
      assetPath: o.assetPath,
      start: starts[i]!,
      duration: (starts[i + 1] ?? duration) - starts[i]!,
      ...(o.blocking !== undefined ? { blocking: o.blocking } : {}),
      ...(o.camera !== undefined ? { camera: o.camera } : {}),
    };
  });
}

// `blocking`/`camera` describe the span STARTING at their panel, so whether a panel can carry them
// at all is fixed by document position. Nothing moves out of the landing frame, so the last panel of
// a multi-panel shot can never declare either — unless the next shot runs on from this frame in one
// take (`continued`). Declaring them is otherwise optional here: they are written from the chosen take, and required
// only at the review gates (REVIEW_PREREQUISITE_MISSING).
function assertPanelMoves(
  shotId: string,
  index: number,
  total: number,
  panel: { assetName: string; blocking?: string; camera?: string },
  continued: boolean,
): void {
  if (total <= 1 || index !== total - 1 || continued) return;
  const declared = [
    panel.blocking !== undefined ? "blocking" : null,
    panel.camera !== undefined ? "camera" : null,
  ].filter((n) => n !== null);
  if (declared.length > 0) {
    throw new KonteError(
      "ANIMATIC_INVALID",
      `Panel "${panel.assetName}" of animatic shot "${shotId}" is the shot's landing keyframe, so ` +
        `nothing moves out of it, but it declares ${declared.join(" and ")}. Move it to the panel ` +
        `the movement starts from.`,
    );
  }
}

// The shot's audio is mixed down — the `audio` input of an audio-driven motion model, and what the
// video stage reaches through `animatic.shot("01").stem` / `.narrationStem`. `harvestAudioStructure`
// yields a decoded asset path when the src was a placeholder and the raw string otherwise. Only the
// first can be mixed: the stem is what an audio-driven model consumes, so a source konte cannot
// resolve has no place in it.
function assertCuesMixable(shotId: string, entries: ReadonlyArray<{ src: string }>): void {
  for (const e of entries) {
    if (isAssetPath(e.src)) continue;
    throw new KonteError(
      "ANIMATIC_INVALID",
      `Animatic shot "${shotId}" plays "${e.src}", which is not a konte asset. The stem that ` +
        `drives the motion is mixed from the shot's cues, so each must be an asset() take or a ` +
        `shared reference — not a literal path or URL.`,
    );
  }
}
