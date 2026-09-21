import * as fs from "node:fs/promises";
import * as path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { StateManager } from "../../core/state/manager.js";
import {
  acceptDirection,
  acceptFileAssets,
  ctx,
  useTempWorkspace,
  initWithTestVideo,
  TEST_VIDEO_TSX,
  TEST_VIDEO_WITH_UNUSED_TSX,
  TEST_VIDEO_WITH_PENDING_TSX,
  TEST_VIDEO_ALL_PENDING_TSX,
  TEST_ANIMATIC_WITH_PENDING_TS,
  TEST_EMPTY_ANIMATIC_TSX,
  TEST_CROSS_STAGE_ANIMATIC_TS,
  TEST_CROSS_STAGE_VIDEO_TSX,
  run,
  runCapture,
  initWorkspace,
  seedFeedback,
} from "./cli-fixtures.js";
import { FeedbackManager, generateFeedbackId } from "../../core/feedback/index.js";
import { directionPartHashes } from "../../core/direction-hash.js";
import { JobManager } from "../../core/job-manager.js";
import { loadDirectionIfPresent } from "../load-definition.js";
import { panelMoveHashes } from "../../core/panel-move-hash.js";

vi.setConfig({ testTimeout: 15000 });

useTempWorkspace();

describe("status command", () => {
  let projectDir: string;

  beforeEach(async () => {
    projectDir = await initWithTestVideo();
  });

  it("outputs sections", async () => {
    const { stdout } = await run(["status"], projectDir);
    expect(stdout).toContain("Progress:");
    expect(stdout).toMatch(/video: 0\/2 accepted/);
    // The readiness line counts; it does not name what `konte generate video` would act on.
    expect(stdout).toContain("2 not generated");
    expect(stdout).not.toContain("shot.01.motion");
  });

  // What the human wrote in the review is the input Next steps had no way to see. It points at the
  // words and stops: which fix a comment needs is not something the fact of one can decide.
  it("points a standing comment at the listing, and names no fix for it", async () => {
    const address = "reference:studio";
    const sm = await StateManager.load(projectDir);
    const variantId = sm.reserveVariantId(address);
    sm.getAssetState(address).variants![variantId]!.file = "/tmp/studio.png";
    sm.setAccepted(address, variantId);
    await sm.save();
    const acceptedAt = sm.getAssetState(address).variants![variantId]!.decidedAt!;
    await seedFeedback(projectDir, address, {
      id: generateFeedbackId(),
      displayedVariants: { [address]: variantId },
      annotation: { kind: "pin", x: 0.35, y: 0.55 },
      text: "座りながら眠っていたのでは？",
      // Written after the accept: that is how a reviewer asks for work on a take already signed
      // off, and the one way a comment stands against an accepted one. Offset from the recorded
      // stamp, not the clock, which can step backwards mid-test.
      createdAt: new Date(Date.parse(acceptedAt) + 1_000).toISOString(),
      createdBy: "local",
    });

    const { stdout } = await run(["status"], projectDir);
    expect(stdout).toContain("konte review feedback list");
    expect(stdout).toContain("1 address carries a comment");
    expect(stdout).not.toContain("konte patch new");
    expect(stdout).not.toContain(`konte reroll ${address}`);
  });

  // A comment whose take moved under it has already been answered by whatever moved it.
  it("stops routing a comment once its take is superseded", async () => {
    const address = "reference:studio";
    const sm = await StateManager.load(projectDir);
    const first = sm.reserveVariantId(address);
    sm.getAssetState(address).variants![first]!.file = "/tmp/studio-1.png";
    await sm.save();
    await seedFeedback(projectDir, address, {
      id: generateFeedbackId(),
      displayedVariants: { [address]: first },
      annotation: null,
      text: "too dark",
      createdAt: "2026-01-01T00:00:00.000Z",
      createdBy: "local",
    });

    const sm2 = await StateManager.load(projectDir);
    const second = sm2.reserveVariantId(address);
    sm2.getAssetState(address).variants![second]!.file = "/tmp/studio-2.png";
    sm2.setAccepted(address, second);
    await sm2.save();

    const { stdout } = await run(["status"], projectDir);
    expect(stdout).not.toContain("carries a comment");
    expect(stdout).not.toContain("konte patch new");
  });

  // Accepting with a comment standing is the reviewer going with the take as it is — there is no
  // "reject", so the accept is the verdict and the comment stays as a note on the record.
  it("stops routing a comment the reviewer accepted over", async () => {
    const address = "reference:studio";
    const sm = await StateManager.load(projectDir);
    const variantId = sm.reserveVariantId(address);
    sm.getAssetState(address).variants![variantId]!.file = "/tmp/studio.png";
    await sm.save();
    await seedFeedback(projectDir, address, {
      id: generateFeedbackId(),
      displayedVariants: { [address]: variantId },
      annotation: null,
      text: "手前の小物が気になる",
      createdAt: "2026-01-01T00:00:00.000Z",
      createdBy: "local",
    });

    const { stdout: before } = await run(["status"], projectDir);
    expect(before).toContain("1 address carries a comment");

    // The accept lands after the comment — the same order a review submits them in.
    const sm2 = await StateManager.load(projectDir);
    sm2.setAccepted(address, variantId);
    await sm2.save();

    const { stdout } = await run(["status"], projectDir);
    expect(stdout).not.toContain("carries a comment");
    expect(stdout).not.toContain("konte patch new");
  });

  // A direction comment has no take: its subject is its part's content hash, so judging one means
  // loading direction.ts. `status` did not, which left every direction comment reading as still
  // standing however far the direction had moved under it.
  it("stops routing a direction comment once the part it stands on is rewritten", async () => {
    await acceptDirection(projectDir);
    const address = "direction:brief.logline";
    const direction = await loadDirectionIfPresent(projectDir);
    const subjectHash = directionPartHashes(direction!).get(address);
    const comment = {
      id: generateFeedbackId(),
      displayedVariants: {},
      annotation: null,
      text: "ログラインが弱い",
      createdAt: new Date().toISOString(),
      createdBy: "local",
    };
    await seedFeedback(projectDir, address, { ...comment, subjectHash });

    const { stdout: before } = await run(["status"], projectDir);
    expect(before).toContain("1 address carries a comment");

    // The same comment, now standing against words the direction no longer says.
    await FeedbackManager.withLock(projectDir, "direction", async (m) => {
      m.removeFeedback(address, comment.id);
      m.addFeedback(address, { ...comment, subjectHash: "0123456789ab" });
    });

    const { stdout } = await run(["status"], projectDir);
    expect(stdout).not.toContain("carries a comment");
  });

  // The other way a comment gets answered: a fix the take never sees. `blocking` feeds no
  // generation, so rewriting it leaves every hash a variant carries untouched — the panel's own
  // movement hash is the only thing that moves.
  //
  // The rewrite is staged as the hash the comment recorded rather than as an edit to animatic.tsx:
  // this harness runs the CLI in-process, so a definition re-read within one test is served from the
  // module registry.
  describe("board movement", () => {
    const address = "animatic:shot.01.keyframe";
    const OTHER_WORDS = "0123456789ab";

    async function acceptedPanel(): Promise<{
      variantId: string;
      moveHash: string;
      acceptedAt: string;
    }> {
      await fs.writeFile(path.join(projectDir, "animatic.tsx"), TEST_CROSS_STAGE_ANIMATIC_TS);
      await fs.writeFile(path.join(projectDir, "video.tsx"), TEST_CROSS_STAGE_VIDEO_TSX);
      // Next steps holds every board suggestion back while the direction is unaccepted, comment
      // routes included — so the gate has to be open for any of this to be visible.
      await acceptDirection(projectDir);
      const sm = await StateManager.load(projectDir);
      const variantId = sm.reserveVariantId(address);
      sm.getAssetState(address).variants![variantId]!.file = "/tmp/keyframe.png";
      await sm.save();
      await run(["accept", variantId, "--yes"], projectDir);
      // The live movement, hashed off the same prose animatic.tsx declares.
      const moveHash = panelMoveHashes({
        stage: "animatic" as const,
        typography: { lang: "en" as const },
        format: { size: { width: 1280, height: 720 }, fps: 30 },
        shots: [
          {
            id: "01",
            duration: 5,
            action: "test shot",
            assets: {},
            panels: [
              {
                assetName: "keyframe",
                assetPath: address,
                blocking: "the cat rises to sit",
                camera: "fixed",
                start: 0,
                duration: 1,
              },
            ],
          },
        ],
      }).get(address)!;
      // …and the shot itself, so the board is settled end to end: the leaf's own first review is a
      // real ask, and leaving it open would drown out what these cases are about.
      await run(["accept", "animatic:shot.01#composition", "--yes"], projectDir);
      const acceptedAt = (await StateManager.load(projectDir)).getAssetState(address).variants![
        variantId
      ]!.decidedAt!;
      return { variantId, moveHash, acceptedAt };
    }

    it("stops routing a comment once the movement it asked for is written", async () => {
      const { variantId, moveHash, acceptedAt } = await acceptedPanel();
      const comment = {
        id: generateFeedbackId(),
        displayedVariants: { [address]: variantId },
        annotation: null,
        text: "もっと動きが欲しい",
        // After the accept, so it is the movement — not the sign-off — that answers it. Offset
        // from the recorded stamp, not the clock, which can step backwards mid-test.
        createdAt: new Date(Date.parse(acceptedAt) + 1_000).toISOString(),
        createdBy: "local",
      };
      await seedFeedback(projectDir, address, {
        ...comment,
        displayedDefinitionHashes: { [address]: moveHash },
      });

      const { stdout: before } = await run(["status"], projectDir);
      expect(before).toContain("1 address carries a comment");

      // The same comment, now standing against words the board no longer says.
      await FeedbackManager.withLock(projectDir, "animatic", async (m) => {
        m.removeFeedback(address, comment.id);
        m.addFeedback(address, {
          ...comment,
          displayedDefinitionHashes: { [address]: OTHER_WORDS },
        });
      });

      const { stdout } = await run(["status"], projectDir);
      expect(stdout).not.toContain("carries a comment");
      expect(stdout).not.toContain("konte patch new");
    });
  });

  it("prints Next steps above the sections, so a truncated read keeps it", async () => {
    const sm = await StateManager.load(projectDir);
    for (const address of ["video:shot.01.motion", "video:shot.02.motion"]) {
      const v = sm.reserveVariantId(address);
      sm.getAssetState(address).variants![v]!.file = `/tmp/${v}.mp4`;
    }
    await sm.save();

    const { stdout } = await run(["status", "-v"], projectDir);
    const next = stdout.indexOf("Next steps:");
    const section = stdout.indexOf("Needs review:");
    expect(next).toBeGreaterThan(-1);
    expect(section).toBeGreaterThan(-1);
    expect(next).toBeLessThan(section);
    // The block a caller runs has to survive `konte status | head -N`, so it is bounded by
    // Progress alone — one line per stage — not by however many sections follow.
    expect(stdout.slice(0, next).split("\n").length).toBeLessThan(15);
  });

  // status is read in a loop, so the default carries only what changes what the reader does next.
  it("keeps the sections behind -v, with Next steps naming each state they hold", async () => {
    const sm = await StateManager.load(projectDir);
    // A take awaiting review — the whole section becomes `konte preview video`.
    const reviewable = "video:shot.01.motion";
    const v = sm.reserveVariantId(reviewable);
    sm.getAssetState(reviewable).variants![v]!.file = `/tmp/${v}.mp4`;
    // A variant with no file and no job — "Problems", which `clean` takes.
    sm.reserveVariantId("video:shot.01.voice");
    await sm.save();

    const { stdout } = await run(["status"], projectDir);
    expect(stdout).toContain("konte preview video");
    expect(stdout).toContain("konte clean video:shot.01.voice");
    expect(stdout).not.toContain("Needs review:");
    expect(stdout).not.toContain("Problems:");
    expect(stdout).not.toContain(reviewable);
    expect(stdout).not.toContain("no file, no active job");

    const { stdout: verbose } = await run(["status", "-v"], projectDir);
    expect(verbose).toContain("Needs review: 1");
    expect(verbose).toContain(reviewable);
    expect(verbose).toContain("Problems: 1");
    expect(verbose).toContain("no file, no active job");
  });

  // The two "Problems" entries with no variant behind them.
  it("offers a cancel for an orphan job, which prune refuses to touch", async () => {
    const jobManager = new JobManager(projectDir);
    // In flight, and its variant never reached state: exactly what `prune` skips as active.
    await jobManager.createJob({
      address: "video:shot.01.motion",
      variantId: "v-orphan01",
      resolvedDeps: {},
      backendKind: "comfy",
    });

    const { stdout } = await run(["status"], projectDir);
    expect(stdout).toContain("konte job cancel v-orphan01");
    expect(stdout).not.toContain("konte prune");
  });

  it("points a failed model download at its log", async () => {
    const jobManager = new JobManager(projectDir);
    const { id } = await jobManager.ensureComfyModelDownloadJob({
      type: "checkpoint",
      filename: "nonexistent.safetensors",
      url: "http://127.0.0.1:9/nonexistent.safetensors",
    });
    await jobManager.updateJob(id, {
      status: "failed",
      error: "HTTP 403 Forbidden",
      completedAt: new Date().toISOString(),
    });

    const { stdout } = await run(["status"], projectDir);
    expect(stdout).toContain(`konte job logs ${id}`);
  });

  // An activate job's id derives from the packs it activates, so a re-run reuses the record rather
  // than leaving an earlier run's failure standing beside it. What remains is one live job per pack
  // set, and every one of those failures is current — none is an older run's ghost.
  it("reports a node-activate failure per pack set, and drops one a re-run reset", async () => {
    const jobManager = new JobManager(projectDir);
    const one = await jobManager.ensureComfyNodeActivateJob({
      dependsOnJobs: [],
      cnrIds: ["pack-a"],
    });
    const two = await jobManager.ensureComfyNodeActivateJob({
      dependsOnJobs: [],
      cnrIds: ["pack-b"],
    });
    for (const { id } of [one, two]) {
      await jobManager.updateJob(id, {
        status: "failed",
        error: "reboot timed out",
        completedAt: new Date().toISOString(),
      });
    }

    const bothFailed = await run(["status"], projectDir);
    expect(bothFailed.stdout).toContain(`konte job logs ${one.id}`);
    expect(bothFailed.stdout).toContain(`konte job logs ${two.id}`);

    // A later run re-ensures pack-a's job, which resets the failure to pending — the same record,
    // so nothing is left behind to report.
    const reran = await jobManager.ensureComfyNodeActivateJob({
      dependsOnJobs: [],
      cnrIds: ["pack-a"],
    });
    expect(reran).toMatchObject({ id: one.id, created: false, reset: true });

    const afterRerun = await run(["status"], projectDir);
    expect(afterRerun.stdout).not.toContain(`konte job logs ${one.id}`);
    expect(afterRerun.stdout).toContain(`konte job logs ${two.id}`);
  });

  const ADDRESS = "video:shot.01.motion";
  const UPSTREAM = "video:shot.01.voice";

  // Merged into `seedStaleAccept` to age the accept by its definition instead of its input.
  const DEFINITION_STALE = { definitionHash: "before-the-edit", inputFingerprints: {} };

  // An accepted take at ADDRESS whose recorded fingerprint for UPSTREAM no longer matches what
  // that address resolves to — input-stale, the one axis a bare state fixture can produce.
  // `extra` is merged into the stale accept (e.g. `derivedFrom` to make it a patch output).
  async function seedStaleAccept(extra: Record<string, unknown> = {}): Promise<StateManager> {
    const sm = await StateManager.load(projectDir);
    const up = sm.reserveVariantId(UPSTREAM);
    Object.assign(sm.getAssetState(UPSTREAM).variants![up]!, {
      status: "accepted",
      file: "/tmp/voice.wav",
      outputHash: "current-hash",
    });
    const accepted = sm.reserveVariantId(ADDRESS);
    Object.assign(sm.getAssetState(ADDRESS).variants![accepted]!, {
      status: "accepted",
      file: "/tmp/old.mp4",
      inputFingerprints: { [UPSTREAM]: "old-hash" },
      ...extra,
    });
    await sm.save();
    // The direction and cast gates suppress every video spend suggestion, reroll included.
    await acceptDirection(projectDir);
    await acceptFileAssets(projectDir);
    return sm;
  }

  // The blind spot "Needs regenerate" closes: a take nobody accepted, whose input has since moved,
  // is neither a review candidate nor a stale ACCEPT — so status named it nowhere while `generate`
  // still had it on its work list.
  it("names a stale unaccepted take, and offers the generate that replaces it", async () => {
    const sm = await StateManager.load(projectDir);
    const up = sm.reserveVariantId(UPSTREAM);
    Object.assign(sm.getAssetState(UPSTREAM).variants![up]!, {
      status: "accepted",
      file: "/tmp/voice.wav",
      outputHash: "current-hash",
    });
    const stale = sm.reserveVariantId(ADDRESS);
    Object.assign(sm.getAssetState(ADDRESS).variants![stale]!, {
      file: "/tmp/old.mp4",
      inputFingerprints: { [UPSTREAM]: "old-hash" },
    });
    await sm.save();
    await acceptDirection(projectDir);
    await acceptFileAssets(projectDir);

    const { stdout } = await run(["status", "-v"], projectDir);
    expect(stdout).toContain("Needs regenerate");
    expect(stdout).toMatch(new RegExp(`${ADDRESS}\\s+input-stale: ${UPSTREAM}`));
    expect(stdout).toContain("konte generate video");
    // Not something to review: `generate` is about to throw this take away.
    expect(
      stdout.slice(stdout.indexOf("Needs review"), stdout.indexOf("Needs regenerate")),
    ).not.toContain(ADDRESS);
  });

  // A partly accepted stage printed its accept/generate ratio alone, so an accepted take whose
  // input had moved read as finished work on the one line the loop reads.
  it("counts stale accepts on a partly accepted Progress line", async () => {
    const sm = await seedStaleAccept(DEFINITION_STALE);
    // Leave the upstream unaccepted so the stage is partly accepted.
    const up = Object.keys(sm.getAssetState(UPSTREAM).variants!)[0]!;
    sm.getAssetState(UPSTREAM).variants![up]!.status = "none";
    await sm.save();

    const { stdout } = await run(["status"], projectDir);
    expect(stdout).toMatch(/video: 1\/2 accepted \(1 stale\)/);
  });

  it("leaves an accept whose upstream alone changed standing, named nowhere", async () => {
    await seedStaleAccept();

    const { stdout } = await run(["status", "-v"], projectDir);
    expect(stdout).not.toContain("Stale:");
    expect(stdout).not.toMatch(/\(\d+ stale\)/);
    expect(stdout).not.toContain("upstream changed");
    expect(stdout).not.toContain(`konte reroll ${ADDRESS}`);
  });

  // A refreshed keyframe would leave every accepted video take built on it standing, so the cut
  // would not change.
  it("offers no refresh for an edited take whose video takes all hold an accept", async () => {
    await fs.writeFile(path.join(projectDir, "animatic.tsx"), TEST_CROSS_STAGE_ANIMATIC_TS);
    await fs.writeFile(path.join(projectDir, "video.tsx"), TEST_CROSS_STAGE_VIDEO_TSX);
    await acceptDirection(projectDir);
    await acceptFileAssets(projectDir);
    const keyframe = "animatic:shot.01.keyframe";
    const motion = "video:shot.01.motion";
    const sm = await StateManager.load(projectDir);
    const kf = sm.reserveVariantId(keyframe);
    Object.assign(sm.getAssetState(keyframe).variants![kf]!, {
      status: "accepted",
      file: "/tmp/keyframe.png",
      ...DEFINITION_STALE,
    });
    await sm.save();

    const { stdout: before } = await run(["status"], projectDir);
    expect(before).toContain(`konte reroll ${keyframe}`);
    expect(before).toMatch(/animatic: all 1 accepted \(1 stale\)/);

    const mv = sm.reserveVariantId(motion);
    Object.assign(sm.getAssetState(motion).variants![mv]!, {
      status: "accepted",
      file: "/tmp/motion.mp4",
    });
    await sm.save();

    const { stdout } = await run(["status", "-v"], projectDir);
    expect(stdout).not.toContain(`konte reroll ${keyframe}`);
    expect(stdout).not.toMatch(/\(\d+ stale\)/);
    expect(stdout).not.toContain("Stale:");
  });

  // The loop reads status while jobs run. A refresh already in flight is not work to name again.
  it("does not offer a reroll while one is already running for that address", async () => {
    const sm = await seedStaleAccept(DEFINITION_STALE);

    const { stdout: before } = await run(["status"], projectDir);
    expect(before).toContain(`konte reroll ${ADDRESS}`);

    const running = sm.reserveVariantId(ADDRESS);
    await sm.save();
    const jobManager = new JobManager(projectDir);
    await jobManager.createJob({
      address: ADDRESS,
      variantId: running,
      resolvedDeps: {},
      backendKind: "comfy",
    });
    await jobManager.updateJob(running, { status: "running" });

    const { stdout } = await run(["status"], projectDir);
    expect(stdout).not.toContain(`konte reroll ${ADDRESS}`);
  });

  // A patch output is refreshed by re-applying its correction. Rerolling the address would make a
  // fresh original take and orphan the correction — and "Pending patches" cannot be the guard,
  // since it drops a patch while its chain is in flight.
  it("does not offer a reroll for a stale take that is a patch output", async () => {
    const sm = await StateManager.load(projectDir);
    const source = sm.reserveVariantId(ADDRESS);
    Object.assign(sm.getAssetState(ADDRESS).variants![source]!, { file: "/tmp/source.mp4" });
    await sm.save();
    await seedStaleAccept({ ...DEFINITION_STALE, derivedFrom: source });

    // It really is stale — the section says so — and still no reroll is named for it.
    const { stdout: verbose } = await run(["status", "-v"], projectDir);
    expect(verbose).toContain("Stale:");
    expect(verbose).toContain(ADDRESS);

    const { stdout } = await run(["status"], projectDir);
    expect(stdout).not.toContain(`konte reroll ${ADDRESS}`);
  });

  // `konte clean` deletes the job record and its log, so the suggestion that fixes the failure is
  // also the one that erases its reason.
  it("names the log before the clean that would delete it", async () => {
    const address = "video:shot.01.motion";
    const sm = await StateManager.load(projectDir);
    const variantId = sm.reserveVariantId(address);
    await sm.save();

    const jobManager = new JobManager(projectDir);
    await jobManager.createJob({ address, variantId, resolvedDeps: {}, backendKind: "comfy" });
    await jobManager.updateJob(variantId, {
      status: "failed",
      error: "backend refused the prompt",
      completedAt: new Date().toISOString(),
    });

    const { stdout } = await run(["status"], projectDir);
    const logs = stdout.indexOf(`konte job logs ${variantId}`);
    const clean = stdout.indexOf(`konte clean ${address}`);
    expect(logs).toBeGreaterThan(-1);
    expect(clean).toBeGreaterThan(-1);
    expect(logs).toBeLessThan(clean);
  });

  // The counterexample to "every hidden state has a step": a declared file that is not on disk has
  // no variant, so no `clean` reaches it.
  it("names a missing file's path, which no command can act on", async () => {
    await fs.writeFile(
      path.join(projectDir, "video.tsx"),
      TEST_VIDEO_TSX.replace(
        'const voice = asset("voice", ttsComfy, { text: "hello" });',
        'const voice = asset("voice", adapters.audioFile, { path: "assets/files/missing.wav" });',
      ).replace('defineDirection } from "konte"', 'defineDirection, adapters } from "konte"'),
    );

    const { stdout } = await run(["status"], projectDir);
    expect(stdout).toContain("add file");
    expect(stdout).toContain("assets/files/missing.wav");
    // Not the section it used to be named by — that one is `-v` only now.
    expect(stdout).not.toContain("Problems:");
  });

  it("writes neither the state nor assets/.gitignore, while still counting file assets", async () => {
    const statePath = path.join(projectDir, "konte.state.json");
    const gitignorePath = path.join(projectDir, "assets", ".gitignore");
    const before = await fs.readFile(statePath, "utf-8");
    await fs.rm(gitignorePath);

    const { stdout } = await run(["status"], projectDir);

    expect(stdout).toMatch(/\((\d+)\/\1 files\)/);
    expect(await fs.readFile(statePath, "utf-8")).toBe(before);
    await expect(fs.access(gitignorePath)).rejects.toThrow();
  });

  it("counts acceptance and what is left to generate before anything is generated", async () => {
    const { stdout } = await run(["status"], projectDir);

    expect(stdout).toMatch(/video: 0\/\d+ accepted .* 0\/\d+ generated \(\d+ not generated\)/);
  });

  it("does not report ready to export while a pendingShot remains", async () => {
    await fs.writeFile(path.join(projectDir, "video.tsx"), TEST_VIDEO_WITH_PENDING_TSX);
    const sm = await StateManager.load(projectDir);
    const address = "video:shot.01.motion";
    const v1 = sm.reserveVariantId(address);
    sm.getAssetState(address).variants![v1]!.file = "/tmp/motion-1.mp4";
    sm.setAccepted(address, v1);
    await sm.save();

    const { stdout } = await run(["status"], projectDir);
    expect(stdout).toContain("1 shot undeveloped");
    expect(stdout).not.toContain("ready to export");
  });

  it("still shows a stage line when every shot is undeveloped (no address)", async () => {
    await fs.writeFile(path.join(projectDir, "video.tsx"), TEST_VIDEO_ALL_PENDING_TSX);

    const { stdout } = await run(["status"], projectDir);
    expect(stdout).toContain("Progress:");
    expect(stdout).toMatch(/video: 2 shots undeveloped/);
    expect(stdout).not.toContain("ready to export");
  });

  it.each([false, true])(
    "surfaces the last export with undeveloped shots (noDelivery: %s)",
    async (noDelivery) => {
      await fs.writeFile(path.join(projectDir, "video.tsx"), TEST_VIDEO_ALL_PENDING_TSX);
      const outDir = "dist/video/20260716T000000000";
      await new JobManager(projectDir).putJob({
        kind: "export",
        noDelivery,
        id: "job-export-1",
        status: "completed",
        backendKind: "local",
        progress: null,
        error: null,
        metadata: {},
        createdAt: "2026-07-16T00:00:00.000Z",
        updatedAt: "2026-07-16T00:00:00.000Z",
        completedAt: "2026-07-16T00:00:00.000Z",
        outputDir: outDir,
        outputFile: `${outDir}/video.mp4`,
      });

      // The video has no address (all shots pending) — the export is scoped by the loaded video
      // definition, not by address presence, so it must not vanish.
      const { stdout } = await run(["status"], projectDir);
      expect(stdout).toContain("Last export:");
      expect(stdout).toContain(noDelivery ? "[working size]" : "[delivery]");
      if (noDelivery) expect(stdout).toContain("konte probe export");
      expect(stdout).toContain(`${outDir}/video.mp4`);
    },
  );

  it("prints the last export's path relative to cwd", async () => {
    const outDir = "dist/video/20260716T000000000";
    await new JobManager(projectDir).putJob({
      kind: "export",
      id: "job-export-1",
      status: "completed",
      backendKind: "local",
      progress: null,
      error: null,
      metadata: {},
      createdAt: "2026-07-16T00:00:00.000Z",
      updatedAt: "2026-07-16T00:00:00.000Z",
      completedAt: "2026-07-16T00:00:00.000Z",
      outputDir: outDir,
      outputFile: `${outDir}/video.mp4`,
    });

    const { stdout } = await run(["status"], path.resolve(projectDir, "../.."));
    expect(stdout).toContain(`videos/main/${outDir}/video.mp4`);
  });

  it("rejects a leftover address-scope argument (status is whole-project only)", async () => {
    await expect(run(["status", "video"], projectDir)).rejects.toThrow();
  });

  it("does not report the animatic ready to export while a pendingShot remains", async () => {
    await fs.writeFile(path.join(projectDir, "animatic.tsx"), TEST_ANIMATIC_WITH_PENDING_TS);
    await fs.writeFile(path.join(projectDir, "video.tsx"), TEST_VIDEO_WITH_PENDING_TSX);
    const sm = await StateManager.load(projectDir);
    const address = "animatic:shot.01.keyframe";
    const v1 = sm.reserveVariantId(address);
    sm.getAssetState(address).variants![v1]!.file = "/tmp/keyframe-1.png";
    sm.setAccepted(address, v1);
    await sm.save();

    const { stdout } = await run(["status"], projectDir);
    expect(stdout).toContain("all 1 accepted");
    expect(stdout).toContain("1 shot undeveloped");
    expect(stdout).not.toContain("ready to export");
  });

  it("does not report the animatic ready to export when all its panels are accepted", async () => {
    // WORK.md bug: a fully-accepted animatic read "ready to export" though only the video
    // stage has a deliverable. The animatic is a working stage — it never claims readiness.
    await fs.writeFile(path.join(projectDir, "animatic.tsx"), TEST_CROSS_STAGE_ANIMATIC_TS);
    await fs.writeFile(path.join(projectDir, "video.tsx"), TEST_CROSS_STAGE_VIDEO_TSX);
    const sm = await StateManager.load(projectDir);
    const address = "animatic:shot.01.keyframe";
    const v1 = sm.reserveVariantId(address);
    sm.getAssetState(address).variants![v1]!.file = "/tmp/keyframe-1.png";
    sm.setAccepted(address, v1);
    await sm.save();

    const { stdout } = await run(["status"], projectDir);
    expect(stdout).toContain("animatic: all 1 accepted");
    expect(stdout).not.toContain("ready to export");
  });

  it("lists an unresolved direction finding with its waiver key, agreeing with doctor", async () => {
    const directionPath = path.join(projectDir, "direction.ts");
    const source = await fs.readFile(directionPath, "utf-8");
    await fs.writeFile(directionPath, source.replace('action: "', 'action: "Stop. Go. '));

    const { stdout } = await run(["status"], projectDir);
    expect(stdout).toContain("Direction findings: 1");
    expect(stdout).toContain("[multi-sentence-action_01] (arc)");

    const { stdout: doctorOut } = await runCapture(["doctor"], projectDir);
    expect(doctorOut).toContain("[multi-sentence-action_01] (arc)");
  });

  it("surfaces a direction structural error and gates Next steps on it", async () => {
    // The board is a required entry, so it has to survive the break below.
    await fs.writeFile(path.join(projectDir, "animatic.tsx"), TEST_EMPTY_ANIMATIC_TSX, "utf-8");
    const directionPath = path.join(projectDir, "direction.ts");
    const source = await fs.readFile(directionPath, "utf-8");
    await fs.writeFile(directionPath, source.replace('id: "02"', 'id: "01"'));

    const { stdout } = await run(["status"], projectDir);
    expect(stdout).toContain("Direction errors: 1");
    expect(stdout).toContain("[duplicate-id]");
    // Next steps leads with the error rather than routing past it.
    expect(stdout).toContain("direction errors");
  });

  it("flags a stale direction waiver whose finding is gone", async () => {
    const directionPath = path.join(projectDir, "direction.ts");
    const source = await fs.readFile(directionPath, "utf-8");
    await fs.writeFile(
      directionPath,
      source.replace("waivers: {", 'waivers: {\n      "multi-sentence-action_01": "gone",'),
    );

    const { stdout } = await run(["status"], projectDir);
    expect(stdout).toContain("Stale direction waivers: 1");
    expect(stdout).toContain("[multi-sentence-action_01] gone");
  });

  it("counts the ungenerated addresses on the stage line instead of naming them", async () => {
    const inited_capped = await initWorkspace(path.join(ctx.dir, "capped"));
    const demoDir = inited_capped.video;

    const { stdout } = await run(["status"], demoDir);
    expect(stdout).toMatch(/animatic: .*\d+ not generated/);
    expect(stdout).not.toContain("shot.03.last");
  });

  it("stays silent about an asset no composition uses — it gates nothing; doctor owns it", async () => {
    await fs.writeFile(path.join(projectDir, "video.tsx"), TEST_VIDEO_WITH_UNUSED_TSX);
    const unusedProject = projectDir;

    const { stdout: text } = await run(["status"], unusedProject);
    // The timeline bgm is filtered out before readiness, so motion is the only counted asset here.
    expect(text).toMatch(/video: 0\/1 accepted/);
    expect(text).not.toContain("video:timeline.bgm");
    // status drops it because there is nothing to do about one now, not because it goes unreported
    // — doctor's "unused assets" check owns it (see the doctor suite).
  });
});

