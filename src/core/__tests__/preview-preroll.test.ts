import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  applyVideoPreroll,
  injectPrerollWarmup,
  planVideoPreroll,
  PREROLL_ASSET_BASE,
  PREROLL_TAIL_SEC,
} from "../preview-preroll.js";
import { StateManager } from "../state/index.js";
import type { VariantMedia } from "../types/index.js";

const ASSET_BASE = "/api/assets";
const HASH = "abcdef0123456789cafe";
const STAMP = HASH.slice(0, 16);

let tmpDir: string;
let manager: StateManager;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "konte-preroll-test-"));
  manager = await StateManager.init(tmpDir);
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

function setupTake(
  address: string,
  file: string,
  media: VariantMedia | null,
  outputHash: string | null = HASH,
): string {
  const variantId = manager.reserveVariantId(address);
  const variant = manager.getAssetState(address).variants![variantId]!;
  variant.file = file;
  variant.outputHash = outputHash;
  if (media) variant.media = media;
  return variantId;
}

const videoMedia = (fps: number, durationSec = 5): VariantMedia => ({
  kind: "video",
  width: 1920,
  height: 480,
  fps,
  durationSec,
  audio: null,
});

function videoTag(src: string, start: number, duration: number, extra = ""): string {
  return `<video src="${src}"${extra} muted playsinline data-start="${start}" data-duration="${duration}" data-has-audio="true">`;
}

function assetUrl(address: string, variantId: string, filename = "a.mp4"): string {
  return `${ASSET_BASE}/${address.replace(":", "/")}/${variantId}/${filename}`;
}

/** A reel the way `buildFullCompositionHtml` lays one out: a host per shot, a template per shot. */
function reel(shots: Array<{ id: string; start: number; duration: number; body: string }>): string {
  const hosts = shots
    .map(
      (s) =>
        `<div data-composition-id="shot-${s.id}" data-start="${s.start}" data-duration="${s.duration}" data-width="1920" data-height="480"></div>`,
    )
    .join("");
  const templates = shots
    .map((s) => `<template id="shot-${s.id}-template">${s.body}</template>`)
    .join("");
  return `<div id="stage">${hosts}</div>${templates}`;
}

