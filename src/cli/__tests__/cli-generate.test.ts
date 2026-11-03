import * as fs from "node:fs/promises";
import * as path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { applyDirectionSectionDecisions } from "../../core/direction-acceptance.js";
import { hashFile } from "../../core/content-hash.js";
import { StateManager } from "../../core/state/manager.js";
import { loadDirectionIfPresent } from "../../core/stage-definitions.js";
import {
  ctx,
  useTempWorkspace,
  writeWorkspaceConfig,
  initWithTestVideo,
  run,
  initWorkspace,
  acceptDirection,
  acceptFileAssets,
} from "./cli-fixtures.js";
import { planEntries, REFERENCE_EXPOSED_UNREFERENCED_TS } from "./generate-fixtures.js";

vi.setConfig({ testTimeout: 15000 });

useTempWorkspace();

describe("CLI E2E: init → generate → status/inspect", () => {
  let projectDir: string;
  const address = "video:shot.01.motion";

  beforeEach(async () => {
    projectDir = await initWithTestVideo();
  });

  it("reflects accepted variant in status and inspect", async () => {
    const sm = await StateManager.load(projectDir);
    const variantId = sm.reserveVariantId(address);

    sm.getAssetState(address).variants![variantId]!.file =
      `assets/video:shot.01.motion/${variantId}/output.mp4`;
    sm.setAccepted(address, variantId);
    await sm.save();

    const { stdout } = await run(["inspect", address], projectDir);
    expect(stdout).toContain(`Address: ${address}`);
    expect(stdout).toContain(`Accepted: ${variantId}`);
    expect(stdout).toMatch(new RegExp(`^ {2}${variantId}: accepted \\[.*output\\.mp4\\]`, "m"));
  });
});

