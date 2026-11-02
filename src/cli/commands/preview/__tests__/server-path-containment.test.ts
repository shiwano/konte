import * as fs from "node:fs/promises";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeWorkspace, type Workspace } from "../../../../core/__tests__/helpers/workspace.js";
import {
  handleAssetRequest,
  handlePrerollAssetRequest,
  handleStudySheetRequest,
  handleThumbnailAssetRequest,
} from "../server.js";

const ADDR = "video:shot.01.motion";
const VID = "v-abc";

let ws: Workspace;
let videoRoot: string;
let credentials: string;

beforeEach(async () => {
  ws = await makeWorkspace({ videos: ["opening"] });
  videoRoot = ws.videos.opening!.video;
  credentials = path.join(ws.root, "konte.credentials.json");
  await fs.writeFile(credentials, JSON.stringify({ FAL_KEY: "super-secret" }));
});

afterEach(async () => {
  await ws.cleanup();
});

async function writeFile(file: string, content = "bytes"): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, content);
}

async function symlink(target: string, link: string): Promise<void> {
  await fs.mkdir(path.dirname(link), { recursive: true });
  await fs.symlink(target, link);
}

async function setVariantFile(file: string): Promise<void> {
  await fs.writeFile(
    path.join(videoRoot, "konte.state.json"),
    JSON.stringify({ schemaVersion: 1, assets: { [ADDR]: { variants: { [VID]: { file } } } } }),
  );
}

describe("/api/assets", () => {
  const request = (filename: string) =>
    handleAssetRequest(videoRoot, `video/shot.01.motion/${VID}/${encodeURIComponent(filename)}`);

  it("serves a variant's file inside the video", async () => {
    const rel = `assets/video/shot.01/motion/${VID}/out.mp4`;
    await writeFile(path.join(videoRoot, rel), "motion");
    await setVariantFile(rel);

    const res = request("out.mp4");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("motion");
  });

  it("refuses a variant file whose path escapes the video", async () => {
    await setVariantFile("../../konte.credentials.json");
    expect(request("konte.credentials.json").status).toBe(403);
  });

  it("refuses a variant file that is a symlink out of the video", async () => {
    const rel = `assets/video/shot.01/motion/${VID}/out.mp4`;
    await symlink(credentials, path.join(videoRoot, rel));
    await setVariantFile(rel);

    expect(request("out.mp4").status).toBe(403);
  });

  it("refuses a sibling directory sharing the video root's prefix", async () => {
    await writeFile(`${videoRoot}-evil/out.mp4`);
    await setVariantFile(`../${path.basename(videoRoot)}-evil/out.mp4`);
    expect(request("out.mp4").status).toBe(403);
  });
});

describe("/api/thumbnail-assets", () => {
  const thumbnails = () => path.join(videoRoot, ".konte", "cache", "thumbnails");

  it("serves a file in the thumbnail cache", async () => {
    await writeFile(path.join(thumbnails(), VID, "frame.jpg"), "jpeg");

    const res = handleThumbnailAssetRequest(videoRoot, `.konte/cache/thumbnails/${VID}/frame.jpg`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("jpeg");
  });

  it("refuses a file inside the video but outside the thumbnail cache", () => {
    expect(handleThumbnailAssetRequest(videoRoot, "konte.state.json").status).toBe(403);
  });

  it("refuses a `..` escape to the workspace's credentials", () => {
    expect(handleThumbnailAssetRequest(videoRoot, "../../konte.credentials.json").status).toBe(403);
  });

  it("refuses a symlink in the thumbnail cache pointing out of it", async () => {
    await symlink(path.join(videoRoot, "konte.state.json"), path.join(thumbnails(), "x.jpg"));
    expect(handleThumbnailAssetRequest(videoRoot, ".konte/cache/thumbnails/x.jpg").status).toBe(
      403,
    );
  });

  it("reports a missing file inside the cache as not found", () => {
    expect(handleThumbnailAssetRequest(videoRoot, ".konte/cache/thumbnails/gone.jpg").status).toBe(
      404,
    );
  });
});

describe("preroll assets", () => {
  const preroll = () => path.join(videoRoot, ".konte", "cache", "preroll");

  it("serves a file in the preroll cache", async () => {
    await writeFile(path.join(preroll(), "a.wav"), "wave");

    const res = handlePrerollAssetRequest(videoRoot, "a.wav");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("wave");
  });

  it("refuses an encoded `..` escape out of the preroll cache", () => {
    expect(handlePrerollAssetRequest(videoRoot, "..%2F..%2Fkonte.state.json").status).toBe(403);
  });

  it("refuses a symlink in the preroll cache pointing out of it", async () => {
    await symlink(credentials, path.join(preroll(), "a.wav"));
    expect(handlePrerollAssetRequest(videoRoot, "a.wav").status).toBe(403);
  });

  it("rejects a malformed escape", () => {
    expect(handlePrerollAssetRequest(videoRoot, "%zz.wav").status).toBe(400);
  });
});

describe("study sheets", () => {
  const studies = () => path.join(ws.root, ".konte", "studies");

  it("serves a file in the workspace's studies", async () => {
    await writeFile(path.join(studies(), "sheet.png"), "png");

    const res = handleStudySheetRequest(ws.root, "sheet.png");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("png");
  });

  it("refuses a `..` escape to the workspace's credentials", () => {
    expect(handleStudySheetRequest(ws.root, "..%2F..%2Fkonte.credentials.json").status).toBe(403);
  });

  it("refuses a symlink in the studies pointing out of them", async () => {
    await symlink(credentials, path.join(studies(), "sheet.png"));
    expect(handleStudySheetRequest(ws.root, "sheet.png").status).toBe(403);
  });
});
