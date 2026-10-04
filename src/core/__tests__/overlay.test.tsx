import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { holdsHumanVerdict } from "../accept-cascade.js";
import { isMaterializedLeafAddress, listOverlayAddresses } from "../address.js";
import { definitionHashForAddress, materializeOverlayVariant } from "../composition-resource.js";
import {
  Audio,
  Composition,
  Image,
  Subtitle,
  Video,
  asset,
  defineDirection,
  defineVideo,
} from "../dsl/index.js";
import { defineComfyAsset } from "../dsl/comfy-asset.js";
import { buildRenderPlan } from "../render-plan.js";
import { buildShotCompositionHtml, compositionClassSubjects } from "../composition-builder.js";
import { commentSubjectAddresses } from "../feedback/subject.js";
import { computeExportSignature } from "../export-signature.js";
import { buildDependencyGraph, collectRerollCascade } from "../graph.js";
import { computeDependencyLevels } from "../dependency-levels.js";
import { withSongTakes } from "../dsl/song-context.js";
import { injectOverlay, shiftTimedElements } from "../overlay-render.js";
import { StateManager } from "../state/index.js";
import { checkTailwindClasses } from "../tailwind-classes.js";
import { directionDefaults } from "./helpers/direction.js";

const clocked = () =>
  defineDirection({
    ...directionDefaults,
    characters: { konte: { name: "Konte", promptDepiction: "girl", description: "the singer" } },
    policy: {
      format: { fps: 24, size: { megapixels: 0.589824, delivery: { width: 1024, height: 576 } } },
      lang: "en",
      speech: "free",
      clock: { song: "song", bpm: 120, beatsPerBar: 4 },
    },
    lyrics: [{ label: "chorus", singer: "konte", lines: ["Hit the light", "Watch me move"] }],
    sequence: {
      lens: "mini-drama",
      pleasure: "cute",
      shots: [
        { id: "01", role: "ordinary", action: "a", setup: "front", beats: 4, lineup: [] },
        {
          id: "02",
          role: "hero",
          action: "b",
          setup: "front",
          beats: 4,
          lineup: [],
          join: "jump-forward",
        },
      ],
    },
  });

// A take whose two lines a person placed at 1s–3s and 3s–4s, its first beat at 0.
const placedTake = (address: string) =>
  address === "reference:song"
    ? {
        address,
        variantId: "v-song",
        analysis: {
          bpm: 120,
          downbeatSec: 0,
          sectionSecs: [],
          phrases: null,
          heard: null,
          clock: { bpm: 120, beatsPerBar: 4 },
          lang: "en",
          lines: {
            "1.1": {
              text: "Hit the light",
              startSec: 1,
              endSec: 3,
            },
            "1.2": {
              text: "Watch me move",
              startSec: 3,
              endSec: 4,
            },
          },
        },
      }
    : null;

const plain = () => <Composition />;

describe("overlay", () => {
  it("hands its build the whole timeline: its length, its lines and its beats", async () => {
    let seen: { duration: number; lyrics: unknown; beat1: number } | null = null;
    const video = await withSongTakes(placedTake, async () =>
      defineVideo(clocked(), {
        timeline: ({ shot }) => ({
          shots: shot("01", plain).nextShot("02", plain),
          overlay: (ctx) => {
            seen = { duration: ctx.duration, lyrics: ctx.lyrics, beat1: ctx.beat(1) };
            return (
              <Composition>
                <Subtitle entries={ctx.lyrics.map((l) => ({ ...l }))} />
              </Composition>
            );
          },
        }),
      }),
    );
    expect(video.overlay?.duration).toBe(4);
    expect(seen).toEqual({
      duration: 4,
      lyrics: [
        { text: "Hit the light", singer: ["konte"], start: 1, end: 3 },
        { text: "Watch me move", singer: ["konte"], start: 3, end: 4 },
      ],
      beat1: 0.5,
    });
  });

  it("refuses an asset declared inside it", () => {
    const still = defineComfyAsset({
      workflow: "image.json",
      description: "test adapter",
      inputs: { prompt: { nodeId: "3", field: "text", type: "string" } },
      outputs: { result: { nodeId: "9", type: "image" } },
    });
    expect(() =>
      defineVideo(clocked(), {
        timeline: ({ shot }) => ({
          shots: shot("01", plain).nextShot("02", plain),
          overlay: () => (
            <Composition>
              <Image src={asset("logo", still, { prompt: "a logo" })} fill />
            </Composition>
          ),
        }),
      }),
    ).toThrow(/declare the asset at the top of the timeline/);
  });
});

