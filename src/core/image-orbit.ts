import * as fs from "node:fs";
import * as path from "node:path";
import { hashFile, sha256Hex } from "./content-hash.js";
import { KonteError } from "./errors.js";
import { estimatePointMap, MOGE_URLS, type PointMap } from "./moge.js";
import { readRgbImage, writePng, type RgbImage } from "./rgb-image.js";
import { toolPin } from "./tool-checksums.js";
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

// An orbit: a location master lifted to a mesh by monocular depth and drawn from another camera,
// what the master never saw left flat grey.

/**
 * Where an orbit's camera stands, turned from the master's around the room's centre at eye height:
 * `yaw` degrees to the right (negative left, 180 the reverse), `pitch` degrees up (90 straight
 * down), `distance` along that line in units of the room's edge (1 the wall or ceiling it meets,
 * past 1 a cutaway), `fovY` its vertical field of view in degrees.
 */
export type OrbitPose = { yaw: number; pitch: number; distance: number; fovY: number };

const GRAZING_COS = 0.15;
const CUT_DEPTH = 1.2;
const BACKGROUND: Vec3 = [128, 128, 128];
const ORBIT_PIXELS = 1424 * 712;

/** An orbit's default size: `canvas`'s aspect at about a megapixel, both sides even. */
export function orbitSize(canvas: { width: number; height: number }): {
  width: number;
  height: number;
} {
  const k = Math.sqrt(ORBIT_PIXELS / (canvas.width * canvas.height));
  const even = (n: number): number => Math.max(2, 2 * Math.round((n * k) / 2));
  return { width: even(canvas.width), height: even(canvas.height) };
}

const RAD = Math.PI / 180;

// How far from `from` along the unit `dir` the room's box ends.
function boxExit(from: Vec3, dir: Vec3, room: Room): number {
  const bounds: [number, number][] = [room.x, [0, room.ceiling], room.z];
  let t = Infinity;
  for (let i = 0; i < 3; i++) {
    const d = dir[i]!;
    if (Math.abs(d) < 1e-9) continue;
    t = Math.min(t, ((d > 0 ? bounds[i]![1] : bounds[i]![0]) - from[i]!) / d);
  }
  return Math.max(t, 0);
}

/**
 * The camera `pose` is drawn from in the room frame of `roomFrame`, and the plane past which
 * everything between it and the room's centre is cut away.
 */
export function orbitCamera(pose: OrbitPose, room: Room): { camera: Camera; clip: ClipPlane } {
  const pivot: Vec3 = [(room.x[0] + room.x[1]) / 2, room.eye, (room.z[0] + room.z[1]) / 2];
  const yaw = pose.yaw * RAD;
  const pitch = pose.pitch * RAD;
  const dir: Vec3 = [
    Math.sin(yaw) * Math.cos(pitch),
    Math.sin(pitch),
    Math.cos(yaw) * Math.cos(pitch),
  ];
  const up: Vec3 = [
    -Math.sin(yaw) * Math.sin(pitch),
    Math.cos(pitch),
    -Math.cos(yaw) * Math.sin(pitch),
  ];
  const edge = boxExit(pivot, dir, room);
  const reach = edge * pose.distance;
  const cut = Math.max(Math.min(reach, edge) - CUT_DEPTH, Math.min(reach, edge) / 2);
  const along = (t: number): Vec3 => [
    pivot[0] + dir[0] * t,
    pivot[1] + dir[1] * t,
    pivot[2] + dir[2] * t,
  ];
  const plane = along(cut);
  return {
    camera: { position: along(reach), target: pivot, up, fovY: pose.fovY },
    clip: { normal: dir, offset: dir[0] * plane[0] + dir[1] * plane[1] + dir[2] * plane[2] },
  };
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
      "The depth model found no surface in the master, so it cannot be drawn from another " +
        "camera. Make the image without an orbit of it.",
    );
  }
  return roomFrame(mesh);
}

/**
 * Draws the master at `masterFile` from `pose` into `outputFile` at `size`, the master's point map
 * kept under `cacheDir`.
 */
export async function renderOrbit(options: {
  masterFile: string;
  pose: OrbitPose;
  size: { width: number; height: number };
  outputFile: string;
  cacheDir?: string;
}): Promise<void> {
  const master = await readRgbImage(options.masterFile);
  const { mesh, room } = await masterScene(options.masterFile, master, options.cacheDir);
  const { camera, clip } = orbitCamera(options.pose, room);
  const image = renderColor([mesh], camera, options.size, { background: BACKGROUND, clip });
  await writePng(image, options.outputFile);
}
