import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readCurrentVideo } from "../../../core/roots.js";
import { hashFile } from "../../../core/content-hash.js";
import {
  readDefinitionSnapshot,
  writeDefinitionSnapshot,
} from "../../../core/definition-snapshot.js";
import { syncFileAssets } from "../../../core/file-sync.js";
import { StateManager } from "../../../core/state/index.js";
import { variantDir } from "../../../core/variant-dir.js";
import { initWorkspace, run } from "../../__tests__/harness.js";
import { loadDirectionIfPresent, loadStageDefinitions } from "../../load-definition.js";

let tmp: string;
let workspace: string;
let source: string;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "konte-video-copy-"));
  ({ workspace, video: source } = await initWorkspace(path.join(tmp, "ws"), { video: "original" }));
  await StateManager.withLock(source, async (manager) => {
    manager.getState().assets = {};
    manager.getState().directionAcceptance = {
      parts: { "direction:brief.logline": { partHash: "logline", acceptedAt: "2026-01-01" } },
      whole: { hash: "whole", acceptedAt: "2026-01-01" },
    };
    for (const address of [
      "reference:character",
      "animatic:shot.01.first",
      "video:shot.01.motion",
    ]) {
      for (const status of ["accepted", "none", "dismissed"] as const) {
        const id = manager.reserveVariantId(address);
        const file = path.join(variantDir(source, address, id), "output.png");
        await fs.mkdir(path.dirname(file), { recursive: true });
        await fs.writeFile(file, `${address}:${status}`);
        Object.assign(manager.getAssetState(address).variants![id]!, {
          status,
          file: path.relative(source, file),
          outputHash: address,
          definitionHash: "definition",
          inputFingerprints: { "reference:character": "input" },
          keptInputs: { "reference:character": "kept" },
          metadata: { jobId: "old-job" },
        });
        await fs.writeFile(path.join(path.dirname(file), "thumbnail.png"), "cache");
        writeDefinitionSnapshot(source, address, id, {
          kind: "file",
          type: "image",
          path: "assets/files/input.png",
          deterministic: true,
        });
      }
    }
  });
  for (const file of [
    ".konte/jobs.db",
    ".konte/cache/old",
    ".konte/logs/old.log",
    "dist/old.mp4",
    "review/video/feedback.json",
    "patches/v-old.ts",
    "assets/files/unused.png",
  ]) {
    await fs.mkdir(path.dirname(path.join(source, file)), { recursive: true });
    await fs.writeFile(path.join(source, file), "old");
  }
});

afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

