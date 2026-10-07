import * as fs from "node:fs/promises";
import * as path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { definitionHashForAddress } from "../../core/composition-resource.js";
import { computeDefinitionHash } from "../../core/definition-hash.js";
import { JobManager } from "../../core/job-manager.js";
import {
  loadVideoDefinition,
  reloadReferenceDefinition,
  reloadVideoDefinition,
} from "../../core/loader.js";
import { loadPatch } from "../../core/patch.js";
import { StateManager } from "../../core/state/manager.js";
import { assetDir } from "../../core/variant-dir.js";
import {
  initWithDepsVideo,
  readFeedback,
  run,
  seedFeedback,
  TEST_VIDEO_WITH_DEPS_TSX,
  useTempWorkspace,
} from "./cli-fixtures.js";
import { generateSource, initPatchProject, patchedVariants, writePatch } from "./patch-fixtures.js";

vi.setConfig({ testTimeout: 15000 });

useTempWorkspace();

const VIDEO_TSX = TEST_VIDEO_WITH_DEPS_TSX.replace(
  "import { Composition,",
  "import { Composition, Video,",
).replace(
  "<Composition><div /></Composition>",
  "<Composition><Video src={motion} /></Composition>",
);
const RENAMED_TSX = VIDEO_TSX.replace('asset("motion"', 'asset("take"');

const from = "video:shot.01.motion";
const to = "video:shot.01.take";
const consumer = "video:shot.01.final";
const composition = "video:shot.01#composition";

