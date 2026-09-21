import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { ComfyModelDeclaration, ComfyModelType } from "../core/types/index.js";
import type { ComfyUIModelFolder } from "./types.js";

// konte's `type` vocabulary is ComfyUI-Manager's, and is not the folder name: the Manager maps it
// through `model_dir_name_map` (comfyui_manager/glob/constants.py) first. Three entries are not
// the identity — `clip` lands in text_encoders, `unet` and `diffusion_model` in diffusion_models.
const MODEL_DIR_NAME_MAP: Record<ComfyModelType, string> = {
  checkpoint: "checkpoints",
  lora: "loras",
  VAE: "vae",
  clip: "text_encoders",
  diffusion_model: "diffusion_models",
  controlnet: "controlnet",
  upscale: "upscale_models",
  embeddings: "embeddings",
  clip_vision: "clip_vision",
  unet: "diffusion_models",
};

// A `filename` is a leaf, never a path.
const FILENAME_REJECTED_CHARS = ["/", "\\", ":"];
// Left through, these resolve to a directory that already exists, which the downloader reads as
// "already installed" and reports as a model it never fetched.
const FILENAME_RESERVED = new Set(["", ".", ".."]);

export type ModelDestination = {
  // Absolute directory, spelled as ComfyUI spells it (a `C:\...` path when ComfyUI runs on
  // Windows). Not necessarily openable by this process — see `toLocalPath`.
  dir: string;
  // The `folder_paths` root this lives under, i.e. what `/api/models/<root>` lists.
  root: string;
  // That root's own registered directory. `dir` is this or something beneath it, and it is the
  // deepest level konte treats as ComfyUI's rather than as its own invention.
  rootDir: string;
  // The file's path relative to that root, which is the form the listing uses.
  relative: string;
};

/**
 * Where konte would write this model, as ComfyUI itself spells the path — or null when konte
 * declines to guess and the download should go to ComfyUI-Manager instead.
 *
 * The rule matches the Manager's `get_model_dir` where it can be matched over HTTP: a model with
 * no `savePath` goes to the FIRST registered directory of its mapped root, which is what the
 * Manager's `folder_names_and_paths[name][0][0]` resolves to.
 *
 * A `savePath` is honoured only when its first segment names a root ComfyUI actually declared.
 * The Manager instead joins it onto `folder_paths.models_dir`, which no route exposes, so konte
 * declines those and lets the Manager take them.
 */
export function resolveModelDir(
  decl: ComfyModelDeclaration,
  folders: readonly ComfyUIModelFolder[],
): ModelDestination | null {
  if (FILENAME_REJECTED_CHARS.some((c) => decl.filename.includes(c))) return null;
  if (FILENAME_RESERVED.has(decl.filename)) return null;

  const rootDir = (name: string): string | undefined =>
    folders.find((f) => f.name === name)?.folders[0];

  const savePath = decl.savePath;
  if (savePath === undefined || savePath === "" || savePath === "default") {
    const root = MODEL_DIR_NAME_MAP[decl.type];
    const dir = rootDir(root);
    return dir === undefined ? null : { dir, rootDir: dir, root, relative: decl.filename };
  }

  if (savePath.startsWith("/") || savePath.startsWith("\\")) return null;
  // The filesystem normalizes `.` away, so keeping it would leave `relative` spelling a path
  // ComfyUI's listing never uses.
  const segments = savePath
    .replaceAll("\\", "/")
    .split("/")
    .filter((s) => s.length > 0 && s !== ".");
  if (segments.length === 0 || segments.includes("..")) return null;
  // `custom_nodes/...` retargets to wherever that pack actually installed — a lookup only the
  // Manager can do.
  if (segments[0] === "custom_nodes") return null;

  const root = segments[0]!;
  const dir = rootDir(root);
  if (dir === undefined) return null;
  const under = segments.slice(1);
  return {
    dir: under.length === 0 ? dir : joinReported(dir, under),
    rootDir: dir,
    root,
    relative: [...under, decl.filename].join("/"),
  };
}

// Extend a ComfyUI-reported path in the separator style it already uses.
export function joinReported(dir: string, segments: readonly string[]): string {
  const sep = dir.includes("\\") ? "\\" : "/";
  return [dir.replace(/[\\/]+$/, ""), ...segments].join(sep);
}

/**
 * The reported path as THIS process must open it, or null when it cannot reach it at all.
 *
 * ComfyUI reports whatever its own OS uses, which need not be konte's: the common WSL setup runs
 * ComfyUI on Windows (`C:\Users\...\models\unet`) and konte under Linux, where that directory is
 * `/mnt/c/Users/.../models/unet`. `/mnt` is WSL's default and is configurable in `wsl.conf`; a
 * relocated mount root reads as not-writable and falls back to ComfyUI-Manager.
 */
export function toLocalPath(reported: string): string | null {
  const drive = /^([A-Za-z]):[\\/]/.exec(reported);
  if (process.platform === "win32") return drive || reported.startsWith("\\\\") ? reported : null;
  if (drive) {
    return `/mnt/${drive[1]!.toLowerCase()}/${reported.slice(3).replaceAll("\\", "/")}`;
  }
  // The route contracts to report absolute directories. A relative one would be opened against
  // konte's own working directory, so a server answering `models/checkpoints` would have konte
  // write into the workspace it was run from.
  return reported.startsWith("/") ? reported : null;
}

/**
 * Whether konte can actually write into `dir`, creating what is missing beneath `rootDir`. The
 * answer comes from a real write: a WSL mount, a network share and a read-only bind all report
 * plausible modes and then fail at the first byte.
 *
 * `rootDir` anchors how much konte is willing to invent. Its PARENT must already exist — that is
 * ComfyUI's models directory, which a working install always has. Everything from `rootDir` down
 * is then created freely, because an adapter legitimately nests
 * (`TTS/Qwen3-TTS/…/speech_tokenizer` is four levels of directory a model host expects to own).
 * Without the anchor a remote ComfyUI reporting `/workspace/ComfyUI/models/unet` would have konte
 * materialize that whole chain locally, before anything established the destination is real; a
 * missing models directory instead reads as not-writable and the download goes to ComfyUI-Manager,
 * which runs where the path does exist.
 */
export async function ensureWritableDir(dir: string, rootDir: string): Promise<boolean> {
  const probe = path.join(
    dir,
    `.konte-write-probe.${process.pid}.${crypto.randomBytes(4).toString("hex")}`,
  );
  try {
    await fs.access(path.dirname(rootDir));
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(probe, "");
    return true;
  } catch {
    return false;
  } finally {
    await fs.unlink(probe).catch(() => {});
  }
}
