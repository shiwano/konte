import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ComfyModelDeclaration } from "../../core/types/index.js";
import {
  ensureWritableDir,
  joinReported,
  resolveModelDir,
  toLocalPath,
} from "../model-destination.js";
import type { ComfyUIModelFolder } from "../types.js";

// Shaped like a real `/api/experiment/models`: several registered directories per root, the
// legacy alias first.
const FOLDERS: ComfyUIModelFolder[] = [
  { name: "checkpoints", folders: ["/models/checkpoints"], extensions: [".safetensors"] },
  { name: "loras", folders: ["/models/loras"], extensions: [".safetensors"] },
  { name: "vae", folders: ["/models/vae"], extensions: [".safetensors"] },
  {
    name: "text_encoders",
    folders: ["/models/clip", "/models/text_encoders"],
    extensions: [".safetensors"],
  },
  {
    name: "diffusion_models",
    folders: ["/models/unet", "/models/diffusion_models"],
    extensions: [".safetensors"],
  },
  { name: "controlnet", folders: ["/models/t2i_adapter", "/models/controlnet"], extensions: [] },
  { name: "upscale_models", folders: ["/models/upscale_models"], extensions: [] },
  { name: "embeddings", folders: ["/models/embeddings"], extensions: [] },
  { name: "clip_vision", folders: ["/models/clip_vision"], extensions: [] },
  { name: "SEEDVR2", folders: ["/models/SEEDVR2"], extensions: [] },
];

const decl = (over: Partial<ComfyModelDeclaration>): ComfyModelDeclaration => ({
  filename: "m.safetensors",
  type: "checkpoint",
  url: "https://huggingface.co/r/resolve/main/m.safetensors",
  ...over,
});

describe("resolveModelDir", () => {
  it("sends a default-savePath model to the first directory of its mapped root", () => {
    expect(resolveModelDir(decl({ type: "checkpoint" }), FOLDERS)).toEqual({
      dir: "/models/checkpoints",
      rootDir: "/models/checkpoints",
      root: "checkpoints",
      relative: "m.safetensors",
    });
  });

  // The three type names that are not their own folder. Getting `clip` wrong writes to a directory
  // ComfyUI never reads for text encoders, and the model stays invisible.
  it("maps clip to text_encoders, and unet/diffusion_model to diffusion_models", () => {
    expect(resolveModelDir(decl({ type: "clip" }), FOLDERS)?.dir).toBe("/models/clip");
    expect(resolveModelDir(decl({ type: "unet" }), FOLDERS)?.dir).toBe("/models/unet");
    expect(resolveModelDir(decl({ type: "diffusion_model" }), FOLDERS)?.dir).toBe("/models/unet");
  });

  it('treats an explicit "default" savePath as no savePath', () => {
    expect(resolveModelDir(decl({ type: "VAE", savePath: "default" }), FOLDERS)?.dir).toBe(
      "/models/vae",
    );
  });

  it("resolves a savePath whose first segment names a declared root", () => {
    expect(resolveModelDir(decl({ savePath: "SEEDVR2" }), FOLDERS)).toEqual({
      dir: "/models/SEEDVR2",
      rootDir: "/models/SEEDVR2",
      root: "SEEDVR2",
      relative: "m.safetensors",
    });
    // `relative` is the form `/api/models/<root>` lists, which is what the landing check reads.
    expect(resolveModelDir(decl({ savePath: "SEEDVR2/v2" }), FOLDERS)).toEqual({
      dir: "/models/SEEDVR2/v2",
      rootDir: "/models/SEEDVR2",
      root: "SEEDVR2",
      relative: "v2/m.safetensors",
    });
  });

  // The Manager would join this onto `folder_paths.models_dir`, which no route exposes. konte
  // declines rather than guessing, and the Manager takes the download.
  it("declines a savePath under no declared root", () => {
    expect(resolveModelDir(decl({ savePath: "mystery_folder" }), FOLDERS)).toBeNull();
  });

  // The filesystem collapses `.` away, so keeping it in `relative` would have the landing check
  // look for a path ComfyUI's listing never spells — failing a download that in fact succeeded.
  it("normalizes away a no-op savePath segment", () => {
    expect(resolveModelDir(decl({ savePath: "SEEDVR2/./v2" }), FOLDERS)).toEqual({
      dir: "/models/SEEDVR2/v2",
      rootDir: "/models/SEEDVR2",
      root: "SEEDVR2",
      relative: "v2/m.safetensors",
    });
  });

  it("declines custom_nodes, traversal and absolute savePaths", () => {
    expect(resolveModelDir(decl({ savePath: "custom_nodes/pack/x" }), FOLDERS)).toBeNull();
    expect(resolveModelDir(decl({ savePath: "SEEDVR2/../../etc" }), FOLDERS)).toBeNull();
    expect(resolveModelDir(decl({ savePath: "/etc" }), FOLDERS)).toBeNull();
  });

  it("declines a filename that is a path rather than a leaf", () => {
    expect(resolveModelDir(decl({ filename: "sub/m.safetensors" }), FOLDERS)).toBeNull();
    expect(resolveModelDir(decl({ filename: "C:evil" }), FOLDERS)).toBeNull();
  });

  // These name a directory, not a file. Allowed through, the destination resolves to something
  // that already exists and the download reports a model it never fetched.
  it("declines a filename that is a directory reference", () => {
    expect(resolveModelDir(decl({ filename: "." }), FOLDERS)).toBeNull();
    expect(resolveModelDir(decl({ filename: ".." }), FOLDERS)).toBeNull();
    expect(resolveModelDir(decl({ filename: "" }), FOLDERS)).toBeNull();
  });

  it("declines when ComfyUI declares no root of that type", () => {
    expect(resolveModelDir(decl({ type: "checkpoint" }), [])).toBeNull();
  });
});

