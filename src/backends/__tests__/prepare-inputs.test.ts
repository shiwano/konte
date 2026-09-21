import { describe, expect, it } from "vitest";
import { seed } from "../../core/dsl/shot-context.js";
import { KonteError } from "../../core/errors.js";
import { hasSeedPlaceholder, prepareBackendInputs } from "../prepare-inputs.js";

const DEP = "__konte:animatic:shot.01.first__";
const SEED = 12345;
const upload = async (absPath: string): Promise<string> => `https://cdn/${absPath}`;

describe("prepareBackendInputs", () => {
  it("expands a seed placeholder to the given seed and passes literals through", async () => {
    const out = await prepareBackendInputs(
      { prompt: "a cat", seed: seed(), count: 3 },
      {},
      "/proj",
      upload,
      SEED,
    );
    expect(out.prompt).toBe("a cat");
    expect(out.count).toBe(3);
    expect(out.seed).toBe(SEED);
  });

  it("reuses one seed across every placeholder occurrence", async () => {
    const out = await prepareBackendInputs(
      { a: seed(), nested: { b: seed() }, list: [seed()] },
      {},
      "/proj",
      upload,
      SEED,
    );
    expect(out.a).toBe(SEED);
    expect((out.nested as { b: unknown }).b).toBe(SEED);
    expect((out.list as unknown[])[0]).toBe(SEED);
  });

  it("uploads a resolved dependency and substitutes its URL (relative path joined to root)", async () => {
    const out = await prepareBackendInputs(
      { image: DEP },
      { "animatic:shot.01.first": "renders/first.png" },
      "/proj",
      upload,
      SEED,
    );
    expect(out.image).toBe("https://cdn//proj/renders/first.png");
  });

  it("resolves every element of an array without dropping any", async () => {
    const out = await prepareBackendInputs(
      { images: [DEP, "keep-me", seed()] },
      { "animatic:shot.01.first": "renders/first.png" },
      "/proj",
      upload,
      SEED,
    );
    const images = out.images as unknown[];
    expect(images).toHaveLength(3);
    expect(images[0]).toBe("https://cdn//proj/renders/first.png");
    expect(images[1]).toBe("keep-me");
    expect(images[2]).toBe(SEED);
  });

  it("resolves a placeholder nested under a dotted provider field", async () => {
    const out = await prepareBackendInputs(
      { audio_setting: { format: "mp3" }, refs: { primary: DEP } },
      { "animatic:shot.01.first": "renders/first.png" },
      "/proj",
      upload,
      SEED,
    );
    expect(out.audio_setting).toEqual({ format: "mp3" });
    expect((out.refs as { primary: unknown }).primary).toBe("https://cdn//proj/renders/first.png");
  });

  it("refuses to upload a dependency that resolves outside the video", async () => {
    // state records a video-relative path, but this is the boundary that ships the bytes to a
    // cloud vendor — so it re-checks containment rather than trusting what was recorded.
    await expect(
      prepareBackendInputs(
        { image: DEP },
        { "animatic:shot.01.first": "../../konte.credentials.json" },
        "/proj",
        upload,
        SEED,
      ),
    ).rejects.toMatchObject({ code: "INVALID_REFERENCE" });
  });

  it("passes a non-plain object (custom toJSON) through untouched instead of flattening to {}", async () => {
    const when = new Date(0);
    const out = await prepareBackendInputs({ when }, {}, "/proj", upload, SEED);
    expect(out.when).toBe(when);
  });

  it("throws DEPENDENCY_NOT_RESOLVED for an unresolved placeholder nested in an object", async () => {
    await expect(
      prepareBackendInputs({ refs: { primary: DEP } }, {}, "/proj", upload, SEED),
    ).rejects.toMatchObject({ code: "DEPENDENCY_NOT_RESOLVED" });
  });

  it("throws DEPENDENCY_NOT_RESOLVED for an unresolved scalar placeholder", async () => {
    await expect(
      prepareBackendInputs({ image: DEP }, {}, "/proj", upload, SEED),
    ).rejects.toMatchObject({
      code: "DEPENDENCY_NOT_RESOLVED",
    });
  });

  it("throws DEPENDENCY_NOT_RESOLVED for an unresolved array element (never silently dropped)", async () => {
    const err = await prepareBackendInputs({ images: [DEP] }, {}, "/proj", upload, SEED).catch(
      (e) => e as KonteError,
    );
    expect(err).toBeInstanceOf(KonteError);
    expect(err.code).toBe("DEPENDENCY_NOT_RESOLVED");
  });
});

describe("hasSeedPlaceholder", () => {
  it("detects a seed placeholder at any depth", () => {
    expect(hasSeedPlaceholder({ seed: seed() })).toBe(true);
    expect(hasSeedPlaceholder({ nested: { s: seed() } })).toBe(true);
    expect(hasSeedPlaceholder({ list: ["x", seed()] })).toBe(true);
  });

  it("returns false when no seed placeholder is present", () => {
    expect(hasSeedPlaceholder({ prompt: "a cat", image: DEP, count: 3 })).toBe(false);
    expect(hasSeedPlaceholder({})).toBe(false);
  });
});
