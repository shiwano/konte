import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "vitest";

// The command's value is that it produces the picture with no job, no variant and no state write —
// so mock the capture (exercise the routing and the placeholder substitution, not Chromium) and the
// two data layers it reads, and assert what reaches the capture.
vi.mock("../../../../core/still-capture.js", () => ({
  captureHtmlToImage: vi.fn(async ({ outputFile }: { outputFile: string }) => {
    await fs.mkdir(path.dirname(outputFile), { recursive: true });
    await fs.writeFile(outputFile, "png");
  }),
}));

const data = vi.hoisted(() => ({
  definitions: {} as Record<string, unknown>,
  resolved: {} as Record<string, { variantId: string; file: string; outputHash?: string } | null>,
}));

vi.mock("../../../load-definition.js", () => ({
  loadStageDefinitions: async () => data.definitions,
}));
vi.mock("../../../../core/definition-hashes.js", () => ({
  applyResolutionDefinitions: async () => data.definitions,
}));
vi.mock("../../../../core/state/index.js", () => ({
  StateManager: {
    load: async () => ({
      getState: () => ({ assets: {} }),
      resolveReference: (address: string) => data.resolved[address] ?? null,
    }),
  },
}));

import { captureHtmlToImage } from "../../../../core/still-capture.js";
import { setRoots } from "../../../context.js";
import { registerProbeJsxCommand } from "../jsx.js";

const captureMock = captureHtmlToImage as unknown as Mock;

let videoRoot: string;

function jsxDef(html: string, refs: string[] = []) {
  return {
    kind: "local",
    operation: "render",
    mediaType: "image",
    deterministic: true,
    inputs: { html, width: 32, height: 24, refs },
  };
}

const fileDef = { kind: "file", mediaType: "image", inputs: { path: "assets/files/logo.png" } };

async function runJsx(args: string[]): Promise<{ stdout: string; stderr: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const logSpy = vi.spyOn(console, "log").mockImplementation((...a) => {
    out.push(a.map(String).join(" "));
  });
  const errSpy = vi.spyOn(console, "error").mockImplementation((...a) => {
    err.push(a.map(String).join(" "));
  });
  try {
    const program = new Command();
    program.exitOverride();
    registerProbeJsxCommand(program);
    await program.parseAsync(["jsx", ...args], { from: "user" });
  } finally {
    logSpy.mockRestore();
    errSpy.mockRestore();
  }
  return { stdout: out.join("\n"), stderr: err.join("\n") };
}

beforeEach(async () => {
  videoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "konte-probe-jsx-"));
  await fs.mkdir(path.join(videoRoot, "assets", "files"), { recursive: true });
  await fs.writeFile(path.join(videoRoot, "assets", "files", "logo.png"), "png");

  setRoots({
    workspace: videoRoot,
    video: { kind: "selected", root: videoRoot, name: "project" },
  });

  data.definitions = {
    reference: { shots: [], topLevelAssets: { logo: fileDef } },
    animatic: null,
    video: {
      topLevelAssets: { plate: jsxDef("<html>plate</html>") },
      shots: [
        {
          id: "01",
          assets: {
            card: jsxDef('<html><img src="__konte:reference:logo__"></html>', [
              "__konte:reference:logo__",
            ]),
            motion: { kind: "fal", inputs: {} },
          },
        },
        { id: "10", assets: { card: jsxDef("<html>ten</html>") } },
        { id: "2", assets: { card: jsxDef("<html>two</html>") } },
      ],
    },
  };
  data.resolved = {
    "reference:logo": { variantId: "v-logo", file: "assets/files/logo.png", outputHash: "h-logo" },
  };
  captureMock.mockClear();
});

afterEach(async () => {
  setRoots(null);
  await fs.rm(videoRoot, { recursive: true, force: true });
});