describe("a shot's lines", () => {
  it("cut a line sung from before the shot at its head", async () => {
    let seen: unknown = null;
    await withSongTakes(placedTake, async () =>
      defineVideo(clocked(), {
        timeline: ({ shot }) => ({
          shots: shot("01", plain).nextShot("02", (ctx) => {
            seen = ctx.lyrics;
            return plain();
          }),
        }),
      }),
    );
    // "Hit the light" runs 1s–3s on the timeline; shot 02 opens at 2s.
    expect(seen).toEqual([
      { text: "Hit the light", singer: ["konte"], start: 0, end: 1 },
      { text: "Watch me move", singer: ["konte"], start: 1, end: 2 },
    ]);
  });
});

describe("an overlay's picture", () => {
  const sound = defineComfyAsset({
    workflow: "audio.json",
    description: "test adapter",
    inputs: { prompt: { nodeId: "3", field: "text", type: "string" } },
    outputs: { result: { nodeId: "9", type: "audio" } },
  });
  const moving = defineComfyAsset({
    workflow: "video.json",
    description: "test adapter",
    inputs: { prompt: { nodeId: "3", field: "text", type: "string" } },
    outputs: { result: { nodeId: "9", type: "video" } },
  });

  it("refuses media", () => {
    expect(() =>
      defineVideo(clocked(), {
        timeline: ({ shot }) => {
          const chime = asset("chime", sound, { prompt: "a chime" });
          return {
            shots: shot("01", plain).nextShot("02", plain),
            overlay: () => (
              <Composition>
                <Audio src={chime} />
              </Composition>
            ),
          };
        },
      }),
    ).toThrow(/text, images and animation/);
    expect(() =>
      defineVideo(clocked(), {
        timeline: ({ shot }) => {
          const clip = asset("clip", moving, { prompt: "a clip" });
          return {
            shots: shot("01", plain).nextShot("02", plain),
            overlay: () => (
              <Composition>
                <Video src={clip} />
              </Composition>
            ),
          };
        },
      }),
    ).toThrow(/text, images and animation/);
  });
});

describe("an overlay's context", () => {
  it("counts no beats and hears no lines on a piece in seconds", () => {
    let seen: unknown = null;
    defineVideo(
      defineDirection({
        ...directionDefaults,
        sequence: {
          lens: "mini-drama",
          pleasure: "cute",
          shots: [
            { id: "01", role: "ordinary", action: "a", setup: "front", duration: 2, lineup: [] },
          ],
        },
      }),
      {
        timeline: ({ shot }) => ({
          shots: shot("01", plain),
          overlay: (ctx) => {
            // @ts-expect-error -- a piece in seconds has no beat to count
            void ctx.beat;
            // @ts-expect-error -- nor lines to hear
            void ctx.lyrics;
            seen = ctx;
            return plain();
          },
        }),
      },
    );
    expect(seen).toEqual({ duration: 2 });
  });
});

describe("laying the overlay over a shot", () => {
  it("moves the timed layers onto the host's clock", () => {
    const html =
      `<div class="a" data-start="0.5" data-duration="1"></div>` +
      `<div class="b" data-start="2.5" data-duration="2"></div>` +
      `<div class="c" data-start="4" data-duration="1"></div>`;
    expect(shiftTimedElements(html, 3, 2)).toBe(
      `<div class="a" data-start="3" data-duration="0.001"></div>` +
        `<div class="b" data-start="0" data-duration="1.5"></div>` +
        `<div class="c" data-start="1" data-duration="1"></div>`,
    );
  });

  it("hosts the overlay inside the shot's stage and carries the clock it missed", () => {
    const shot = `<html><body><div id="stage"><div class="shot"></div></div></body></html>`;
    const out = injectOverlay(shot, { body: "<p>x</p>", shotStart: 3, shotDuration: 2 });
    expect(out).toBe(
      `<html><body><div id="stage"><div class="shot"></div>` +
        `<div data-composition-id="shot-timeline.overlay" data-start="0" data-duration="2" data-media-start="3" style="position:absolute;top:0;left:0;width:100%;height:100%;"></div>` +
        `</div><template id="shot-timeline.overlay-template"><p>x</p></template></body></html>`,
    );
  });
});

