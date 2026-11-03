import * as fs from "node:fs/promises";
import * as path from "node:path";
import { JobManager } from "../../core/job-manager.js";
import { describe, expect, it, vi } from "vitest";
import { StateManager } from "../../core/state/manager.js";
import {
  ctx,
  useTempWorkspace,
  run,
  runCapture,
  initWorkspace,
  writeWorkspaceConfig,
} from "./cli-fixtures.js";

import {
  readJob,
  initRerollProject,
  rerollJobs,
  jobsByAddress,
  COMFY_REFERENCE_TS,
  initComfyRerollProject,
  expectNothingReserved,
} from "./reroll-fixtures.js";

vi.setConfig({ testTimeout: 15000 });

useTempWorkspace();

describe("reroll command", () => {
  it("refuses to reroll an asset whose backend this workspace has not configured", async () => {
    const projectDir = await initComfyRerollProject("rerollunconf", { url: "" });
    const { stderr } = await runCapture(["reroll", "reference:plate"], projectDir);
    expect(stderr).toContain("reference:plate");
    expect(stderr).toContain("comfyui.url");
    await expectNothingReserved(projectDir);
  });

  it("refuses to reroll a comfy asset whose header credential is unset", async () => {
    const inited = await initWorkspace(path.join(ctx.dir, "rerollauth"));
    const projectDir = inited.video;
    await fs.writeFile(path.join(projectDir, "reference.tsx"), COMFY_REFERENCE_TS);
    await writeWorkspaceConfig(projectDir, {
      comfy: {
        comfyui: {
          url: "http://127.0.0.1:8188",
          headers: { Authorization: "Bearer ${KONTE_TEST_ABSENT_TOKEN}" },
          autoInstallModels: false,
          autoInstallNodes: false,
        },
      },
    });

    const { stderr } = await runCapture(["reroll", "reference:plate"], projectDir);
    expect(stderr).toContain("KONTE_TEST_ABSENT_TOKEN");
    await expectNothingReserved(projectDir);
  });

  it("rerolls several addresses in one command", async () => {
    const projectDir = await initRerollProject();
    const { stdout } = await run(["reroll", "reference:latentA", "reference:latentB"], projectDir);

    expect(
      rerollJobs(stdout)
        .map((j) => j.address)
        .sort(),
    ).toEqual(["reference:latentA", "reference:latentB"]);
  });

  // The outcome and the step share the LAST line: a caller piping through `tail -1` keeps both.
  it("lands the outcome and the step on one line", async () => {
    const projectDir = await initRerollProject();
    const { stdout } = await run(["reroll", "reference:latentA", "reference:latentB"], projectDir);
    expect(stdout.trimEnd().split("\n").at(-1)).toBe(
      "2 take(s) across 2 asset(s) — run `konte job wait`",
    );
  });

  it("applies --count to each listed address", async () => {
    const projectDir = await initRerollProject();
    const { stdout } = await run(
      ["reroll", "reference:latentA", "reference:latentB", "--count", "2"],
      projectDir,
    );

    expect(rerollJobs(stdout)).toHaveLength(4);
    expect(jobsByAddress(stdout, "reference:latentA")).toHaveLength(2);
    expect(jobsByAddress(stdout, "reference:latentB")).toHaveLength(2);
  });

  // A downstream listed alongside its upstream must build on the freshly rerolled upstream, not
  // an older accepted one — so its job pins to (and waits on) the new upstream variant.
  it("pins a listed downstream asset to the freshly rerolled upstream", async () => {
    const projectDir = await initRerollProject();
    const { stdout } = await run(["reroll", "reference:latentA", "reference:keyed"], projectDir);
    const upstreamId = jobsByAddress(stdout, "reference:latentA")[0]!.variantId;
    const keyedId = jobsByAddress(stdout, "reference:keyed")[0]!.variantId;

    const job = await readJob(projectDir, keyedId);
    expect(job.dependsOnJobs).toContain(upstreamId);
    expect(job.metadata.pinnedDeps["reference:latentA"]).toBe(upstreamId);
  });

  it("waits on a dependency another run is still generating", async () => {
    const projectDir = await initRerollProject();
    const sm = await StateManager.load(projectDir);
    const inFlightId = sm.reserveVariantId("reference:latentA");
    await sm.save();
    await new JobManager(projectDir).createJob({
      address: "reference:latentA",
      variantId: inFlightId,
      resolvedDeps: {},
      backendKind: "local",
    });

    const { stdout } = await run(["reroll", "reference:keyed"], projectDir);
    const keyed = jobsByAddress(stdout, "reference:keyed")[0]!;
    expect(keyed.status).toBe("pending");
    const job = await readJob(projectDir, keyed.variantId);
    expect(job.dependsOnAssets).toContain("reference:latentA");
  });

  it("refuses a dependency nothing will produce before creating any job", async () => {
    const projectDir = await initRerollProject();
    const { stderr } = await runCapture(
      ["reroll", "reference:latentB", "reference:keyed"],
      projectDir,
    );
    expect(stderr).toContain("DEPENDENCY_NOT_RESOLVED");
    expect(stderr).toContain("reference:keyed — reference:latentA");
    expect(await new JobManager(projectDir).listJobs()).toEqual([]);
  });

  it("dedupes a repeated address", async () => {
    const projectDir = await initRerollProject();
    const { stdout } = await run(["reroll", "reference:latentA", "reference:latentA"], projectDir);
    expect(rerollJobs(stdout)).toHaveLength(1);
  });
});