describe("probe jsx", () => {
  it("renders one address from its definition and prints the still's path", async () => {
    const { stdout, stderr } = await runJsx(["video:shot.01.card"]);

    expect(stdout.split("\n")).toHaveLength(1);
    expect(stdout).toContain(path.join(".konte", "cache", "jsx", "video", "shot.01.card"));
    expect(stdout.endsWith(".png")).toBe(true);
    expect(stderr).toContain("1 rendered");

    const call = captureMock.mock.calls[0]![0];
    expect(call.size).toEqual({ width: 32, height: 24 });
    expect(call.html).toContain('src="asset-0.png"');
    expect(call.assetFiles).toEqual({
      "asset-0.png": path.join(videoRoot, "assets", "files", "logo.png"),
    });
  });

  it("stands a labelled tile in for a ref with nothing to resolve to, and says so", async () => {
    data.resolved = {};
    const { stdout, stderr } = await runJsx(["video:shot.01.card"]);

    expect(stdout).toContain(".png");
    expect(stderr).toContain("unresolved in video:shot.01.card: reference:logo");

    const call = captureMock.mock.calls[0]![0];
    expect(call.assetFiles).toEqual({});
    expect(call.html).toContain("data:image/svg+xml;base64,");
    const encoded = call.html.match(/base64,([A-Za-z0-9+/=]+)/)![1] as string;
    expect(Buffer.from(encoded, "base64").toString("utf-8")).toContain("reference:logo");
  });

  it("a scope renders every jsxImage under it, digit runs compared numerically", async () => {
    const { stdout } = await runJsx(["video"]);

    expect(captureMock).toHaveBeenCalledTimes(4);
    expect(stdout.split("\n").map((p) => path.basename(path.dirname(p)))).toEqual([
      "shot.01.card",
      "shot.2.card",
      "shot.10.card",
      "timeline.plate",
    ]);
  });

  it("rejects an address that is not a jsxImage asset, by kind rather than as missing", async () => {
    // A declared asset of the wrong kind and one of konte's own leaves are both the wrong TYPE;
    // only an address no stage file declares is not found.
    await expect(runJsx(["video:shot.01.motion"])).rejects.toMatchObject({
      code: "INVALID_ASSET_TYPE",
    });
    await expect(runJsx(["video:shot.01#composition"])).rejects.toMatchObject({
      code: "INVALID_ASSET_TYPE",
    });
    await expect(runJsx(["video:shot.01.card#delivery"])).rejects.toMatchObject({
      code: "INVALID_ASSET_TYPE",
    });
    await expect(runJsx(["video:shot.01.nosuch"])).rejects.toMatchObject({
      code: "ADDRESS_NOT_FOUND",
    });
    expect(captureMock).not.toHaveBeenCalled();
  });

  it("treats a referenced file that has gone missing as unresolved", async () => {
    await fs.rm(path.join(videoRoot, "assets", "files", "logo.png"));
    const { stderr } = await runJsx(["video:shot.01.card"]);

    expect(stderr).toContain("unresolved in video:shot.01.card: reference:logo");
    // Never a dangling symlink handed to the capture — the layer would render broken, silently.
    expect(captureMock.mock.calls[0]![0].assetFiles).toEqual({});
  });

  it("re-renders when a referenced file's bytes move under an unchanged recorded hash", async () => {
    const first = await runJsx(["video:shot.01.card"]);

    // What an edited `file` asset looks like here: this command writes nothing, so it never runs
    // the sync that would move the recorded content hash.
    const logo = path.join(videoRoot, "assets", "files", "logo.png");
    await fs.writeFile(logo, "png-edited");
    const now = new Date(Date.now() + 2000);
    await fs.utimes(logo, now, now);

    const second = await runJsx(["video:shot.01.card"]);
    expect(captureMock).toHaveBeenCalledTimes(2);
    expect(second.stdout).not.toBe(first.stdout);
  });

  it("reuses a cached still until the definition or a resolved input moves", async () => {
    const first = await runJsx(["video:shot.01.card"]);
    const second = await runJsx(["video:shot.01.card"]);

    expect(captureMock).toHaveBeenCalledTimes(1);
    expect(second.stdout).toBe(first.stdout);
    expect(second.stderr).toContain("1 cached");

    data.resolved["reference:logo"]!.outputHash = "h-logo-2";
    const third = await runJsx(["video:shot.01.card"]);
    expect(captureMock).toHaveBeenCalledTimes(2);
    expect(third.stdout).not.toBe(first.stdout);

    const dir = path.dirname(third.stdout);
    expect(await fs.readdir(dir)).toEqual([path.basename(third.stdout)]);
  });

  it("--force re-renders a cached still", async () => {
    await runJsx(["video:shot.01.card"]);
    await runJsx(["video:shot.01.card", "--force"]);
    expect(captureMock).toHaveBeenCalledTimes(2);
  });
});