describe("planVideoPreroll", () => {
  it("frame-aligns the lead to the take's fps and keys the copy on the take's bytes", () => {
    const v = setupTake("video:shot.02.motion", "assets/a.mp4", videoMedia(24));
    const html = reel([
      {
        id: "02",
        start: 1.5,
        duration: 4.5,
        body: videoTag(assetUrl("video:shot.02.motion", v), 1.5, 4.5),
      },
    ]);

    const [clip] = planVideoPreroll(html, ASSET_BASE, manager);

    // 0.4s at 24fps is 9.6 frames; a fractional lead would land the cut inside a padding frame.
    expect(clip!.leadSec).toBeCloseTo(10 / 24, 10);
    expect(clip!.cachePath).toBe(`${v}/${STAMP}-0s417p5417w.mp4`);
    expect(clip!.seekSec).toBe(0);
    expect(clip!.padSec).toBeCloseTo(10 / 24, 10);
    expect(clip!.mediaStartAfter).toBe(0);
    expect(clip!.sourceFile).toBe(path.resolve(tmpDir, "assets/a.mp4"));
  });

  it("skips a clip that starts partway through its shot", () => {
    // Its host is already on screen through the run-up, so the shift would reveal it early.
    const v = setupTake("video:shot.02.motion", "assets/a.mp4", videoMedia(24));
    const html = reel([
      {
        id: "02",
        start: 1.5,
        duration: 4.5,
        body: videoTag(assetUrl("video:shot.02.motion", v), 3.5, 2.5),
      },
    ]);

    expect(planVideoPreroll(html, ASSET_BASE, manager)).toEqual([]);
  });

  it("skips a clip that borrows another shot's start", () => {
    const v = setupTake("video:shot.02.motion", "assets/a.mp4", videoMedia(24));
    const html = reel([
      // Shot 02's second clip happens to land exactly where shot 03 begins.
      {
        id: "02",
        start: 1.5,
        duration: 4.5,
        body: videoTag(assetUrl("video:shot.02.motion", v), 6, 1),
      },
      { id: "03", start: 6, duration: 1.5, body: "" },
    ]);

    expect(planVideoPreroll(html, ASSET_BASE, manager)).toEqual([]);
  });

  it("skips a looping clip", () => {
    // The browser loops the padded source, so the run-up would replay as a held frame each cycle.
    const v = setupTake("video:shot.02.motion", "assets/a.mp4", videoMedia(24));
    const html = reel([
      {
        id: "02",
        start: 1.5,
        duration: 4.5,
        body: videoTag(assetUrl("video:shot.02.motion", v), 1.5, 4.5, " loop"),
      },
    ]);

    expect(planVideoPreroll(html, ASSET_BASE, manager)).toEqual([]);
  });

  it("skips a clip played at a rate other than 1", () => {
    // The runtime scales the position by the rate, so the shift and the padding would scale too.
    const v = setupTake("video:shot.02.motion", "assets/a.mp4", videoMedia(24));
    const html = reel([
      {
        id: "02",
        start: 1.5,
        duration: 4.5,
        body: videoTag(assetUrl("video:shot.02.motion", v), 1.5, 4.5).replace(
          ">",
          ' data-playback-rate="2">',
        ),
      },
    ]);

    expect(planVideoPreroll(html, ASSET_BASE, manager)).toEqual([]);
  });

  it("skips a clip with no room before it for the run-up", () => {
    const v = setupTake("video:shot.01.motion", "assets/a.mp4", videoMedia(24));
    const html = reel([
      {
        id: "01",
        start: 0,
        duration: 1.5,
        body: videoTag(assetUrl("video:shot.01.motion", v), 0, 1.5),
      },
    ]);

    expect(planVideoPreroll(html, ASSET_BASE, manager)).toEqual([]);
  });

  it("skips a take whose fps was never measured", () => {
    const v = setupTake("video:shot.02.motion", "assets/a.mp4", null);
    const html = reel([
      {
        id: "02",
        start: 1.5,
        duration: 4.5,
        body: videoTag(assetUrl("video:shot.02.motion", v), 1.5, 4.5),
      },
    ]);

    expect(planVideoPreroll(html, ASSET_BASE, manager)).toEqual([]);
  });

  it("skips a take whose bytes are unidentified", () => {
    // A `file` take keeps its id when its bytes are swapped, so an unhashed one cannot key a copy.
    const v = setupTake("video:shot.02.motion", "assets/a.mp4", videoMedia(24), null);
    const html = reel([
      {
        id: "02",
        start: 1.5,
        duration: 4.5,
        body: videoTag(assetUrl("video:shot.02.motion", v), 1.5, 4.5),
      },
    ]);

    expect(planVideoPreroll(html, ASSET_BASE, manager)).toEqual([]);
  });

  it("ignores a src that is not a served take", () => {
    const html = reel([
      {
        id: "02",
        start: 1.5,
        duration: 4.5,
        body: videoTag("__konte:video:shot.02.motion__", 1.5, 4.5),
      },
    ]);

    expect(planVideoPreroll(html, ASSET_BASE, manager)).toEqual([]);
  });

  it("needs no copy when the take carries a lead-in before the in-point and a tail after", () => {
    // A clip cut out of the middle of a long source runs up through its own frames.
    const v = setupTake("video:shot.02.motion", "assets/long.mp4", videoMedia(24, 7200));
    const body = videoTag(assetUrl("video:shot.02.motion", v), 1.5, 3).replace(
      ">",
      ' data-media-start="3600">',
    );
    const html = reel([{ id: "02", start: 1.5, duration: 3, body }]);

    const [clip] = planVideoPreroll(html, ASSET_BASE, manager);

    expect(clip!.cachePath).toBeNull();
    expect(clip!.padSec).toBe(0);
    expect(clip!.mediaStartAfter).toBeCloseTo(3600 - 10 / 24, 10);
  });

  it("bounds a copy to the window the clip plays plus a tail, not the whole source", () => {
    const v = setupTake("video:shot.02.motion", "assets/long.mp4", videoMedia(24, 7200));
    const body = videoTag(assetUrl("video:shot.02.motion", v), 1.5, 3).replace(
      ">",
      ' data-media-start="0.1">',
    );
    const html = reel([{ id: "02", start: 1.5, duration: 3, body }]);

    const [clip] = planVideoPreroll(html, ASSET_BASE, manager);

    // The tail keeps EOF clear of the window's end: an ended clip inside its window is replayed.
    expect(clip!.copyLimitSec).toBeCloseTo(10 / 24 + 3 + PREROLL_TAIL_SEC, 10);
    expect(clip!.padSec).toBeCloseTo(10 / 24 - 0.1, 10);
    expect(clip!.seekSec).toBe(0);
  });

  it("copies a mid-take clip whose take runs out within a tail of its window", () => {
    // The take has the run-up to spare but not the tail, so the copy starts a lead before the
    // in-point and clones the last frame past the source's end.
    const v = setupTake("video:shot.02.motion", "assets/a.mp4", videoMedia(24, 5));
    const body = videoTag(assetUrl("video:shot.02.motion", v), 1.5, 4).replace(
      ">",
      ' data-media-start="1">',
    );
    const html = reel([{ id: "02", start: 1.5, duration: 4, body }]);

    const [clip] = planVideoPreroll(html, ASSET_BASE, manager);

    expect(clip!.padSec).toBe(0);
    expect(clip!.seekSec).toBeCloseTo(1 - 10 / 24, 10);
    expect(clip!.mediaStartAfter).toBe(0);
    expect(clip!.copyLimitSec).toBeCloseTo(10 / 24 + 4 + PREROLL_TAIL_SEC, 10);
    expect(clip!.cachePath).toBe(`${v}/${STAMP}-583s0p4917w.mp4`);
  });

  it("plans one entry per placement, and lets identical ones share a copy", () => {
    const v = setupTake("video:shot.02.motion", "assets/a.mp4", videoMedia(24));
    const src = assetUrl("video:shot.02.motion", v);
    const html = reel([
      { id: "02", start: 1.5, duration: 2, body: videoTag(src, 1.5, 2) },
      { id: "03", start: 6, duration: 2, body: videoTag(src, 6, 2) },
    ]);

    const plans = planVideoPreroll(html, ASSET_BASE, manager);

    expect(plans).toHaveLength(2);
    expect(plans[0]!.tagIndex).not.toBe(plans[1]!.tagIndex);
    // Same take, same window: one file on disk serves both.
    expect(plans[0]!.cachePath).toBe(plans[1]!.cachePath);
  });
});