describe("toLocalPath", () => {
  // The WSL case konte is most often in: ComfyUI native on Windows, konte under Linux.
  it("maps a Windows drive path onto the WSL mount", () => {
    expect(toLocalPath("C:\\Users\\A B\\ComfyUI-Shared\\models\\unet")).toBe(
      "/mnt/c/Users/A B/ComfyUI-Shared/models/unet",
    );
    expect(toLocalPath("D:/models/unet")).toBe("/mnt/d/models/unet");
  });

  it("passes a POSIX path through unchanged", () => {
    expect(toLocalPath("/home/x/ComfyUI/models/unet")).toBe("/home/x/ComfyUI/models/unet");
  });

  it("gives up on a path it has no mapping for", () => {
    expect(toLocalPath("\\\\server\\share\\models")).toBeNull();
  });

  // The route contracts to report absolute directories. A relative one would be opened against
  // konte's own working directory, so a server answering "models/checkpoints" would have konte
  // write into the workspace it was launched from.
  it("refuses a path that is not rooted", () => {
    expect(toLocalPath("models/checkpoints")).toBeNull();
    expect(toLocalPath(".")).toBeNull();
    expect(toLocalPath("")).toBeNull();
  });
});

describe("joinReported", () => {
  it("keeps the separator style the reported path already uses", () => {
    expect(joinReported("C:\\models\\unet", ["m.safetensors"])).toBe(
      "C:\\models\\unet\\m.safetensors",
    );
    expect(joinReported("/models/unet/", ["m.safetensors"])).toBe("/models/unet/m.safetensors");
  });
});

describe("ensureWritableDir", () => {
  let tmp: string;
  // Stands in for ComfyUI's models directory, which a working install always has.
  const models = () => path.join(tmp, "models");

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "konte-dest-"));
    await fs.mkdir(models());
  });

  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it("creates a root directory ComfyUI declared but has not made yet", async () => {
    const dir = path.join(models(), "t2i_adapter");
    expect(await ensureWritableDir(dir, dir)).toBe(true);
    expect((await fs.stat(dir)).isDirectory()).toBe(true);
  });

  it("reports an existing directory as writable", async () => {
    expect(await ensureWritableDir(models(), models())).toBe(true);
  });

  // A TTS adapter nests four levels under its root; a model host owns that whole subtree, so
  // everything below the root is konte's to create.
  it("creates any depth beneath the root", async () => {
    const root = path.join(models(), "TTS");
    const dir = path.join(root, "Qwen3-TTS", "Qwen3-TTS-12Hz-1.7B-VoiceDesign", "speech_tokenizer");
    expect(await ensureWritableDir(dir, root)).toBe(true);
    expect((await fs.stat(dir)).isDirectory()).toBe(true);
  });

  // The path was named by the server, not the author. A models directory that is not there says
  // this is not the install konte is talking to, so nothing is built for it.
  it("refuses when the root's own parent does not exist", async () => {
    const root = path.join(tmp, "workspace", "ComfyUI", "models", "unet");
    expect(await ensureWritableDir(root, root)).toBe(false);
    await expect(fs.access(path.join(tmp, "workspace"))).rejects.toThrow();
  });

  it("leaves no probe file behind", async () => {
    await ensureWritableDir(models(), models());
    expect(await fs.readdir(models())).toEqual([]);
  });

  it("reports a directory it cannot create as not writable", async () => {
    await fs.chmod(models(), 0o500);
    expect(await ensureWritableDir(path.join(models(), "nested"), models())).toBe(false);
    await fs.chmod(models(), 0o700);
  });
});