describe("rename command", () => {
  let projectDir: string;
  let take: string;
  let consumerTake: string;
  let compositionTake: string;

  beforeEach(async () => {
    projectDir = await initWithDepsVideo();
    const videoFile = path.join(projectDir, "video.tsx");
    await fs.writeFile(videoFile, VIDEO_TSX);
    const video = await loadVideoDefinition(videoFile);

    const sm = await StateManager.load(projectDir);
    take = sm.reserveVariantId(from);
    const file = path.join(path.relative(projectDir, assetDir(projectDir, from)), take, "out.mp4");
    await fs.mkdir(path.dirname(path.join(projectDir, file)), { recursive: true });
    await fs.writeFile(path.join(projectDir, file), "take");
    sm.getAssetState(from).variants![take]!.file = file;
    sm.setAccepted(from, take);

    consumerTake = sm.reserveVariantId(consumer);
    const consumerVariant = sm.getAssetState(consumer).variants![consumerTake]!;
    consumerVariant.file = "/tmp/final.mp4";
    consumerVariant.definitionHash = definitionHashForAddress(video, consumer);
    consumerVariant.inputFingerprints = { [from]: "h-take" };

    compositionTake = sm.reserveVariantId(composition);
    const compositionVariant = sm.getAssetState(composition).variants![compositionTake]!;
    compositionVariant.definitionHash = definitionHashForAddress(video, composition);
    compositionVariant.inputFingerprints = { [from]: "h-take" };
    sm.setAccepted(composition, compositionTake);
    await sm.save();

    await seedFeedback(projectDir, from, {
      id: "f1",
      displayedVariants: { [from]: take },
      displayedDefinitionHashes: { [from]: "movement" },
      annotation: null,
      text: "keep this one",
      createdAt: new Date().toISOString(),
      createdBy: "local",
    });
    await fs.writeFile(videoFile, RENAMED_TSX);
    await reloadVideoDefinition(videoFile);
  });

  it("moves the takes, their files and the accept to the new name", async () => {
    const { stdout } = await run(["rename", from, to], projectDir);
    expect(stdout).toContain(`Renamed: ${from} → ${to} (1 take(s), accepted ${take})`);

    const sm = await StateManager.load(projectDir);
    expect(sm.tryGetAssetState(from)).toBeUndefined();
    expect(sm.getAcceptedVariant(to)).toBe(take);
    const file = sm.getAssetState(to).variants![take]!.file!;
    expect(file.startsWith(path.relative(projectDir, assetDir(projectDir, to)))).toBe(true);
    expect(await fs.readFile(path.join(projectDir, file), "utf-8")).toBe("take");
    await expect(fs.access(assetDir(projectDir, from))).rejects.toThrow();
  });

  it("keeps the takes consuming it current", async () => {
    const { stdout } = await run(["rename", from, to], projectDir);
    expect(stdout).toContain(`${consumer}: still current under the new name`);
    expect(stdout).toContain(`${composition}: still current under the new name`);

    const video = await loadVideoDefinition(path.join(projectDir, "video.tsx"));
    const sm = await StateManager.load(projectDir);
    for (const [address, id] of [
      [consumer, consumerTake],
      [composition, compositionTake],
    ] as const) {
      const variant = sm.getAssetState(address).variants![id]!;
      expect(variant.definitionHash).toBe(definitionHashForAddress(video, address));
      expect(variant.inputFingerprints).toEqual({ [to]: "h-take" });
    }
    expect(sm.getAcceptedVariant(composition)).toBe(compositionTake);
  });

  it("moves the comments on it", async () => {
    await run(["rename", from, to], projectDir);

    expect(await readFeedback(projectDir, from)).toEqual([]);
    const [entry] = await readFeedback(projectDir, to);
    expect(entry!.text).toBe("keep this one");
    expect(entry!.displayedVariants).toEqual({ [to]: take });
    expect(entry!.displayedDefinitionHashes).toEqual({ [to]: "movement" });
  });

  it("repoints the jobs that consumed it", async () => {
    const sm = await StateManager.load(projectDir);
    const file = sm.getAssetState(from).variants![take]!.file!;
    const jobs = new JobManager(projectDir);
    await jobs.createJob({
      address: consumer,
      variantId: consumerTake,
      resolvedDeps: { [from]: file },
      backendKind: "comfy",
    });
    await jobs.updateJob(consumerTake, { status: "completed" });

    await run(["rename", from, to], projectDir);

    const moved = (await StateManager.load(projectDir)).getAssetState(to).variants![take]!.file!;
    const job = await new JobManager(projectDir).getJob(consumerTake);
    expect(job.kind === "generation" && job.provenance.resolvedDependencies).toEqual({
      [to]: moved,
    });
  });

  it("repoints the files its own jobs produced", async () => {
    const sm = await StateManager.load(projectDir);
    const file = sm.getAssetState(from).variants![take]!.file!;
    const jobs = new JobManager(projectDir);
    await jobs.createJob({
      address: from,
      variantId: take,
      resolvedDeps: {},
      backendKind: "comfy",
    });
    await jobs.updateJob(take, { status: "completed", outputFiles: [file] });

    await run(["rename", from, to], projectDir);

    const moved = (await StateManager.load(projectDir)).getAssetState(to).variants![take]!.file!;
    const job = await new JobManager(projectDir).getJob(take);
    expect(job.kind === "generation" && [job.address, job.outputFiles]).toEqual([to, [moved]]);
  });

  it("refuses while a song analysis is reading it", async () => {
    await new JobManager(projectDir).putJob({
      kind: "song-analysis",
      id: "job-song-1",
      status: "queued",
      address: from,
      variantId: take,
      lang: "en",
      backendKind: "local",
      progress: null,
      error: null,
      metadata: {},
      createdAt: "2026-07-16T00:00:00.000Z",
      updatedAt: "2026-07-16T00:00:00.000Z",
      completedAt: null,
    });

    await expect(run(["rename", from, to], projectDir)).rejects.toMatchObject({
      stderr: expect.stringContaining("RENAME_JOB_ACTIVE"),
    });
  });

  it("refuses while a job is still making a take there", async () => {
    const sm = await StateManager.load(projectDir);
    const running = sm.reserveVariantId(from);
    await sm.save();
    await new JobManager(projectDir).createJob({
      address: from,
      variantId: running,
      resolvedDeps: {},
      backendKind: "comfy",
    });

    await expect(run(["rename", from, to], projectDir)).rejects.toMatchObject({
      stderr: expect.stringContaining("RENAME_JOB_ACTIVE"),
    });
  });

  it("refuses while a patch chain on one of its takes is still running", async () => {
    const step = `video:patch.${take}.patched`;
    const sm = await StateManager.load(projectDir);
    const running = sm.reserveVariantId(step);
    await sm.save();
    await new JobManager(projectDir).createJob({
      address: step,
      variantId: running,
      resolvedDeps: {},
      backendKind: "comfy",
    });

    await expect(run(["rename", from, to], projectDir)).rejects.toMatchObject({
      stderr: expect.stringContaining("RENAME_JOB_ACTIVE"),
    });
  });

  it("refuses while an export is running", async () => {
    const outDir = "dist/video/20260716T000000000";
    await new JobManager(projectDir).putJob({
      kind: "export",
      id: "job-export-1",
      status: "running",
      backendKind: "local",
      progress: null,
      error: null,
      metadata: {},
      createdAt: "2026-07-16T00:00:00.000Z",
      updatedAt: "2026-07-16T00:00:00.000Z",
      completedAt: null,
      outputDir: outDir,
      outputFile: null,
    });

    await expect(run(["rename", from, to], projectDir)).rejects.toMatchObject({
      stderr: expect.stringContaining("RENAME_JOB_ACTIVE"),
    });
  });

  it("refuses a name the stage file does not declare", async () => {
    await expect(run(["rename", from, "video:shot.01.other"], projectDir)).rejects.toMatchObject({
      stderr: expect.stringContaining("ADDRESS_NOT_FOUND"),
    });
  });

  it("refuses a name already holding takes", async () => {
    const sm = await StateManager.load(projectDir);
    sm.reserveVariantId(to);
    await sm.save();

    await expect(run(["rename", from, to], projectDir)).rejects.toMatchObject({
      stderr: expect.stringContaining("RENAME_TARGET_TAKEN"),
    });
    expect((await StateManager.load(projectDir)).getAcceptedVariant(from)).toBe(take);
  });

  it("refuses a move across stages", async () => {
    await expect(run(["rename", from, "animatic:shot.01.take"], projectDir)).rejects.toMatchObject({
      stderr: expect.stringContaining("INVALID_ADDRESS"),
    });
  });

  it("refuses a materialized leaf", async () => {
    await expect(run(["rename", composition, to], projectDir)).rejects.toMatchObject({
      stderr: expect.stringContaining("INVALID_ADDRESS"),
    });
  });
});