describe("applyVideoPreroll", () => {
  // Plans come from `planVideoPreroll` against the same HTML, the way the server pairs them.
  const planned = (html: string): ReturnType<typeof planVideoPreroll> =>
    planVideoPreroll(html, ASSET_BASE, manager);

  let src: string;
  let vid: string;
  beforeEach(() => {
    vid = setupTake("video:shot.02.motion", "assets/a.mp4", videoMedia(24));
    src = assetUrl("video:shot.02.motion", vid);
  });

  it("opens the clip's window early and points it at the padded copy", () => {
    const html = reel([{ id: "02", start: 1.5, duration: 4.5, body: videoTag(src, 1.5, 4.5) }]);

    const out = applyVideoPreroll(html, planned(html));

    expect(out).toContain(`src="${PREROLL_ASSET_BASE}/`);
    expect(out).toContain(`data-start="${1.5 - 10 / 24}"`);
    expect(out).toContain(`data-duration="${4.5 + 10 / 24}"`);
    // The window still ends where the shot does — the shift is entirely in front of the cut.
    expect(1.5 - 10 / 24 + (4.5 + 10 / 24)).toBeCloseTo(6, 10);
  });

  it("leaves the shot host's own window alone", () => {
    const html = reel([{ id: "02", start: 1.5, duration: 4.5, body: videoTag(src, 1.5, 4.5) }]);

    expect(applyVideoPreroll(html, planned(html))).toContain(
      '<div data-composition-id="shot-02" data-start="1.5" data-duration="4.5"',
    );
  });

  it("zeroes data-media-start when the run-up is padded on", () => {
    // The copy begins at the clip's own in-point, so the offset it had is baked into the padding.
    const body = videoTag(src, 1.5, 4.5).replace(">", ' data-media-start="0.1">');
    const html = reel([{ id: "02", start: 1.5, duration: 4.5, body }]);

    expect(applyVideoPreroll(html, planned(html))).toContain('data-media-start="0"');
  });

  it("moves the offset back instead of swapping the src when no copy was needed", () => {
    manager.getAssetState("video:shot.02.motion").variants![vid]!.media = videoMedia(24, 7200);
    const body = videoTag(src, 1.5, 3).replace(">", ' data-media-start="3600">');
    const html = reel([{ id: "02", start: 1.5, duration: 3, body }]);

    const out = applyVideoPreroll(html, planned(html));

    expect(out).toContain(`src="${src}"`);
    expect(out).not.toContain(PREROLL_ASSET_BASE);
    expect(out).toContain(`data-media-start="${3600 - 10 / 24}"`);
    expect(out).toContain(`data-start="${1.5 - 10 / 24}"`);
  });

  it("gives each placement of one take its own offset and copy", () => {
    // The same take opening two shots at different in-points must not share one plan.
    manager.getAssetState("video:shot.02.motion").variants![vid]!.media = videoMedia(24, 7200);
    const html = reel([
      {
        id: "02",
        start: 1.5,
        duration: 3,
        body: videoTag(src, 1.5, 3).replace(">", ' data-media-start="3600">'),
      },
      { id: "03", start: 6, duration: 2, body: videoTag(src, 6, 2) },
    ]);

    const plans = planned(html);
    expect(plans).toHaveLength(2);
    expect(plans.map((p) => p.cachePath)).toEqual([null, expect.stringContaining("0s417p2917w")]);

    const out = applyVideoPreroll(html, plans);
    expect(out).toContain(`data-media-start="${3600 - 10 / 24}"`);
    expect(out).toContain(`src="${PREROLL_ASSET_BASE}/`);
    expect(out).toContain('data-media-start="0"');
  });

  it("shifts the take where it opens a shot and not where it does not", () => {
    const html = reel([
      { id: "02", start: 1.5, duration: 4.5, body: videoTag(src, 1.5, 4.5) },
      { id: "03", start: 6, duration: 3, body: videoTag(src, 7, 2) },
    ]);

    const out = applyVideoPreroll(html, planned(html));

    expect(out).toContain(`src="${PREROLL_ASSET_BASE}/`);
    // The mid-shot use keeps the original take and its own window.
    expect(out).toContain(videoTag(src, 7, 2));
  });

  it("leaves the mirrored <audio> on the untouched take", () => {
    const html =
      reel([{ id: "02", start: 1.5, duration: 4.5, body: videoTag(src, 1.5, 4.5) }]) +
      `<audio data-konte-track="embedded" src="${src}" data-start="1.5" data-duration="4.5"></audio>`;

    const out = applyVideoPreroll(html, planned(html));

    expect(out).toContain(`<audio data-konte-track="embedded" src="${src}"`);
  });

  it("is a no-op when nothing is ready", () => {
    const html = reel([{ id: "02", start: 1.5, duration: 4.5, body: videoTag(src, 1.5, 4.5) }]);

    expect(applyVideoPreroll(html, [])).toBe(html);
  });
});

describe("injectPrerollWarmup", () => {
  it("adds the warm-up before </body>", () => {
    const html = `<html><body>${reel([])}</body></html>`;

    const out = injectPrerollWarmup(html);

    expect(out).toMatch(/<script>[^]*video\[data-start\][^]*<\/script>\n<\/body>/);
    expect(out.startsWith(html.slice(0, html.indexOf("</body>")))).toBe(true);
  });

  it("appends it to a page without a body", () => {
    const html = reel([]);

    expect(injectPrerollWarmup(html).startsWith(html)).toBe(true);
    expect(injectPrerollWarmup(html)).toContain("<script>");
  });
});
