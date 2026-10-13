import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { cascadeAcceptConsumedDeps } from "../accept-cascade.js";
import { JobManager } from "../job-manager.js";
import { StateManager } from "../state/index.js";
import { variantDir } from "../variant-dir.js";
import type { VideoDefinition } from "../types/index.js";
import type { AnimaticDefinition } from "../types/animatic.js";

let dir: string;
let manager: StateManager;
let jobManager: JobManager;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(tmpdir(), "konte-cascade-"));
  manager = await StateManager.init(dir);
  jobManager = new JobManager(dir);
});

// Adds a variant with a file at `address` and returns its id. status stays "none".
function addReadyVariant(address: string, file: string): string {
  const vid = manager.reserveVariantId(address);
  manager.getAssetState(address).variants![vid]!.file = file;
  return vid;
}

// A file inside the variant's own directory — what `variantOwningFile` matches a patched take's
// pointer against.
function variantFile(address: string, variantId: string, name: string): string {
  return path.join(variantDir("", address, variantId), name);
}

// A take a patch produced: it points at the returned step's file and records the take it corrects,
// as `materializePatchOutput` writes it.
function addPatchedTake(address: string, sourceVariantId: string, stepFile: string): string {
  const vid = addReadyVariant(address, stepFile);
  manager.getAssetState(address).variants![vid]!.derivedFrom = sourceVariantId;
  return vid;
}

async function addJob(
  address: string,
  variantId: string,
  resolvedDeps: Record<string, string>,
): Promise<void> {
  await jobManager.createJob({ address, variantId, resolvedDeps, backendKind: "comfy" });
}