describe("review record show command", () => {
  let projectDir: string;

  beforeEach(async () => {
    projectDir = await initWithTestVideo();
  });

  async function writeReview(): Promise<void> {
    const dir = path.join(projectDir, "review", "animatic", "records");
    await fs.mkdir(dir, { recursive: true });
    const record = {
      mode: "animatic-preview",
      stage: "animatic",
      createdAt: "2026-05-16T12:00:00.000Z",
      context: { shots: [{ shotId: "03", duration: 4, variants: { first: "v-Q4nT8aLp" } }] },
      decisions: { "03": "accepted" },
      notes: [
        {
          id: "fb-9conrpVY",
          time: 1,
          shotId: "03",
          x: 0.74,
          y: 0.67,
          text: "hand position looks unnatural",
        },
      ],
    };
    await fs.writeFile(path.join(dir, "20260516T120000000.json"), JSON.stringify(record));
  }

  it("prints 'No review found.' when there are no reviews", async () => {
    const { stdout } = await run(["review", "record", "show"], projectDir);
    expect(stdout).toContain("No review found.");
  });

  it("displays the latest review's decisions and feedback", async () => {
    await writeReview();
    const { stdout } = await run(["review", "record", "show"], projectDir);
    expect(stdout).toContain("animatic:shot.03.first (v-Q4nT8aLp)");
    expect(stdout).toContain("hand position looks unnatural");
  });

  it("opens a specific review file by name", async () => {
    await writeReview();
    const { stdout } = await run(["review", "record", "show", "20260516T120000000"], projectDir);
    expect(stdout).toContain("animatic:shot.03.first (v-Q4nT8aLp)");
  });
});