describe("rename command (a patched reference)", () => {
  it("moves a reference asset and keeps its patch current", async () => {
    const projectDir = await initPatchProject();
    const sourceId = await generateSource(projectDir);
    await writePatch(projectDir, sourceId);
    await run(["patch", "apply"], projectDir);
    await run(["job", "wait"], projectDir).catch(() => undefined);

    const referenceFile = path.join(projectDir, "reference.tsx");
    const source = await fs.readFile(referenceFile, "utf-8");
    await fs.writeFile(
      referenceFile,
      source
        .replace('asset("latentA"', 'asset("latentC"')
        .replace("bgm, latentA,", "bgm, latentC: latentA,"),
    );
    await reloadReferenceDefinition(referenceFile);

    const { stdout } = await run(["rename", "reference:latentA", "reference:latentC"], projectDir);
    expect(stdout).toContain("Renamed: reference:latentA → reference:latentC");
    expect(await patchedVariants(projectDir, sourceId, "reference:latentC")).toHaveLength(1);

    const apply = await run(["patch", "apply"], projectDir);
    expect(apply.stdout).not.toContain("(patch of");
  });

  it("puts everything back when a patch on a moved take will not load", async () => {
    const projectDir = await initPatchProject();
    const sourceId = await generateSource(projectDir);
    await writePatch(projectDir, sourceId, `throw new Error("broken");\n`);
    // An empty record at the new name, as a failed job registration leaves one.
    const empty = await StateManager.load(projectDir);
    empty.ensureAssetState("reference:latentC");
    await empty.save();

    const referenceFile = path.join(projectDir, "reference.tsx");
    const source = await fs.readFile(referenceFile, "utf-8");
    await fs.writeFile(
      referenceFile,
      source
        .replace('asset("latentA"', 'asset("latentC"')
        .replace("bgm, latentA,", "bgm, latentC: latentA,"),
    );
    await reloadReferenceDefinition(referenceFile);

    await expect(
      run(["rename", "reference:latentA", "reference:latentC"], projectDir),
    ).rejects.toThrow();

    const sm = await StateManager.load(projectDir);
    const file = sm.getAssetState("reference:latentA").variants![sourceId]!.file!;
    await fs.access(path.join(projectDir, file));
    expect(sm.tryGetAssetState("reference:latentC")?.variants).toEqual({});
  });

  it("carries a patch whose chain consumes the moved address", async () => {
    const projectDir = await initPatchProject();
    const sourceId = await generateSource(projectDir);
    const script = (name: string) => `import { createElement as h } from "react";
import { asset, definePatch, adapters, Image } from "konte";
export default definePatch<"image">(({ source }) => {
  const extra = asset("extra", adapters.imageResize, { image: { ...source, src: "__konte:reference:${name}__" }, width: 8, height: 8 });
  return asset("patched", adapters.jsxImage, {
    width: 32,
    height: 32,
    build: () => h("div", null, h(Image, { src: source }), h(Image, { src: extra })),
  });
});
`;
    await writePatch(projectDir, sourceId, script("latentB"));

    const sm = await StateManager.load(projectDir);
    const before = (await loadPatch(projectDir, sm.getRecordedState(), sourceId))!;
    const step = `reference:patch.${sourceId}.extra`;
    const stepTake = sm.reserveVariantId(step);
    sm.getAssetState(step).variants![stepTake]!.definitionHash = computeDefinitionHash(
      before.assets.extra!,
    );
    const patched = sm.reserveVariantId("reference:latentA");
    const patchedVariant = sm.getAssetState("reference:latentA").variants![patched]!;
    patchedVariant.derivedFrom = sourceId;
    patchedVariant.patchHash = before.patchHash;
    await sm.save();

    const referenceFile = path.join(projectDir, "reference.tsx");
    const source = await fs.readFile(referenceFile, "utf-8");
    await fs.writeFile(
      referenceFile,
      source
        .replace('asset("latentB"', 'asset("latentC"')
        .replace("latentA, latentB }", "latentA, latentC: latentB }"),
    );
    await reloadReferenceDefinition(referenceFile);
    await writePatch(projectDir, sourceId, script("latentC"));

    await run(["rename", "reference:latentB", "reference:latentC"], projectDir);

    const after = await StateManager.load(projectDir);
    const live = (await loadPatch(projectDir, after.getRecordedState(), sourceId))!;
    expect(live.patchHash).not.toBe(before.patchHash);
    expect(after.getAssetState("reference:latentA").variants![patched]!.patchHash).toBe(
      live.patchHash,
    );
    expect(after.getAssetState(step).variants![stepTake]!.definitionHash).toBe(
      computeDefinitionHash(live.assets.extra!),
    );
  });
});