describe("cascadeAcceptConsumedDeps", () => {
  it("accepts the exact unaccepted dependency variant the accepted variant consumed", async () => {
    const panel = "animatic:shot.01.key";
    const timeline = "animatic:timeline.character";
    const timelineVid = addReadyVariant(timeline, "char.png");
    const panelVid = addReadyVariant(panel, "key.png");
    await addJob(panel, panelVid, { "animatic:timeline.character": "char.png" });

    const accepted = await cascadeAcceptConsumedDeps(manager, jobManager, panel, panelVid, {});

    expect(accepted).toEqual([timeline]);
    expect(manager.getAcceptedVariant(timeline)).toBe(timelineVid);
  });

  it("does not overwrite a dependency that is already accepted to a different variant", async () => {
    const panel = "animatic:shot.01.key";
    const timeline = "animatic:timeline.character";
    const consumedVid = addReadyVariant(timeline, "char-a.png");
    const otherVid = addReadyVariant(timeline, "char-b.png");
    manager.setAccepted(timeline, otherVid);
    const panelVid = addReadyVariant(panel, "key.png");
    await addJob(panel, panelVid, { "animatic:timeline.character": "char-a.png" });

    const accepted = await cascadeAcceptConsumedDeps(manager, jobManager, panel, panelVid, {});

    expect(accepted).toEqual([]);
    expect(manager.getAcceptedVariant(timeline)).toBe(otherVid);
    expect(consumedVid).not.toBe(otherVid);
  });

  it("recurses through multiple dependency levels", async () => {
    const panel = "animatic:shot.01.key";
    const timeline = "animatic:timeline.character";
    const base = "animatic:timeline.base";
    const baseVid = addReadyVariant(base, "base.png");
    const timelineVid = addReadyVariant(timeline, "char.png");
    const panelVid = addReadyVariant(panel, "key.png");
    await addJob(panel, panelVid, { "animatic:timeline.character": "char.png" });
    await addJob(timeline, timelineVid, { "animatic:timeline.base": "base.png" });

    const accepted = await cascadeAcceptConsumedDeps(manager, jobManager, panel, panelVid, {});

    expect(new Set(accepted)).toEqual(new Set([timeline, base]));
    expect(manager.getAcceptedVariant(timeline)).toBe(timelineVid);
    expect(manager.getAcceptedVariant(base)).toBe(baseVid);
  });

  it("resolves cross-stage animatic deps a video motion consumed", async () => {
    const motion = "video:shot.01.motion";
    const timeline = "animatic:timeline.character";
    const timelineVid = addReadyVariant(timeline, "char.png");
    const motionVid = addReadyVariant(motion, "motion.mp4");
    await addJob(motion, motionVid, { "animatic:timeline.character": "char.png" });

    const accepted = await cascadeAcceptConsumedDeps(manager, jobManager, motion, motionVid, {});

    expect(accepted).toEqual([timeline]);
    expect(manager.getAcceptedVariant(timeline)).toBe(timelineVid);
  });

  it("skips gracefully when no job record exists", async () => {
    const panel = "animatic:shot.01.key";
    const panelVid = addReadyVariant(panel, "key.png");

    const accepted = await cascadeAcceptConsumedDeps(manager, jobManager, panel, panelVid, {});

    expect(accepted).toEqual([]);
  });

  // A composition variant carries no job record; its deps come from the shot's
  // compositionRefs resolved against current state (only when `video` is supplied).
  function videoWith(compositionRefs: string[]): VideoDefinition {
    return {
      stage: "video" as const,
      format: { fps: 24, size: { width: 100, height: 100 } },
      shots: [{ id: "01", duration: 2, action: "test shot", assets: {}, compositionRefs }],
    } as VideoDefinition;
  }

  it("pins a timeline asset used only in a composition when accepting the composition", async () => {
    const comp = "video:shot.01#composition";
    const logo = "video:timeline.logo";
    const logoVid = addReadyVariant(logo, "logo.png");
    const compVid = addReadyVariant(comp, "comp.html");

    const accepted = await cascadeAcceptConsumedDeps(manager, jobManager, comp, compVid, {
      video: videoWith(["video:timeline.logo"]),
    });

    expect(accepted).toEqual([logo]);
    expect(manager.getAcceptedVariant(logo)).toBe(logoVid);
  });

  // The board has compositions too, and its accept is what `<Panel src>` targets are signed off by
  // — a shared asset reached only from a panel has no other route to an accept. Its audio rides
  // along: the animatic exists to settle the sound the motion is driven by.
  it("pins an animatic composition's shared panel asset and its audio cue", async () => {
    const comp = "animatic:shot.01#composition";
    const plate = "animatic:timeline.front";
    const cue = "animatic:shot.01.vo";
    const plateVid = addReadyVariant(plate, "front.png");
    const cueVid = addReadyVariant(cue, "vo.wav");
    const compVid = addReadyVariant(comp, "comp.html");

    const board = {
      stage: "animatic" as const,
      typography: { lang: "en" as const },
      format: { fps: 30, size: { width: 100, height: 100 } },
      shots: [
        {
          id: "01",
          duration: 2,
          action: "i",
          assets: {},
          compositionRefs: [plate, cue],
        },
      ],
    } as unknown as AnimaticDefinition;

    const accepted = await cascadeAcceptConsumedDeps(manager, jobManager, comp, compVid, {
      animatic: board,
    });

    expect(new Set(accepted)).toEqual(new Set([plate, cue]));
    expect(manager.getAcceptedVariant(plate)).toBe(plateVid);
    expect(manager.getAcceptedVariant(cue)).toBe(cueVid);
  });

  // A setup's plate is what the shot's keyframe was BUILT FROM, so it sits one level below the
  // composition — reached through the keyframe's job provenance, never named in `compositionRefs`.
  // This is what spares the author an accept on the plate: the accept of the first panel standing on
  // it is the verdict.
  it("cascades a board accept through a keyframe to the setup plate under it", async () => {
    const comp = "animatic:shot.01#composition";
    const keyframe = "animatic:shot.01.first";
    const plate = "animatic:plate.front";
    const plateVid = addReadyVariant(plate, "front.png");
    const keyframeVid = addReadyVariant(keyframe, "first.png");
    const compVid = addReadyVariant(comp, "comp.html");
    await addJob(keyframe, keyframeVid, { [plate]: "front.png" });

    const board = {
      stage: "animatic" as const,
      typography: { lang: "en" as const },
      format: { fps: 30, size: { width: 100, height: 100 } },
      shots: [
        {
          id: "01",
          duration: 2,
          action: "i",
          assets: {},
          compositionRefs: [keyframe],
        },
      ],
    } as unknown as AnimaticDefinition;

    const accepted = await cascadeAcceptConsumedDeps(manager, jobManager, comp, compVid, {
      animatic: board,
    });

    expect(new Set(accepted)).toEqual(new Set([keyframe, plate]));
    expect(manager.getAcceptedVariant(plate)).toBe(plateVid);
  });

  // The board's per-shot mix is a real generated take, not a leaf — but it is still the shot's
  // audio sign-off, so a CLI accept of it must reach the cues it was mixed from. Keying the root's
  // `allowAudio` on the LEAF predicate left every cue undecided.
  it("cascades an animatic shot stem accept to the cues it was mixed from", async () => {
    const stem = "animatic:shot.01#stem";
    const vo = "animatic:shot.01.vo";
    const voVid = addReadyVariant(vo, "vo.wav");
    const stemVid = addReadyVariant(stem, "stem.wav");
    await addJob(stem, stemVid, { [vo]: "vo.wav" });

    const accepted = await cascadeAcceptConsumedDeps(manager, jobManager, stem, stemVid, {});

    expect(accepted).toEqual([vo]);
    expect(manager.getAcceptedVariant(vo)).toBe(voVid);
  });

  // The delivered one does not: its audio is decided on the stem, one accept over.
  it("skips the audio under a delivered composition, as before", async () => {
    const comp = "video:shot.01#composition";
    const logo = "video:timeline.logo";
    const sfx = "video:shot.01.sfx";
    const logoVid = addReadyVariant(logo, "logo.png");
    addReadyVariant(sfx, "sfx.wav");
    const compVid = addReadyVariant(comp, "comp.html");

    const accepted = await cascadeAcceptConsumedDeps(manager, jobManager, comp, compVid, {
      video: videoWith([logo, sfx]),
    });

    expect(accepted).toEqual([logo]);
    expect(manager.getAcceptedVariant(logo)).toBe(logoVid);
    expect(manager.getAcceptedVariant(sfx)).toBeNull();
  });

  it("does nothing for a composition when no video definition is supplied", async () => {
    const comp = "video:shot.01#composition";
    const logo = "video:timeline.logo";
    addReadyVariant(logo, "logo.png");
    const compVid = addReadyVariant(comp, "comp.html");

    const accepted = await cascadeAcceptConsumedDeps(manager, jobManager, comp, compVid, {});

    expect(accepted).toEqual([]);
    expect(manager.getAcceptedVariant(logo)).toBeNull();
  });

  it("does not overwrite a composition dep that is already accepted", async () => {
    const comp = "video:shot.01#composition";
    const logo = "video:timeline.logo";
    addReadyVariant(logo, "a.png");
    const chosenVid = addReadyVariant(logo, "b.png");
    manager.setAccepted(logo, chosenVid);
    const compVid = addReadyVariant(comp, "comp.html");

    const accepted = await cascadeAcceptConsumedDeps(manager, jobManager, comp, compVid, {
      video: videoWith(["video:timeline.logo"]),
    });

    expect(accepted).toEqual([]);
    expect(manager.getAcceptedVariant(logo)).toBe(chosenVid);
  });

  it("recurses from a composition through its dep's own generation provenance", async () => {
    const comp = "video:shot.01#composition";
    const character = "video:timeline.character";
    const base = "video:timeline.base";
    const baseVid = addReadyVariant(base, "base.png");
    const charVid = addReadyVariant(character, "char.png");
    await addJob(character, charVid, { "video:timeline.base": "base.png" });
    const compVid = addReadyVariant(comp, "comp.html");

    const accepted = await cascadeAcceptConsumedDeps(manager, jobManager, comp, compVid, {
      video: videoWith(["video:timeline.character"]),
    });

    expect(new Set(accepted)).toEqual(new Set([character, base]));
    expect(manager.getAcceptedVariant(character)).toBe(charVid);
    expect(manager.getAcceptedVariant(base)).toBe(baseVid);
  });

  // A timeline soundtrack's `src.src` is a `__konte:…__` placeholder when it references a
  // konte asset (a shared BGM lives at reference:<name>).
  function videoWithSoundtrack(compositionRefs: string[], soundtrackSrc: string): VideoDefinition {
    return {
      stage: "video" as const,
      format: { fps: 24, size: { width: 100, height: 100 } },
      shots: [{ id: "01", duration: 2, action: "test shot", assets: {}, compositionRefs }],
      timelineSoundtracks: [
        { __soundtrackEntry: true, id: "bgm", src: { src: soundtrackSrc }, options: {} },
      ],
    } as unknown as VideoDefinition;
  }

  it("does NOT pin a timeline soundtrack (BGM) when accepting a composition — audio is separate", async () => {
    const comp = "video:shot.01#composition";
    const bgm = "reference:bgm";
    addReadyVariant(bgm, "bgm.mp3");
    const compVid = addReadyVariant(comp, "comp.html");

    const accepted = await cascadeAcceptConsumedDeps(manager, jobManager, comp, compVid, {
      video: videoWithSoundtrack([], "__konte:reference:bgm__"),
    });

    // Audio rides its own timeline-track accept — never the composition cascade.
    expect(accepted).toEqual([]);
    expect(manager.getAcceptedVariant(bgm)).toBeNull();
  });

  it("does NOT pin an audio composition ref (a <Sound>) when accepting a composition", async () => {
    const comp = "video:shot.01#composition";
    const sfx = "reference:sfx";
    addReadyVariant(sfx, "sfx.mp3");
    const compVid = addReadyVariant(comp, "comp.html");

    const accepted = await cascadeAcceptConsumedDeps(manager, jobManager, comp, compVid, {
      video: videoWith(["reference:sfx"]),
    });

    expect(accepted).toEqual([]);
    expect(manager.getAcceptedVariant(sfx)).toBeNull();
  });

  it("still pins a non-audio composition ref (a logo image) alongside the audio it skips", async () => {
    const comp = "video:shot.01#composition";
    const logo = "video:timeline.logo";
    const bgm = "reference:bgm";
    const logoVid = addReadyVariant(logo, "logo.png");
    addReadyVariant(bgm, "bgm.mp3");
    const compVid = addReadyVariant(comp, "comp.html");

    const video = {
      stage: "video" as const,
      format: { fps: 24, size: { width: 100, height: 100 } },
      shots: [
        {
          id: "01",
          duration: 2,
          action: "i",
          assets: {},
          compositionRefs: ["video:timeline.logo"],
        },
      ],
      timelineSoundtracks: [
        {
          __soundtrackEntry: true,
          id: "bgm",
          src: { src: "__konte:reference:bgm__" },
          options: {},
        },
      ],
    } as unknown as VideoDefinition;

    const accepted = await cascadeAcceptConsumedDeps(manager, jobManager, comp, compVid, {
      video,
    });

    expect(accepted).toEqual([logo]);
    expect(manager.getAcceptedVariant(logo)).toBe(logoVid);
    expect(manager.getAcceptedVariant(bgm)).toBeNull();
  });

  it("does NOT cascade a character reference — it is accepted only in reference preview", async () => {
    const panel = "animatic:shot.01.key";
    const hero = "reference:hero";
    addReadyVariant(hero, "hero.png");
    const panelVid = addReadyVariant(panel, "key.png");
    await addJob(panel, panelVid, { "reference:hero": "hero.png" });

    const accepted = await cascadeAcceptConsumedDeps(manager, jobManager, panel, panelVid, {
      castAddresses: new Set([hero]),
    });

    expect(accepted).toEqual([]);
    expect(manager.getAcceptedVariant(hero)).toBeNull();
  });

  it("pins a non-character reference dep while skipping the character alongside it", async () => {
    const panel = "animatic:shot.01.key";
    const hero = "reference:hero";
    const bg = "reference:bg";
    addReadyVariant(hero, "hero.png");
    const bgVid = addReadyVariant(bg, "bg.png");
    const panelVid = addReadyVariant(panel, "key.png");
    await addJob(panel, panelVid, {
      "reference:hero": "hero.png",
      "reference:bg": "bg.png",
    });

    const accepted = await cascadeAcceptConsumedDeps(manager, jobManager, panel, panelVid, {
      castAddresses: new Set([hero]),
    });

    expect(accepted).toEqual([bg]);
    expect(manager.getAcceptedVariant(bg)).toBe(bgVid);
    expect(manager.getAcceptedVariant(hero)).toBeNull();
  });

  // A stem is the audio's in-context accept: accepting it cascades its audio sources (the mirror
  // of the composition cascading its picture sources).
  function videoWithShotStem(stemRefs: string[]): VideoDefinition {
    return {
      stage: "video" as const,
      format: { fps: 24, size: { width: 100, height: 100 } },
      shots: [{ id: "01", duration: 2, action: "i", assets: {}, stemRefs }],
    } as unknown as VideoDefinition;
  }

  it("cascades a shot stem accept to its shot audio source (a <Audio> take)", async () => {
    const stem = "video:shot.01#stem";
    const sfx = "reference:sfx";
    const sfxVid = addReadyVariant(sfx, "sfx.mp3");
    const stemVid = addReadyVariant(stem, "stem.json");

    const accepted = await cascadeAcceptConsumedDeps(manager, jobManager, stem, stemVid, {
      video: videoWithShotStem(["reference:sfx"]),
    });

    expect(accepted).toEqual([sfx]);
    expect(manager.getAcceptedVariant(sfx)).toBe(sfxVid);
  });

  // The audio-skip rule protects a cast voice under a picture-rooted walk, but a stem-rooted one
  // allows audio by design — and a voice sample is not audio that plays, it is the sample a line was
  // cloned from. Signing it off here would settle how someone sounds without a human ever hearing it.
  it("does NOT cascade a cast voice sample reached through a stem accept", async () => {
    const stem = "video:shot.01#stem";
    const heroVoice = "reference:heroVoice";
    const sfx = "reference:sfx";
    addReadyVariant(heroVoice, "hero-voice.wav");
    const sfxVid = addReadyVariant(sfx, "sfx.mp3");
    const stemVid = addReadyVariant(stem, "stem.json");

    const accepted = await cascadeAcceptConsumedDeps(manager, jobManager, stem, stemVid, {
      video: videoWithShotStem(["reference:heroVoice", "reference:sfx"]),
      castAddresses: new Set([heroVoice]),
    });

    expect(accepted).toEqual([sfx]);
    expect(manager.getAcceptedVariant(sfx)).toBe(sfxVid);
    expect(manager.getAcceptedVariant(heroVoice)).toBeNull();
  });

  it("cascades a timeline stem accept to its soundtrack bed (a reference BGM)", async () => {
    const stem = "video:timeline#stem";
    const bgm = "reference:bgm";
    const bgmVid = addReadyVariant(bgm, "bgm.mp3");
    const stemVid = addReadyVariant(stem, "stem.json");

    const accepted = await cascadeAcceptConsumedDeps(manager, jobManager, stem, stemVid, {
      video: videoWithSoundtrack([], "__konte:reference:bgm__"),
    });

    expect(accepted).toEqual([bgm]);
    expect(manager.getAcceptedVariant(bgm)).toBe(bgmVid);
  });

  it("does not overwrite a bed take already accepted in reference preview", async () => {
    const stem = "video:timeline#stem";
    const bgm = "reference:bgm";
    addReadyVariant(bgm, "bgm-a.mp3");
    const chosenVid = addReadyVariant(bgm, "bgm-b.mp3");
    manager.setAccepted(bgm, chosenVid);
    const stemVid = addReadyVariant(stem, "stem.json");

    const accepted = await cascadeAcceptConsumedDeps(manager, jobManager, stem, stemVid, {
      video: videoWithSoundtrack([], "__konte:reference:bgm__"),
    });

    expect(accepted).toEqual([]);
    expect(manager.getAcceptedVariant(bgm)).toBe(chosenVid);
  });

  it("skips a dependency whose consumed file no longer matches any variant", async () => {
    const panel = "animatic:shot.01.key";
    const timeline = "animatic:timeline.character";
    addReadyVariant(timeline, "char-new.png"); // the consumed char-old.png was pruned
    const panelVid = addReadyVariant(panel, "key.png");
    await addJob(panel, panelVid, { "animatic:timeline.character": "char-old.png" });

    const accepted = await cascadeAcceptConsumedDeps(manager, jobManager, panel, panelVid, {});

    expect(accepted).toEqual([]);
    expect(manager.getAcceptedVariant(timeline)).toBeNull();
  });
});