describe("generate reference (standalone building blocks)", () => {
  // `latent` is consumed by `key` but not returned (an intermediate); `key` is returned. Both
  // are reachable from the exposed root `key`, so both are planned.
  const REFERENCE_INTERMEDIATE_TS = `import { defineReference, asset, adapters } from "konte";
// @ts-expect-error konte's fixture adapter is runtime-only, outside the workspace's generated types.
import { internalTestPlate } from "konte";
import direction from "./direction";

export default defineReference(direction, { references: () => {
  const character = asset("character", adapters.imageFile, { path: "assets/files/character.png" });
  const bgm = asset("bgm", adapters.audioFile, { path: "assets/files/bgm.mp3" });
  const latent = asset("latent", internalTestPlate, { width: 64, height: 64, color: "#ffffff" });
  const key = asset("key", adapters.imageResize, { image: latent, width: 32, height: 32 });
  return { character, bgm, key };
} });
`;

  // `orphan` is neither returned nor consumed — unused, so `generate reference` skips it,
  // mirroring an unused video/animatic asset.
  const REFERENCE_ORPHAN_TS = `import { defineReference, asset, adapters } from "konte";
// @ts-expect-error konte's fixture adapter is runtime-only, outside the workspace's generated types.
import { internalTestPlate } from "konte";
import direction from "./direction";

export default defineReference(direction, { references: () => {
  const character = asset("character", adapters.imageFile, { path: "assets/files/character.png" });
  const bgm = asset("bgm", adapters.audioFile, { path: "assets/files/bgm.mp3" });
  const orphan = asset("orphan", internalTestPlate, { width: 64, height: 64, color: "#ffffff" });
  return { character, bgm };
} });
`;

  it("plans an exposed reference asset even when nothing references it yet", async () => {
    const inited_refproj = await initWorkspace(path.join(ctx.dir, "refproj"));
    const projectDir = inited_refproj.video;
    await fs.writeFile(path.join(projectDir, "reference.tsx"), REFERENCE_EXPOSED_UNREFERENCED_TS);

    const { stdout } = await run(["generate", "reference", "--plan"], projectDir);
    const latent = planEntries(stdout).find((e) => e.address === "reference:latent");
    expect(latent).toBeDefined();
    expect(latent?.action).toBe("start");
    expect(latent?.detail).toContain("(local)");
  });

  it("plans an un-returned intermediate that an exposed asset consumes", async () => {
    const inited_refproj = await initWorkspace(path.join(ctx.dir, "refproj"));
    const projectDir = inited_refproj.video;
    await fs.writeFile(path.join(projectDir, "reference.tsx"), REFERENCE_INTERMEDIATE_TS);

    const { stdout } = await run(["generate", "reference", "--plan"], projectDir);
    const addrs = planEntries(stdout).map((e) => e.address);
    expect(addrs).toContain("reference:latent");
    expect(addrs).toContain("reference:key");
  });

  it("skips a declared reference asset that is neither returned nor consumed", async () => {
    const inited_refproj = await initWorkspace(path.join(ctx.dir, "refproj"));
    const projectDir = inited_refproj.video;
    await fs.writeFile(path.join(projectDir, "reference.tsx"), REFERENCE_ORPHAN_TS);

    const { stdout } = await run(["generate", "reference", "--plan"], projectDir);
    const addrs = planEntries(stdout).map((e) => e.address);
    expect(addrs).not.toContain("reference:orphan");
    // The exposed file assets are still present.
    expect(addrs).toContain("reference:character");
  });

  // Generating a downstream stage must auto-register the reference stage's file assets, so a
  // dependency resolves without first running `generate reference`. Regression: animatic shots
  // failed with "reference:character has no ready variant" because animatic sync never touched the
  // reference stage.
  it("auto-registers reference file assets when generating a dependent stage", async () => {
    const inited_refproj = await initWorkspace(path.join(ctx.dir, "refproj"));
    const projectDir = inited_refproj.video;
    // The fixture animatic declares comfy models; disable auto-install so `generate` doesn't probe
    // ComfyUI for them (this test only covers reference file-asset registration).
    await writeWorkspaceConfig(projectDir, {
      comfy: {
        comfyui: {
          url: "http://127.0.0.1:8188",
          autoInstallModels: false,
          autoInstallNodes: false,
        },
      },
    });
    await acceptDirection(projectDir);
    // The character gate runs before the sync, so the look's accept is seeded as a reviewer leaves it.
    const sm = await StateManager.load(projectDir);
    const look = sm.reserveVariantId("reference:character");
    Object.assign(sm.getAssetState("reference:character").variants![look]!, {
      file: "assets/files/character.png",
      outputHash: await hashFile(path.join(projectDir, "assets/files/character.png")),
    });
    sm.setAccepted("reference:character", look);
    await sm.save();

    await run(["generate", "animatic"], projectDir);

    const state = JSON.parse(await fs.readFile(path.join(projectDir, "konte.state.json"), "utf-8"));
    const bgm = Object.values(state.assets["reference:bgm"]?.variants ?? {}) as Array<{
      file: string;
    }>;
    expect(bgm.map((v) => v.file)).toEqual(["assets/files/bgm.mp3"]);
  });

  it("holds the song take until the brief, policy and lyrics are accepted", async () => {
    const { video: projectDir } = await initWorkspace(path.join(ctx.dir, "songproj"), {
      template: "blank",
    });
    const directionPath = path.join(projectDir, "direction.ts");
    const blank = await fs.readFile(directionPath, "utf-8");
    await fs.writeFile(
      directionPath,
      blank
        .replace(
          "characters: {},",
          'characters: { mika: { name: "Mika", description: "a singer", promptDepiction: "mika" } },',
        )
        .replace('lang: "en",', 'lang: "en",\n    song: "song",')
        .replace(
          "  sequence: {",
          '  lyrics: [{ label: "Verse", singer: "mika", lines: ["lights down"] }],\n  sequence: {',
        ),
    );
    await fs.writeFile(
      path.join(projectDir, "reference.tsx"),
      `import { defineReference, asset } from "konte";
// @ts-expect-error konte's fixture adapter is runtime-only, outside the workspace's generated types.
import { internalTestPlate } from "konte";
import direction from "./direction";

export default defineReference(direction, { references: () => {
  const song = asset("song", internalTestPlate, { width: 64, height: 64, color: "#ffffff" });
  return { song };
} });
`,
    );

    await expect(run(["generate", "reference", "--plan"], projectDir)).rejects.toMatchObject({
      stderr: expect.stringMatching(/SPEND_HELD[\s\S]*direction:lyrics/),
    });

    const statePath = path.join(projectDir, "konte.state.json");
    const direction = await loadDirectionIfPresent(projectDir);
    const state = JSON.parse(await fs.readFile(statePath, "utf-8"));
    state.directionAcceptance = applyDirectionSectionDecisions(direction!, null, {
      brief: true,
      policy: true,
      lyrics: true,
    });
    await fs.writeFile(statePath, JSON.stringify(state, null, 2));
    const { stdout } = await run(["generate", "reference", "--plan"], projectDir);
    expect(planEntries(stdout).map((e) => e.address)).toContain("reference:song");
  });

  it("makes and waits on the song while a board cut to it waits on a read take", async () => {
    const { video: projectDir } = await initWorkspace(path.join(ctx.dir, "unreadsong"), {
      template: "blank",
    });
    const directionPath = path.join(projectDir, "direction.ts");
    const blank = await fs.readFile(directionPath, "utf-8");
    await fs.writeFile(
      directionPath,
      blank
        .replace(
          "locations: {},",
          'locations: { studio: { name: "the studio", description: "a studio", landmarks: {} } },',
        )
        .replace(
          "setups: {},",
          'setups: { front: { name: "front", description: "straight on", location: "studio", framing: "medium", view: "front", holds: [] } },',
        )
        .replace('lang: "en",', 'lang: "en",\n    song: "song",')
        .replace(
          "shots: [],",
          'shots: [{ id: "01", role: "ordinary", action: "a", setup: "front", beats: 4, lineup: [] }],',
        ),
    );
    await fs.writeFile(
      path.join(projectDir, "animatic.tsx"),
      `import { defineAnimatic } from "konte";
import direction from "./direction";

export default defineAnimatic(direction, {
  timeline: ({ pendingShot }) => ({ shots: pendingShot("01") }),
});
`,
    );
    await fs.writeFile(
      path.join(projectDir, "reference.tsx"),
      `import { defineReference, asset } from "konte";
// @ts-expect-error konte's fixture adapter is runtime-only, outside the workspace's generated types.
import { internalTestPlate } from "konte";
import direction from "./direction";

export default defineReference(direction, { references: () => {
  const song = asset("song", internalTestPlate, { width: 64, height: 64, color: "#ffffff" });
  return { song };
} });
`,
    );
    await acceptDirection(projectDir);

    await expect(run(["generate", "animatic", "--plan"], projectDir)).rejects.toMatchObject({
      stderr: expect.stringMatching(/SONG_UNREAD[\s\S]*reference:song/),
    });
    const { stdout } = await run(["generate", "reference", "--plan"], projectDir);
    expect(planEntries(stdout).map((e) => e.address)).toContain("reference:song");
    await run(["job", "wait"], projectDir);
    await expect(run(["status"], projectDir)).rejects.toMatchObject({
      stderr: expect.stringMatching(/SONG_UNREAD[\s\S]*konte generate reference/),
    });
  });

  it("blocks animatic generation until the direction is accepted", async () => {
    const inited_gateproj = await initWorkspace(path.join(ctx.dir, "gateproj"));
    const projectDir = inited_gateproj.video;
    await writeWorkspaceConfig(projectDir, {
      comfy: {
        comfyui: {
          url: "http://127.0.0.1:8188",
          autoInstallModels: false,
          autoInstallNodes: false,
        },
      },
    });
    await acceptFileAssets(projectDir);

    // Without a recorded acceptance the spend gate refuses, pointing at the review command and
    // naming the parts that block it — "not accepted" alone would leave the author to guess.
    await expect(run(["generate", "animatic"], projectDir)).rejects.toMatchObject({
      stderr: expect.stringContaining("SPEND_HELD"),
    });

    // Acceptance is per part, so a reviewer who settled some of the page has not opened the gate:
    // the parts they never read still block it.
    const statePath = path.join(projectDir, "konte.state.json");
    const direction = await loadDirectionIfPresent(projectDir);
    const partial = JSON.parse(await fs.readFile(statePath, "utf-8"));
    partial.directionAcceptance = applyDirectionSectionDecisions(direction!, null, {
      brief: true,
      policy: true,
    });
    await fs.writeFile(statePath, JSON.stringify(partial, null, 2));
    await expect(run(["generate", "animatic"], projectDir)).rejects.toMatchObject({
      stderr: expect.stringContaining("SPEND_HELD"),
    });

    // After the reviewer accepts every section, generation proceeds.
    await acceptDirection(projectDir);
    await run(["generate", "animatic"], projectDir);
    const state = JSON.parse(await fs.readFile(statePath, "utf-8"));
    expect(state.directionAcceptance?.whole?.hash).toBeTruthy();
  });

  // The gate narrows once the piece has been signed off end to end: the shots are read as panels and
  // shots from then on, so editing one does not send the author back to a page showing the same words
  // as prose. The piece-wide agreements have no such second reading and keep blocking for good.
  it("stops blocking on a shot edited after the direction was accepted whole", async () => {
    const inited = await initWorkspace(path.join(ctx.dir, "unlockproj"));
    const projectDir = inited.video;
    await writeWorkspaceConfig(projectDir, {
      comfy: {
        comfyui: {
          url: "http://127.0.0.1:8188",
          autoInstallModels: false,
          autoInstallNodes: false,
        },
      },
    });
    await acceptDirection(projectDir);
    await acceptFileAssets(projectDir);

    const statePath = path.join(projectDir, "konte.state.json");
    const accepted = JSON.parse(await fs.readFile(statePath, "utf-8"));
    const parts = accepted.directionAcceptance.parts as Record<string, { partHash: string }>;
    const shotPart = Object.keys(parts).find((a) => a.startsWith("direction:sequence.shots."))!;

    // Age the shot out exactly as rewriting it would, without touching the whole-direction verdict.
    parts[shotPart]!.partHash = "stale00000000";
    accepted.directionAcceptance.whole.hash = null;
    await fs.writeFile(statePath, JSON.stringify(accepted, null, 2));
    await run(["generate", "animatic"], projectDir);

    // The brief is the other half: no panel or shot ever shows it, so it re-blocks.
    parts["direction:brief.logline"]!.partHash = "stale11111111";
    await fs.writeFile(statePath, JSON.stringify(accepted, null, 2));
    await expect(run(["generate", "animatic"], projectDir)).rejects.toMatchObject({
      stderr: expect.stringContaining("SPEND_HELD"),
    });
  });
});
