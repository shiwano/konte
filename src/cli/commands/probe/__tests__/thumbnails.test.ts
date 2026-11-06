import { Command } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";

const { openProbeTargets, encodeWithGrid, extractFrameAt } = vi.hoisted(() => ({
  openProbeTargets: vi.fn(),
  encodeWithGrid: vi.fn(async (_source: string, _label: string, output: string) => ({
    path: output,
    labelled: true,
  })),
  extractFrameAt: vi.fn(async () => {}),
}));
vi.mock("../resolve-arg.js", () => ({ openProbeTargets }));
vi.mock("../../../../core/image-probe.js", () => ({ encodeWithGrid }));
vi.mock("../../../../core/ffmpeg.js", () => ({ ensureFfprobe: async () => {} }));
vi.mock("../../../../core/frame-extract.js", () => ({ extractFrameAt }));
import { registerProbeThumbnailsCommand } from "../thumbnails.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

async function run(args: string[]) {
  openProbeTargets.mockResolvedValue({
    videoRoot: "/video",
    variantIds: ["v-take"],
    multi: false,
    manager: {
      resolveVariantAddress: () => "video:shot.01.motion",
      getAssetState: () => ({
        variants: { "v-take": { file: "assets/take.mp4", outputHash: "h1" } },
      }),
    },
  });
  const program = new Command();
  registerProbeThumbnailsCommand(program);
  await program.parseAsync(["thumbnails", "video:shot.01.motion", ...args], { from: "user" });
}

const FRAME_DIR = "/video/.konte/cache/thumbnails/video/shot.01.motion/v-take/h1";

describe("probe thumbnails --grid", () => {
  it("prints each frame with the grid drawn over it", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await run(["--at", "1", "--grid", "5", "--force"]);
    expect(encodeWithGrid).toHaveBeenCalledWith(
      `${FRAME_DIR}/at-00001000ms.jpg`,
      `${FRAME_DIR}/at-00001000ms.jpg`,
      `${FRAME_DIR}/at-00001000ms-grid5.jpg`,
      5,
    );
    expect(log.mock.calls.at(-1)).toEqual([`  ${FRAME_DIR}/at-00001000ms-grid5.jpg (1s)`]);
  });

  it("prints the bare frame without it", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await run(["--at", "1", "--force"]);
    expect(encodeWithGrid).not.toHaveBeenCalled();
    expect(log.mock.calls.at(-1)).toEqual([`  ${FRAME_DIR}/at-00001000ms.jpg (1s)`]);
  });

  it("refuses a step out of range", async () => {
    await expect(run(["--at", "1", "--grid", "60"])).rejects.toMatchObject({
      code: "INVALID_OPTION",
    });
  });
});
