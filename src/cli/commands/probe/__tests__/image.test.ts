import { Command } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";

const { openProbeTargets, probeImage } = vi.hoisted(() => ({
  openProbeTargets: vi.fn(),
  probeImage: vi.fn(async ({ variantId }: { variantId: string }) => ({
    path: `/cache/${variantId}.jpg`,
    labelled: true,
  })),
}));
vi.mock("../resolve-arg.js", () => ({ openProbeTargets }));
vi.mock("../../../../core/image-probe.js", () => ({ probeImage }));
import { registerProbeImageCommand } from "../image.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

async function run(files = { first: "source.png", second: "source.png" }) {
  openProbeTargets.mockResolvedValue({
    videoRoot: "/video",
    variantIds: ["v-first", "v-second"],
    multi: true,
    manager: {
      resolveVariantAddress: () => "reference:mother",
      getAssetState: () => ({
        variants: { "v-first": { file: files.first }, "v-second": { file: files.second } },
      }),
    },
  });
  const program = new Command();
  registerProbeImageCommand(program);
  await program.parseAsync(["image", "reference", "--force"], { from: "user" });
}

describe("probe image", () => {
  it("prints inspection paths on stdout and labels them on stderr", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    await run();
    expect(openProbeTargets).toHaveBeenCalledWith(["reference"], { mediaKinds: ["image"] });
    expect(log.mock.calls).toEqual([["/cache/v-first.jpg"], ["/cache/v-second.jpg"]]);
    expect(error.mock.calls).toEqual([
      ["reference:mother (v-first)"],
      ["reference:mother (v-second)"],
    ]);
    expect(probeImage).toHaveBeenCalledWith(expect.objectContaining({ force: true }));
  });
  it("rejects a video before printing any path", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await expect(run({ first: "source.png", second: "source.mp4" })).rejects.toMatchObject({
      code: "INVALID_ASSET_TYPE",
    });
    expect(probeImage).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
  });
});