describe("video copy", () => {
  it.each(["direction", "reference", "animatic", "video"])(
    "retains only the prefix through %s",
    async (through) => {
      const before = await fs.readFile(path.join(source, "konte.state.json"), "utf8");
      const { stdout } = await run(
        ["video", "copy", "original", "alternate", "--through", through],
        workspace,
      );
      const destination = path.join(workspace, "videos", "alternate");
      const state = (await StateManager.load(destination)).getState();
      const stages = ["direction", "reference", "animatic", "video"];
      const end = stages.indexOf(through);
      expect(Object.keys(state.assets)).toHaveLength(end);
      expect(state.directionAcceptance?.whole?.hash).toBe("whole");
      expect(stdout).toContain(`${end} accepted assets`);
      expect(await readCurrentVideo(workspace)).toBe("alternate");
      for (const [stage, file] of Object.entries({
        direction: "direction.ts",
        reference: "reference.tsx",
        animatic: "animatic.tsx",
        video: "video.tsx",
      })) {
        const text = await fs.readFile(path.join(destination, file), "utf8");
        if (stages.indexOf(stage) <= end) {
          expect(text).toBe(await fs.readFile(path.join(source, file), "utf8"));
        } else {
          expect(text).not.toBe(await fs.readFile(path.join(source, file), "utf8"));
        }
      }
      for (const [address, asset] of Object.entries(state.assets)) {
        const [id, variant] = Object.entries(asset.variants!)[0]!;
        expect(variant!.status).toBe("accepted");
        expect(variant!.metadata).toEqual({});
        expect(variant!.keptInputs).toEqual({ "reference:character": "kept" });
        expect(await fs.readFile(path.join(destination, variant!.file!), "utf8")).toBe(
          `${address}:accepted`,
        );
        expect(await fs.readdir(variantDir(destination, address, id!))).toEqual([
          "definition.json",
          "output.png",
        ]);
        expect(readDefinitionSnapshot(destination, address, id!)).toEqual({
          kind: "file",
          type: "image",
          path: "assets/files/input.png",
          deterministic: true,
        });
        expect(
          (await StateManager.load(source)).getState().assets[address]?.variants?.[id!],
        ).toBeUndefined();
      }
      for (const file of [".konte", "dist", "review", "patches", "assets/files/unused.png"]) {
        await expect(fs.access(path.join(destination, file))).rejects.toThrow();
      }
      expect(await fs.readFile(path.join(source, "konte.state.json"), "utf8")).toBe(before);
    },
  );

  it("uses the explicit source ahead of the cwd and current video and copies source modules", async () => {
    await fs.writeFile(path.join(source, "helpers.ts"), "export const value = 1;");
    await run(["video", "new", "other", "--template", "blank"], workspace);
    await run(
      ["video", "copy", "original", "alternate", "--through", "direction"],
      path.join(workspace, "videos/other"),
    );
    expect(
      await fs.readFile(path.join(workspace, "videos/alternate/helpers.ts"), "utf8"),
    ).toContain("value = 1");
    expect(await fs.readFile(path.join(workspace, "videos/alternate/direction.ts"), "utf8")).toBe(
      await fs.readFile(path.join(source, "direction.ts"), "utf8"),
    );
  });

  it("loads copied definitions with nested stage-named modules and JSON dependencies", async () => {
    await fs.mkdir(path.join(source, "helpers"));
    await fs.writeFile(
      path.join(source, "helpers/brief.json"),
      JSON.stringify({ logline: "Copied idea" }),
    );
    await fs.writeFile(
      path.join(source, "helpers/direction.ts"),
      'import brief from "./brief.json"; export default brief.logline;',
    );
    const direction = await fs.readFile(path.join(source, "direction.ts"), "utf8");
    await fs.writeFile(
      path.join(source, "direction.ts"),
      'import logline from "./helpers/direction.js";\n' +
        direction.replace(/logline: "[^"]*"/, "logline"),
    );
    expect((await loadDirectionIfPresent(source))?.brief.logline).toBe("Copied idea");
    await run(["video", "copy", "original", "alternate", "--through", "direction"], workspace);
    const destination = path.join(workspace, "videos/alternate");
    expect((await loadDirectionIfPresent(destination))?.brief.logline).toBe("Copied idea");
    const video = await fs.readFile(path.join(destination, "video.tsx"), "utf8");
    expect(video).toContain("shots: []");
  });

  it("copies an accepted file asset and song reading without unrelated files", async () => {
    await fs.writeFile(path.join(source, "assets/files/song.mp3"), "song");
    await StateManager.withLock(source, async (manager) => {
      const id = manager.reserveVariantId("reference:song");
      const variant = manager.getAssetState("reference:song").variants![id]!;
      variant.status = "accepted";
      variant.file = "assets/files/song.mp3";
      variant.song = { reading: "reading", lang: "en" };
      const dir = variantDir(source, "reference:song", id);
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(path.join(dir, "song.json"), "reading");
    });
    await run(["video", "copy", "original", "alternate", "--through", "reference"], workspace);
    const destination = path.join(workspace, "videos/alternate");
    const state = (await StateManager.load(destination)).getState();
    const [id, variant] = Object.entries(state.assets["reference:song"]!.variants!)[0]!;
    expect(await fs.readFile(path.join(destination, variant!.file!), "utf8")).toBe("song");
    expect(
      await fs.readFile(
        path.join(variantDir(destination, "reference:song", id!), "song.json"),
        "utf8",
      ),
    ).toBe("reading");
    await expect(fs.access(path.join(destination, "assets/files/unused.png"))).rejects.toThrow();
  });

  it("copies the accepted patch output as an independent take", async () => {
    let originalId = "";
    await StateManager.withLock(source, async (manager) => {
      const variants = manager.getAssetState("reference:character").variants!;
      const [id, accepted] = Object.entries(variants).find(([, v]) => v.status === "accepted")!;
      originalId = id;
      accepted.status = "dismissed";
      const patchId = manager.reserveVariantId("reference:character");
      const patchFile = `assets/reference/patch/${id}/fixed/v-step/output.png`;
      await fs.mkdir(path.dirname(path.join(source, patchFile)), { recursive: true });
      await fs.writeFile(path.join(source, patchFile), "patched");
      Object.assign(variants[patchId]!, {
        status: "accepted",
        file: patchFile,
        derivedFrom: id,
        patchHash: "patch",
        outputHash: "patched",
        definitionHash: "definition",
        inputFingerprints: { [`reference:patch.${id}.fixed`]: "patched" },
      });
      const stepAddress = `reference:patch.${id}.fixed`;
      const stepId = manager.reserveVariantId(stepAddress);
      Object.assign(manager.getAssetState(stepAddress).variants![stepId]!, {
        status: "accepted",
        file: patchFile,
        outputHash: "patched",
      });
    });
    await run(["video", "copy", "original", "alternate", "--through", "reference"], workspace);
    const destination = path.join(workspace, "videos/alternate");
    const state = (await StateManager.load(destination)).getState();
    const [id, variant] = Object.entries(state.assets["reference:character"]!.variants!)[0]!;
    expect(variant.derivedFrom).toBeNull();
    expect(variant.patchHash).toBeNull();
    expect(variant.inputFingerprints).toEqual({});
    expect(readDefinitionSnapshot(destination, "reference:character", id)?.kind).toBe("file");
    expect(Object.keys(state.assets)).toEqual(["reference:character"]);
    expect(await fs.readFile(path.join(destination, variant.file!), "utf8")).toBe("patched");
    expect(variant.file).toBe(
      path.relative(
        destination,
        path.join(variantDir(destination, "reference:character", id), "output.png"),
      ),
    );
    await expect(
      fs.access(variantDir(destination, "reference:character", originalId)),
    ).rejects.toThrow();
    await expect(fs.access(path.join(destination, "assets/reference/patch"))).rejects.toThrow();
  });

  it("keeps an accepted file patch at the authored path through file synchronization", async () => {
    const address = "reference:character";
    const file = "assets/files/character.png";
    await StateManager.withLock(source, async (manager) => {
      const bgmId = manager.reserveVariantId("reference:bgm");
      Object.assign(manager.getAssetState("reference:bgm").variants![bgmId]!, {
        status: "accepted",
        file: "assets/files/bgm.mp3",
        outputHash: await hashFile(path.join(source, "assets/files/bgm.mp3")),
      });
      const variants = manager.getAssetState(address).variants!;
      const [id, original] = Object.entries(variants).find(([, v]) => v.status === "accepted")!;
      original.status = "dismissed";
      original.file = file;
      await fs.writeFile(path.join(source, file), "original");
      writeDefinitionSnapshot(source, address, id, {
        kind: "file",
        type: "image",
        path: file,
        deterministic: true,
      });
      const patchId = manager.reserveVariantId(address);
      const output = path.join(variantDir(source, address, patchId), "output.png");
      await fs.mkdir(path.dirname(output), { recursive: true });
      await fs.writeFile(output, "patched");
      Object.assign(variants[patchId]!, {
        status: "accepted",
        file: path.relative(source, output),
        derivedFrom: id,
        patchHash: "patch",
        outputHash: await hashFile(output),
      });
    });
    await run(["video", "copy", "original", "alternate", "--through", "reference"], workspace);
    const destination = path.join(workspace, "videos/alternate");
    const definitions = await loadStageDefinitions(destination);
    const manager = await StateManager.load(destination);
    const [id, variant] = Object.entries(manager.getAssetState(address).variants!)[0]!;
    expect(variant.file).toBe(file);
    expect(await fs.readFile(path.join(destination, file), "utf8")).toBe("patched");
    expect(readDefinitionSnapshot(destination, address, id)?.kind).toBe("file");
    await syncFileAssets({ reference: definitions.reference }, manager, { validate: true });
    expect(manager.getAssetState(address).variants![id]!.status).toBe("accepted");
    expect(Object.keys(manager.getAssetState(address).variants!)).toEqual([id]);
  });

  it.each([false, true])(
    "refuses conflicting accepted outputs sharing one authored file (reverse: %s)",
    async (reverse) => {
      await StateManager.withLock(source, async (manager) => {
        const state = manager.getState();
        state.assets = {};
        const file = "assets/files/shared.png";
        await fs.writeFile(path.join(source, file), "original");
        const originalId = manager.reserveVariantId("reference:patched");
        Object.assign(manager.getAssetState("reference:patched").variants![originalId]!, {
          status: "dismissed",
          file,
        });
        const patchId = manager.reserveVariantId("reference:patched");
        const output = path.join(variantDir(source, "reference:patched", patchId), "output.png");
        await fs.mkdir(path.dirname(output), { recursive: true });
        await fs.writeFile(output, "patched");
        Object.assign(manager.getAssetState("reference:patched").variants![patchId]!, {
          status: "accepted",
          file: path.relative(source, output),
          derivedFrom: originalId,
        });
        const sharedId = manager.reserveVariantId("reference:shared");
        Object.assign(manager.getAssetState("reference:shared").variants![sharedId]!, {
          status: "accepted",
          file,
        });
        if (reverse) state.assets = Object.fromEntries(Object.entries(state.assets).reverse());
      });
      await expect(
        run(["video", "copy", "original", "alternate", "--through", "reference"], workspace),
      ).rejects.toMatchObject({
        stderr: expect.stringContaining("Accepted assets have different outputs"),
      });
      await expect(fs.access(path.join(workspace, "videos/alternate"))).rejects.toThrow();
      expect(await readCurrentVideo(workspace)).toBe("original");
      expect(await fs.readFile(path.join(source, "assets/files/shared.png"), "utf8")).toBe(
        "original",
      );
    },
  );

  it("rolls back a copy with missing accepted media and keeps the original current", async () => {
    const state = (await StateManager.load(source)).getState();
    const accepted = Object.values(state.assets["reference:character"]!.variants!).find(
      (v) => v.status === "accepted",
    )!;
    await fs.rm(path.join(source, accepted.file!));
    await expect(
      run(["video", "copy", "original", "alternate", "--through", "reference"], workspace),
    ).rejects.toMatchObject({ stderr: expect.stringContaining("VIDEO_COPY_FAILED") });
    await expect(fs.access(path.join(workspace, "videos/alternate"))).rejects.toThrow();
    expect(await readCurrentVideo(workspace)).toBe("original");
  });

  it("refuses invalid stages, names and existing destinations", async () => {
    await expect(
      run(["video", "copy", "missing", "alternate", "--through", "direction"], workspace),
    ).rejects.toMatchObject({ stderr: expect.stringContaining("VIDEO_NOT_FOUND") });
    await expect(
      run(["video", "copy", "../escape", "alternate", "--through", "direction"], workspace),
    ).rejects.toMatchObject({ stderr: expect.stringContaining("VIDEO_NOT_FOUND") });
    await expect(
      run(["video", "copy", "original", "alternate", "--through", "reference,video"], workspace),
    ).rejects.toMatchObject({ stderr: expect.stringContaining("INVALID_OPTION") });
    await expect(
      run(["video", "copy", "original", "../escape", "--through", "direction"], workspace),
    ).rejects.toMatchObject({ stderr: expect.stringContaining("INVALID_VIDEO_NAME") });
    await expect(
      run(["video", "copy", "original", "original", "--through", "direction"], workspace),
    ).rejects.toMatchObject({ stderr: expect.stringContaining("VIDEO_ALREADY_EXISTS") });
    expect(await readCurrentVideo(workspace)).toBe("original");
  });

  it("copies an explicit source without a current video", async () => {
    await fs.rm(path.join(workspace, ".konte/current-video"));
    await run(["video", "copy", "original", "alternate", "--through", "direction"], workspace);
    expect(await readCurrentVideo(workspace)).toBe("alternate");
  });
});
