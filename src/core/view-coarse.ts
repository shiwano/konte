import * as fs from "node:fs";
import * as path from "node:path";
import { hashFile, sha256Hex } from "./content-hash.js";
import { KonteError } from "./errors.js";
import { estimatePointMap, MOGE_URLS, type PointMap } from "./moge.js";
import { readRgbImage, writePng, type RgbImage } from "./rgb-image.js";
import { toolPin } from "./tool-checksums.js";
import type { CoarseView } from "./view.js";
import {
  dropGrazing,
  pointMapMesh,
  renderColor,
  roomFrame,
  type Camera,
  type ClipPlane,
  type Mesh,
  type Room,
  type Vec3,
} from "./view-scene.js";

// A view's coarse: the location master lifted to a mesh by monocular depth and drawn from the
// view's camera, what the master never saw left flat grey.

const GRAZING_COS = 0.15;
const SIDE_FOV_Y = 45;
const SIDE_NEAR = 1.2;
const TOP_FOV_Y = 60;
const TOP_CLIP = 0.7;
const BACKGROUND: Vec3 = [128, 128, 128];
const COARSE_PIXELS = 1424 * 712;

/** The coarse's size: `canvas`'s aspect at about a megapixel, both sides even. */
export function coarseSize(canvas: { width: number; height: number }): {
  width: number;
  height: number;
} {
  const k = Math.sqrt(COARSE_PIXELS / (canvas.width * canvas.height));
  const even = (n: number): number => Math.max(2, 2 * Math.round((n * k) / 2));
  return { width: even(canvas.width), height: even(canvas.height) };
}

/** The camera each view is drawn from, in the room frame of `roomFrame`. */
export function viewCamera(view: CoarseView, room: Room, aspect: number): Camera {
  const cx = (room.x[0] + room.x[1]) / 2;
  switch (view) {
    case "top": {
      const cz = (room.z[0] + room.z[1]) / 2;
      const half = Math.max((room.z[1] - room.z[0]) / 2, (room.x[1] - room.x[0]) / (2 * aspect));
      const height = half / Math.tan(((TOP_FOV_Y / 2) * Math.PI) / 180);
      return { position: [cx, height, cz], target: [cx, 0, cz], up: [0, 0, -1], fovY: TOP_FOV_Y };
    }
    case "sideLeft": {
      const z = room.z[0] / 2;
      return {
        position: [room.x[0], room.eye, z],
        target: [room.x[1], room.eye, z],
        fovY: SIDE_FOV_Y,
        near: SIDE_NEAR,
      };
    }
    case "sideRight": {
      const z = room.z[0] / 2;
      return {
        position: [room.x[1], room.eye, z],
        target: [room.x[0], room.eye, z],
        fovY: SIDE_FOV_Y,
        near: SIDE_NEAR,
      };
    }
  }
}

const inFlight = new Map<string, Promise<PointMap>>();

const HEADER_BYTES = 12;

// The map with its points rounded to float16, as the cache keeps them.
function toHalf(map: PointMap): { map: PointMap; half: Float16Array } {
  const half = new Float16Array(map.points);
  return { map: { ...map, points: Float32Array.from(half) }, half };
}

/**
 * `file`'s point map, its points rounded to float16 whether read or computed, kept under `cacheDir`
 * by the file's content and the model.
 */
async function cachedPointMap(
  file: string,
  image: RgbImage,
  cacheDir: string | undefined,
): Promise<PointMap> {
  if (!cacheDir) return toHalf(await estimatePointMap(image)).map;
  const key = sha256Hex(await hashFile(file), toolPin(MOGE_URLS));
  const cached = path.join(cacheDir, `${key}.f16`);
  if (fs.existsSync(cached)) {
    const bytes = fs.readFileSync(cached);
    const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length);
    const [width, height, solvedFovX] = new Float32Array(buffer, 0, 3);
    return {
      width: width!,
      height: height!,
      fovX: solvedFovX!,
      points: Float32Array.from(new Float16Array(buffer, HEADER_BYTES)),
    };
  }
  const pending = inFlight.get(key);
  if (pending) return pending;
  const run = (async () => {
    const { map, half } = toHalf(await estimatePointMap(image));
    const out = new Uint8Array(HEADER_BYTES + half.byteLength);
    out.set(new Uint8Array(Float32Array.from([map.width, map.height, map.fovX]).buffer));
    out.set(new Uint8Array(half.buffer), HEADER_BYTES);
    fs.mkdirSync(cacheDir, { recursive: true });
    const staging = `${cached}.${process.pid}.tmp`;
    fs.writeFileSync(staging, out);
    fs.renameSync(staging, cached);
    return map;
  })().finally(() => inFlight.delete(key));
  inFlight.set(key, run);
  return run;
}

/** The master's mesh in the room frame, grazing triangles dropped. */
async function masterScene(
  file: string,
  master: RgbImage,
  cacheDir: string | undefined,
): Promise<{ mesh: Mesh; room: Room }> {
  const map = await cachedPointMap(file, master, cacheDir);
  const mesh = dropGrazing(pointMapMesh(map, master), GRAZING_COS);
  if (mesh.indices.length === 0) {
    throw new KonteError(
      "GENERATION_FAILED",
      "The depth model found no surface in the location's image, so no view can be drawn from " +
        "it. Make the view image without its coarse.",
    );
  }
  return roomFrame(mesh);
}

/**
 * Draws `view`'s coarse of the master at `masterFile` into `outputFile`, at `coarseSize(canvas)`,
 * the master's point map kept under `cacheDir`.
 */
export async function renderViewCoarse(options: {
  masterFile: string;
  view: CoarseView;
  canvas: { width: number; height: number };
  outputFile: string;
  cacheDir?: string;
}): Promise<void> {
  const size = coarseSize(options.canvas);
  const aspect = size.width / size.height;
  const master = await readRgbImage(options.masterFile);
  const { mesh, room } = await masterScene(options.masterFile, master, options.cacheDir);
  const camera = viewCamera(options.view, room, aspect);
  const clip: ClipPlane | undefined =
    options.view === "top" ? { normal: [0, 1, 0], offset: TOP_CLIP * room.ceiling } : undefined;
  const image = renderColor([mesh], camera, size, {
    background: BACKGROUND,
    ...(clip ? { clip } : {}),
  });
  await writePng(image, options.outputFile);
}