describe("cascadeAcceptConsumedDeps — review prerequisites", () => {
  // A board whose shot 01 opens on the shared `character` panel and lands on `key`. The landing
  // frame carries no movement by rule, so accepting it clears the gate — and would sign off the
  // unbound panel feeding it if the cascade did not hold that one back.
  const boardWith = (characterMoves: {
    blocking?: string;
    camera?: string;
  }): AnimaticDefinition => ({
    stage: "animatic" as const,
    typography: { lang: "en" as const },
    format: { size: { width: 100, height: 100 }, fps: 30 },
    shots: [
      {
        id: "01",
        duration: 5,
        action: "test shot",
        assets: {},
        panels: [
          {
            assetName: "character",
            assetPath: "animatic:timeline.character",
            ...characterMoves,
            start: 0,
            duration: 1,
          },
          { assetName: "key", assetPath: "animatic:shot.01.key", start: 0, duration: 1 },
        ],
      },
    ],
  });

  it("holds back a dependency whose movement is not written yet", async () => {
    const panel = "animatic:shot.01.key";
    const timeline = "animatic:timeline.character";
    addReadyVariant(timeline, "char.png");
    const panelVid = addReadyVariant(panel, "key.png");
    await addJob(panel, panelVid, { "animatic:timeline.character": "char.png" });

    const accepted = await cascadeAcceptConsumedDeps(manager, jobManager, panel, panelVid, {
      animatic: boardWith({}),
    });

    expect(accepted).toEqual([]);
    expect(manager.getAcceptedVariant(timeline)).toBeNull();
  });

  it("cascades into it once the movement is written", async () => {
    const panel = "animatic:shot.01.key";
    const timeline = "animatic:timeline.character";
    const timelineVid = addReadyVariant(timeline, "char.png");
    const panelVid = addReadyVariant(panel, "key.png");
    await addJob(panel, panelVid, { "animatic:timeline.character": "char.png" });

    const accepted = await cascadeAcceptConsumedDeps(manager, jobManager, panel, panelVid, {
      animatic: boardWith({ blocking: "she steps to the window", camera: "fixed" }),
    });

    expect(accepted).toEqual([timeline]);
    expect(manager.getAcceptedVariant(timeline)).toBe(timelineVid);
  });

  // A patched take's chain leads back to the take it corrects — the walk's own root address.
  it("signs off what the source take consumed when accepting a patched take", async () => {
    const panel = "animatic:shot.01.key";
    const timeline = "animatic:timeline.character";
    const timelineVid = addReadyVariant(timeline, "char.png");

    const sourceVid = addReadyVariant(panel, "placeholder");
    const sourceFile = variantFile(panel, sourceVid, "key.png");
    manager.getAssetState(panel).variants![sourceVid]!.file = sourceFile;
    await addJob(panel, sourceVid, { "animatic:timeline.character": "char.png" });

    const step = `animatic:patch.${sourceVid}.patched`;
    const stepVid = addReadyVariant(step, "placeholder");
    manager.getAssetState(step).variants![stepVid]!.file = variantFile(step, stepVid, "fixed.png");
    await addJob(step, stepVid, { [panel]: sourceFile });

    const patchedVid = addPatchedTake(panel, sourceVid, variantFile(step, stepVid, "fixed.png"));

    const accepted = await cascadeAcceptConsumedDeps(manager, jobManager, panel, patchedVid, {});

    expect(accepted).toContain(timeline);
    expect(manager.getAcceptedVariant(timeline)).toBe(timelineVid);
    // The take it corrects is walked through, never signed off — it is the "before".
    expect(manager.getAcceptedVariant(panel)).toBeNull();
  });

  it("passes through the source take on a multi-step chain too", async () => {
    const panel = "animatic:shot.01.key";
    const timeline = "animatic:timeline.character";
    const timelineVid = addReadyVariant(timeline, "char.png");

    const sourceVid = addReadyVariant(panel, "placeholder");
    const sourceFile = variantFile(panel, sourceVid, "key.png");
    manager.getAssetState(panel).variants![sourceVid]!.file = sourceFile;
    await addJob(panel, sourceVid, { "animatic:timeline.character": "char.png" });

    // resize (consumes the source) -> patched (consumes resize, and is returned)
    const resize = `animatic:patch.${sourceVid}.resize`;
    const resizeVid = addReadyVariant(resize, "placeholder");
    manager.getAssetState(resize).variants![resizeVid]!.file = variantFile(
      resize,
      resizeVid,
      "resized.png",
    );
    await addJob(resize, resizeVid, { [panel]: sourceFile });

    const step = `animatic:patch.${sourceVid}.patched`;
    const stepVid = addReadyVariant(step, "placeholder");
    manager.getAssetState(step).variants![stepVid]!.file = variantFile(step, stepVid, "fixed.png");
    await addJob(step, stepVid, { [resize]: variantFile(resize, resizeVid, "resized.png") });

    const patchedVid = addPatchedTake(panel, sourceVid, variantFile(step, stepVid, "fixed.png"));

    const accepted = await cascadeAcceptConsumedDeps(manager, jobManager, panel, patchedVid, {});

    expect(accepted).toContain(timeline);
    expect(manager.getAcceptedVariant(timeline)).toBe(timelineVid);
  });

  // The pass-through is keyed on the lineage, not on "some other take at this address".
  it("stays closed for a take that records no lineage", async () => {
    const panel = "animatic:shot.01.key";
    const timeline = "animatic:timeline.character";
    addReadyVariant(timeline, "char.png");

    const sourceVid = addReadyVariant(panel, "placeholder");
    const sourceFile = variantFile(panel, sourceVid, "key.png");
    manager.getAssetState(panel).variants![sourceVid]!.file = sourceFile;
    await addJob(panel, sourceVid, { "animatic:timeline.character": "char.png" });

    const step = `animatic:patch.${sourceVid}.patched`;
    const stepVid = addReadyVariant(step, "placeholder");
    manager.getAssetState(step).variants![stepVid]!.file = variantFile(step, stepVid, "fixed.png");
    await addJob(step, stepVid, { [panel]: sourceFile });

    // Everything a patched take has except `derivedFrom`.
    const patchedVid = addReadyVariant(panel, variantFile(step, stepVid, "fixed.png"));

    const accepted = await cascadeAcceptConsumedDeps(manager, jobManager, panel, patchedVid, {});

    expect(accepted).toEqual([]);
    expect(manager.getAcceptedVariant(timeline)).toBeNull();
  });
});