describe("the overlay as a leaf", () => {
  let tmpDir: string;
  let manager: StateManager;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "konte-overlay-test-"));
    manager = await StateManager.init(tmpDir);
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  const still = defineComfyAsset({
    workflow: "image.json",
    description: "test adapter",
    inputs: { prompt: { nodeId: "3", field: "text", type: "string" } },
    outputs: { result: { nodeId: "9", type: "image" } },
  });

  const withTitle = (text: string | null) =>
    defineVideo(clocked(), {
      timeline: ({ shot }) => ({
        shots: shot("01", plain).nextShot("02", plain),
        ...(text === null
          ? {}
          : {
              overlay: () => (
                <Composition>
                  <Subtitle entries={[{ text, start: 0, end: 1 }]} />
                </Composition>
              ),
            }),
      }),
    });

  const withLogo = () =>
    defineVideo(clocked(), {
      timeline: ({ shot }) => {
        const logo = asset("logo", still, { prompt: "a logo" });
        return {
          shots: shot("01", plain).nextShot("02", plain),
          overlay: () => (
            <Composition>
              <Image src={logo} fill />
            </Composition>
          ),
        };
      },
    });

  it("is addressed by a name reserved on its stage's timeline", () => {
    expect(listOverlayAddresses(withTitle("Hello"))).toEqual(["video:timeline#overlay"]);
    expect(listOverlayAddresses(withTitle(null))).toEqual([]);
    expect(isMaterializedLeafAddress("video:timeline#overlay")).toBe(true);
  });

  it("renders one take per definition, which a changed definition leaves stale", async () => {
    const video = withTitle("Hello");
    const address = "video:timeline#overlay";
    const first = await materializeOverlayVariant({ manager, video });
    expect(await materializeOverlayVariant({ manager, video })).toBe(first);
    const take = manager.getAssetState(address).variants![first!]!;
    expect(path.basename(take.file!)).toBe("overlay.html");
    expect(take.definitionHash).toBe(definitionHashForAddress(video, address));

    manager.setAccepted(address, first!);
    expect(holdsHumanVerdict(manager, address)).toBe(false);

    const edited = withTitle("Goodbye");
    expect(definitionHashForAddress(edited, address)).not.toBe(take.definitionHash);
    expect(await materializeOverlayVariant({ manager, video: edited })).not.toBe(first);
  });

  it("is a leaf no generation wave or reroll cascade reaches", () => {
    const video = withLogo();
    const graph = buildDependencyGraph(video);
    expect(graph.dependents.get("video:timeline.logo")).toContain("video:timeline#overlay");
    expect(collectRerollCascade(graph, "video:timeline.logo", video, () => false)).toEqual([]);
    expect(computeDependencyLevels(graph).levelOf.has("video:timeline#overlay")).toBe(false);
  });

  it("is part of what a comment on a shot stands on", () => {
    const subject = commentSubjectAddresses(withLogo(), "video:shot.01");
    expect(subject?.leaves).toContain("video:timeline#overlay");
    expect(subject?.assets).toContain("video:timeline.logo");
  });

  it("is part of what the export is signed by", () => {
    const none = computeExportSignature(withTitle(null));
    const credit = computeExportSignature(withTitle("by konte"));
    expect(credit).not.toBe(none);
    expect(computeExportSignature(withTitle("by nazuna"))).not.toBe(credit);
  });

  it("holds every shot to what it shows", () => {
    const plan = buildRenderPlan(withLogo(), manager, {
      outputDir: "",
      allowUnaccepted: true,
      allowNotReady: true,
    });
    expect(plan.shots.map((s) => [s.shotId, s.unresolvedRefs])).toEqual([
      ["01", ["video:timeline.logo"]],
      ["02", ["video:timeline.logo"]],
    ]);
  });

  it("is laid over a shot's span where a frame of it is read", async () => {
    const build = (withOverlay: boolean) =>
      buildShotCompositionHtml({
        video: withTitle("Hello"),
        manager,
        shotId: "02",
        assetBaseUrl: "",
        allowNotReady: true,
        withOverlay,
      });
    const laid = (await build(true)).html;
    expect(laid).toContain("Hello");
    expect(laid).toContain(`data-composition-id="shot-timeline.overlay"`);
    expect(laid).toContain(`data-media-start="2"`);
    expect((await build(false)).html).not.toContain("Hello");
  });
});

describe("the overlay's classes", () => {
  it("are read beside each shot's from the definition alone", async () => {
    const video = defineVideo(
      defineDirection({
        ...directionDefaults,
        sequence: {
          lens: "mini-drama",
          pleasure: "cute",
          shots: [
            { id: "01", role: "ordinary", action: "a", setup: "front", duration: 2, lineup: [] },
          ],
        },
      }),
      {
        timeline: ({ shot }) => ({
          shots: shot("01", () => (
            <Composition>
              <div className="text-whit" />
            </Composition>
          )),
          overlay: () => (
            <Composition>
              <Subtitle entries={[{ text: "Hi", start: 0, end: 1 }]} className="font-['Cinzel']" />
            </Composition>
          ),
        }),
      },
    );
    const findings = await checkTailwindClasses(compositionClassSubjects(video));
    expect(findings).toEqual([
      { label: "video:shot.01#composition", unknown: ["text-whit"], fontFamily: [] },
      { label: "video:timeline#overlay", unknown: [], fontFamily: ["font-['Cinzel']"] },
    ]);
  });
});
