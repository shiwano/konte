import * as fs from "node:fs/promises";
import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { StateManager } from "../../core/state/manager.js";
import { useTempWorkspace, run } from "./cli-fixtures.js";

import {
  REROLL_REFERENCE_TS,
  initRerollProject,
  rerollJobs,
  jobsByAddress,
  acceptFresh,
} from "./reroll-fixtures.js";

vi.setConfig({ testTimeout: 15000 });

useTempWorkspace();

describe("reroll command", () => {
  it("keeps the accept of a rerolled asset, without a confirmation", async () => {
    const projectDir = await initRerollProject();
    const oldVid = await acceptFresh(projectDir, "reference:latentA");

    const { stdout } = await run(["reroll", "reference:latentA"], projectDir);
    const [job] = rerollJobs(stdout);

    const sm = await StateManager.load(projectDir);
    expect(sm.getAcceptedVariant("reference:latentA")).toBe(oldVid);
    expect(sm.getAssetState("reference:latentA").variants![job!.variantId]!.status).toBe("none");
  });

  it("stops --with-dependents at an accepted dependent and keeps both accepts", async () => {
    const projectDir = await initRerollProject();
    const latentA = await acceptFresh(projectDir, "reference:latentA");
    const keyed = await acceptFresh(projectDir, "reference:keyed");

    const { stdout } = await run(["reroll", "reference:latentA", "--with-dependents"], projectDir);
    expect(jobsByAddress(stdout, "reference:keyed")).toHaveLength(0);

    const sm = await StateManager.load(projectDir);
    expect(sm.getAcceptedVariant("reference:latentA")).toBe(latentA);
    expect(sm.getAcceptedVariant("reference:keyed")).toBe(keyed);
  });

  it("skips an accepted asset reached through a scope", async () => {
    const projectDir = await initRerollProject();
    const latentA = await acceptFresh(projectDir, "reference:latentA");
    await acceptFresh(projectDir, "reference:keyed");

    const { stdout } = await run(["reroll", "reference", "--yes"], projectDir);
    expect(rerollJobs(stdout).map((j) => j.address)).toEqual(["reference:latentB"]);

    const sm = await StateManager.load(projectDir);
    expect(sm.getAcceptedVariant("reference:latentA")).toBe(latentA);
  });

  it("fails a listed dependent once its upstream's take fails", async () => {
    const projectDir = await initRerollProject();
    const badReference = REROLL_REFERENCE_TS.replace(
      "  return { character, bgm, latentA, latentB, keyed, derived };",
      `  const badSrc = asset("badSrc", adapters.imageFile, { path: "assets/files/bad.png" });
  const badResize = asset("badResize", internalTestImage, { image: badSrc, width: 32, height: 32 });
  const badChild = asset("badChild", internalTestImage, { image: badResize, width: 16, height: 16 });
  return { character, bgm, latentA, latentB, keyed, derived, badSrc, badResize, badChild };`,
    );
    await fs.writeFile(path.join(projectDir, "reference.tsx"), badReference);
    await fs.mkdir(path.join(projectDir, "assets", "files"), { recursive: true });
    await fs.writeFile(path.join(projectDir, "assets", "files", "bad.png"), "not a real png");

    await run(["reroll", "reference:badResize", "reference:badChild", "--yes"], projectDir);
    const err = (await run(["job", "run"], projectDir).catch((e) => e)) as {
      code: number;
      stdout: string;
    };
    expect(err.code).toBe(1);
    expect(err.stdout).toMatch(/reference:badChild \(v-\S+\): failed\n {2}Error: Prerequisite/);
  });

  // Validation runs over every listed address before any job is created, so one bad address
  // aborts the whole command rather than half-rerolling.
  it("rejects a file asset listed among rerollable ones", async () => {
    const projectDir = await initRerollProject();
    await expect(
      run(["reroll", "reference:latentA", "reference:character"], projectDir),
    ).rejects.toMatchObject({ stderr: expect.stringContaining("INVALID_ASSET_TYPE") });
  });

  // A deterministic op has no second take to pick, so reroll names the command that does replace it
  // instead.
  it("refuses a deterministic asset", async () => {
    const projectDir = await initRerollProject();
    const err = (await run(["reroll", "reference:derived"], projectDir).catch((e) => e)) as {
      stderr: string;
    };
    expect(err.stderr).toContain("DETERMINISTIC_NOT_REROLLABLE");
    expect(err.stderr).toContain("konte generate reference");
  });

  // ...but a cascade still rebuilds one, beside its accept.
  it("rebuilds a collected deterministic dependent beside its accept", async () => {
    const projectDir = await initRerollProject();
    const derived = await acceptFresh(projectDir, "reference:derived");

    const { stdout } = await run(["reroll", "reference:latentA", "--with-dependents"], projectDir);
    expect(jobsByAddress(stdout, "reference:derived")).toHaveLength(1);

    const sm = await StateManager.load(projectDir);
    expect(sm.getAcceptedVariant("reference:derived")).toBe(derived);
  });

  // A take that fails in the worker (here: ffmpeg choking on a non-image "bad.png") is surfaced by
  // the run with a non-zero exit.
  it("reports a failed reroll take on the run", async () => {
    const projectDir = await initRerollProject();
    const badReference = REROLL_REFERENCE_TS.replace(
      "  return { character, bgm, latentA, latentB, keyed, derived };",
      `  const badSrc = asset("badSrc", adapters.imageFile, { path: "assets/files/bad.png" });
  const badResize = asset("badResize", internalTestImage, { image: badSrc, width: 32, height: 32 });
  return { character, bgm, latentA, latentB, keyed, derived, badSrc, badResize };`,
    );
    await fs.writeFile(path.join(projectDir, "reference.tsx"), badReference);
    await fs.mkdir(path.join(projectDir, "assets", "files"), { recursive: true });
    await fs.writeFile(path.join(projectDir, "assets", "files", "bad.png"), "not a real png");

    await run(["reroll", "reference:badResize"], projectDir);
    const err = (await run(["job", "run"], projectDir).catch((e) => e)) as {
      code: number;
      stdout: string;
    };
    expect(err.code).toBe(1);
    expect(err.stdout).toMatch(/^Job reference:badResize \(v-\S+\): failed$/m);
    expect(err.stdout).toContain("1 failed");
  });
});
