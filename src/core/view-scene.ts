import type { PointMap } from "./moge.js";
import type { RgbImage } from "./rgb-image.js";

// A location's master turned into a textured mesh in a room frame — floor at y = 0, +Y up, the
// master's camera on the y axis looking down -Z — and drawn from another camera by a software
// rasterizer.

export type Vec3 = [number, number, number];

/**
 * Triangles over a point map's pixels, positions in a right-handed frame (x right, y up, -z
 * forward). `uv` is each vertex's pixel centre in `texture`.
 */
export type Mesh = {
  positions: Float32Array;
  uv: Float32Array;
  indices: Uint32Array;
  texture: RgbImage;
};

const DECIMATION = 2;
const EDGE_RTOL = 0.04;

/**
 * Two triangles per quad of valid pixels on every `DECIMATION`th pixel, after dropping each pixel
 * whose 3×3 depth span exceeds `EDGE_RTOL` of its depth — ComfyUI's `MoGePointMapToMesh`.
 */
export function pointMapMesh(map: PointMap, texture: RgbImage): Mesh {
  const { width: W, height: H, points } = map;
  const depth = new Float32Array(W * H);
  for (let k = 0; k < W * H; k++) {
    const z = points[k * 3 + 2]!;
    depth[k] = Number.isFinite(z) ? z : 0;
  }
  const keep = (x: number, y: number): boolean => {
    const k = y * W + x;
    if (!Number.isFinite(points[k * 3 + 2]!)) return false;
    let lo = Infinity;
    let hi = -Infinity;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const xx = x + dx;
        const yy = y + dy;
        if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue;
        const d = depth[yy * W + xx]!;
        lo = Math.min(lo, d);
        hi = Math.max(hi, d);
      }
    }
    return (hi - lo) / Math.max(depth[k]!, 1e-6) <= EDGE_RTOL;
  };
  const w = Math.ceil(W / DECIMATION);
  const h = Math.ceil(H / DECIMATION);
  const index = new Int32Array(w * h).fill(-1);
  const positions: number[] = [];
  const uv: number[] = [];
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      const x = i * DECIMATION;
      const y = j * DECIMATION;
      if (!keep(x, y)) continue;
      const k = y * W + x;
      index[j * w + i] = positions.length / 3;
      positions.push(points[k * 3]!, -points[k * 3 + 1]!, -points[k * 3 + 2]!);
      uv.push(x + 0.5, y + 0.5);
    }
  }
  const indices: number[] = [];
  for (let j = 0; j + 1 < h; j++) {
    for (let i = 0; i + 1 < w; i++) {
      const a = index[j * w + i]!;
      const b = index[j * w + i + 1]!;
      const c = index[(j + 1) * w + i + 1]!;
      const d = index[(j + 1) * w + i]!;
      if (a < 0 || b < 0 || c < 0 || d < 0) continue;
      indices.push(a, c, b, a, d, c);
    }
  }
  return {
    positions: Float32Array.from(positions),
    uv: Float32Array.from(uv),
    indices: Uint32Array.from(indices),
    texture,
  };
}

/** The triangles `keep` passes, by index into `mesh.indices / 3`. */
function filterTriangles(mesh: Mesh, keep: (t: number) => boolean): Mesh {
  const out: number[] = [];
  for (let t = 0; t < mesh.indices.length / 3; t++) {
    if (keep(t)) out.push(mesh.indices[t * 3]!, mesh.indices[t * 3 + 1]!, mesh.indices[t * 3 + 2]!);
  }
  return { ...mesh, indices: Uint32Array.from(out) };
}

function vertex(mesh: Mesh, i: number): Vec3 {
  return [mesh.positions[i * 3]!, mesh.positions[i * 3 + 1]!, mesh.positions[i * 3 + 2]!];
}

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scale = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const norm = (a: Vec3): Vec3 => scale(a, 1 / (Math.hypot(a[0], a[1], a[2]) || 1));

/**
 * Drops each triangle seen nearly edge-on from the camera at the origin (|cos| between its normal
 * and the line of sight under `minCos`): a surface the camera barely saw, stretched across depth.
 */
export function dropGrazing(mesh: Mesh, minCos: number): Mesh {
  return filterTriangles(mesh, (t) => {
    const a = vertex(mesh, mesh.indices[t * 3]!);
    const b = vertex(mesh, mesh.indices[t * 3 + 1]!);
    const c = vertex(mesh, mesh.indices[t * 3 + 2]!);
    const n = cross(sub(b, a), sub(c, a));
    if (dot(n, n) === 0) return false;
    return Math.abs(dot(norm(n), norm(add(add(a, b), c)))) >= minCos;
  });
}

/** Area-weighted vertex normals, zero on a vertex no triangle uses. */
function vertexNormals(mesh: Mesh): Float32Array {
  const out = new Float32Array(mesh.positions.length);
  for (let t = 0; t < mesh.indices.length; t += 3) {
    const ia = mesh.indices[t]!;
    const ib = mesh.indices[t + 1]!;
    const ic = mesh.indices[t + 2]!;
    const a = vertex(mesh, ia);
    const n = cross(sub(vertex(mesh, ib), a), sub(vertex(mesh, ic), a));
    for (const i of [ia, ib, ic]) {
      out[i * 3] = out[i * 3]! + n[0];
      out[i * 3 + 1] = out[i * 3 + 1]! + n[1];
      out[i * 3 + 2] = out[i * 3 + 2]! + n[2];
    }
  }
  for (let i = 0; i < out.length; i += 3) {
    const l = Math.hypot(out[i]!, out[i + 1]!, out[i + 2]!);
    if (l > 0) {
      out[i] = out[i]! / l;
      out[i + 1] = out[i + 1]! / l;
      out[i + 2] = out[i + 2]! / l;
    }
  }
  return out;
}

function percentile(values: Float32Array | number[], p: number): number {
  const a = Float64Array.from(values).sort();
  return a[Math.min(a.length - 1, Math.max(0, Math.floor((p / 100) * (a.length - 1))))]!;
}

// The least a floor lies below the master's camera.
const MIN_EYE = 0.5;

/**
 * RANSAC over `points` for the plane holding the most of them within `tol`, its normal mostly up and
 * at least `MIN_EYE` below the origin.
 */
function fitFloor(points: number[], tol: number): { n: Vec3; d: number } | null {
  const count = points.length / 3;
  if (count < 3) return null;
  let seed = 12345;
  const pick = (): Vec3 => {
    seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
    const i = 3 * Math.floor((seed / 2 ** 32) * count);
    return [points[i]!, points[i + 1]!, points[i + 2]!];
  };
  let best: { n: Vec3; d: number } | null = null;
  let bestCount = -1;
  for (let it = 0; it < 400; it++) {
    const a = pick();
    let n = cross(sub(pick(), a), sub(pick(), a));
    if (dot(n, n) < 1e-12) continue;
    n = norm(n);
    if (n[1] < 0) n = scale(n, -1);
    if (n[1] < 0.8) continue;
    const d = -dot(n, a);
    if (d < MIN_EYE) continue;
    let inliers = 0;
    for (let j = 0; j < points.length; j += 3) {
      if (Math.abs(n[0] * points[j]! + n[1] * points[j + 1]! + n[2] * points[j + 2]! + d) < tol) {
        inliers++;
      }
    }
    if (inliers > bestCount) {
      bestCount = inliers;
      best = { n, d };
    }
  }
  return best;
}

/** A row-major 3×3 rotation. */
type Mat3 = [number, number, number, number, number, number, number, number, number];

const apply = (m: Mat3, v: Vec3): Vec3 => [
  m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
  m[3] * v[0] + m[4] * v[1] + m[5] * v[2],
  m[6] * v[0] + m[7] * v[1] + m[8] * v[2],
];

const mul = (a: Mat3, b: Mat3): Mat3 => {
  const out = new Array<number>(9);
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) {
      out[r * 3 + c] = a[r * 3]! * b[c]! + a[r * 3 + 1]! * b[3 + c]! + a[r * 3 + 2]! * b[6 + c]!;
    }
  }
  return out as Mat3;
};

/** The shortest rotation taking unit `from` onto unit `to`. */
function rotationBetween(from: Vec3, to: Vec3): Mat3 {
  const v = cross(from, to);
  const c = dot(from, to);
  const k = 1 / (1 + c);
  return [
    v[0] * v[0] * k + c,
    v[0] * v[1] * k - v[2],
    v[0] * v[2] * k + v[1],
    v[1] * v[0] * k + v[2],
    v[1] * v[1] * k + c,
    v[1] * v[2] * k - v[0],
    v[2] * v[0] * k - v[1],
    v[2] * v[1] * k + v[0],
    v[2] * v[2] * k + c,
  ];
}

function rotationY(angle: number): Mat3 {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  return [c, 0, s, 0, 1, 0, -s, 0, c];
}

/**
 * The room the master shows, its extent read off the mesh: `x` and `z` its 1st–99th percentiles
 * (`z[0]` the far wall, `z[1]` never past the master's camera), `ceiling` the 99th of y, `eye` the
 * master camera's height.
 */
export type Room = { eye: number; x: [number, number]; z: [number, number]; ceiling: number };

/**
 * The master's mesh moved into the room frame: the floor — a RANSAC plane through the upward-facing
 * vertices below the median height — rotated onto y = 0, then turned about Y so the master's camera
 * looks down -Z. With no floor found, the master's camera is taken as level and the floor as the
 * mesh's 1st percentile of height, at least `MIN_EYE` below the camera.
 */
export function roomFrame(mesh: Mesh): { mesh: Mesh; room: Room } {
  const normals = vertexNormals(mesh);
  const count = mesh.positions.length / 3;
  const ys = new Float32Array(count);
  for (let i = 0; i < count; i++) ys[i] = mesh.positions[i * 3 + 1]!;
  const yMid = percentile(ys, 50);
  const candidates: number[] = [];
  for (let i = 0; i < count; i++) {
    if (ys[i]! < yMid && Math.abs(normals[i * 3 + 1]!) > 0.85) {
      candidates.push(mesh.positions[i * 3]!, ys[i]!, mesh.positions[i * 3 + 2]!);
    }
  }
  const span = percentile(ys, 98) - percentile(ys, 2);
  const floor = fitFloor(candidates, span * 0.01) ?? {
    n: [0, 1, 0] as Vec3,
    d: Math.max(-percentile(ys, 1), MIN_EYE),
  };
  const align = rotationBetween(floor.n, [0, 1, 0]);
  const forward = apply(align, [0, 0, -1]);
  const yaw = Math.atan2(forward[0], -forward[2]);
  const rotation = mul(rotationY(yaw), align);
  const positions = new Float32Array(mesh.positions.length);
  for (let i = 0; i < count; i++) {
    const p = apply(rotation, vertex(mesh, i));
    positions[i * 3] = p[0];
    positions[i * 3 + 1] = p[1] + floor.d;
    positions[i * 3 + 2] = p[2];
  }
  const xs = new Float32Array(count);
  const zs = new Float32Array(count);
  const hs = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    xs[i] = positions[i * 3]!;
    hs[i] = positions[i * 3 + 1]!;
    zs[i] = positions[i * 3 + 2]!;
  }
  return {
    mesh: { ...mesh, positions },
    room: {
      eye: floor.d,
      x: [percentile(xs, 1), percentile(xs, 99)],
      z: [percentile(zs, 1), Math.min(0, percentile(zs, 99))],
      ceiling: percentile(hs, 99),
    },
  };
}

/** A pinhole camera: `fovY` the vertical field of view in degrees, `near` its clipping distance. */
export type Camera = { position: Vec3; target: Vec3; up?: Vec3; fovY: number; near?: number };

/** World → camera (right-handed, looking down -Z), as rows of a 3×4 matrix. */
function viewMatrix(camera: Camera): { r: Mat3; t: Vec3 } {
  const zAxis = norm(sub(camera.position, camera.target));
  const xAxis = norm(cross(camera.up ?? [0, 1, 0], zAxis));
  const yAxis = cross(zAxis, xAxis);
  const r: Mat3 = [...xAxis, ...yAxis, ...zAxis];
  return { r, t: scale(apply(r, camera.position), -1) };
}

type Target = { width: number; height: number };

/** A clip plane in world space: what lies where `dot(normal, p) > offset` is not drawn. */
export type ClipPlane = { normal: Vec3; offset: number };

type Raster = {
  width: number;
  height: number;
  depth: Float32Array;
  color: Float32Array;
};

// One clipped vertex: camera-space position and texture coordinate.
type ClipVertex = { c: Vec3; u: number; v: number };

function clipPolygon(poly: ClipVertex[], dist: (v: ClipVertex) => number): ClipVertex[] {
  const out: ClipVertex[] = [];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i]!;
    const b = poly[(i + 1) % poly.length]!;
    const da = dist(a);
    const db = dist(b);
    if (da >= 0) out.push(a);
    if (da >= 0 !== db >= 0) {
      const t = da / (da - db);
      out.push({
        c: add(a.c, scale(sub(b.c, a.c), t)),
        u: a.u + (b.u - a.u) * t,
        v: a.v + (b.v - a.v) * t,
      });
    }
  }
  return out;
}

function sampleBilinear(tex: RgbImage, u: number, v: number, out: Float32Array, at: number): void {
  const x = Math.min(tex.width - 1, Math.max(0, u - 0.5));
  const y = Math.min(tex.height - 1, Math.max(0, v - 0.5));
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const x1 = Math.min(tex.width - 1, x0 + 1);
  const y1 = Math.min(tex.height - 1, y0 + 1);
  const tx = x - x0;
  const ty = y - y0;
  const d = tex.data;
  const i00 = (y0 * tex.width + x0) * 3;
  const i10 = (y0 * tex.width + x1) * 3;
  const i01 = (y1 * tex.width + x0) * 3;
  const i11 = (y1 * tex.width + x1) * 3;
  for (let k = 0; k < 3; k++) {
    out[at + k] =
      (d[i00 + k]! * (1 - tx) + d[i10 + k]! * tx) * (1 - ty) +
      (d[i01 + k]! * (1 - tx) + d[i11 + k]! * tx) * ty;
  }
}

function rasterize(raster: Raster, mesh: Mesh, camera: Camera, clip: ClipPlane | undefined): void {
  const { width: W, height: H, color } = raster;
  const { r, t } = viewMatrix(camera);
  const f = 1 / Math.tan(((camera.fovY / 2) * Math.PI) / 180);
  const aspect = W / H;
  const near = camera.near ?? 0.01;
  const clipCam = clip
    ? (() => {
        const n = apply(r, clip.normal);
        return { n, offset: clip.offset + dot(n, t) };
      })()
    : null;
  const pos = mesh.positions;
  const toCam = (i: number): Vec3 =>
    add(apply(r, [pos[i * 3]!, pos[i * 3 + 1]!, pos[i * 3 + 2]!]), t);
  const sx = new Float64Array(8);
  const sy = new Float64Array(8);
  const iz = new Float64Array(8);
  const uz = new Float64Array(8);
  const vz = new Float64Array(8);
  for (let tri = 0; tri < mesh.indices.length; tri += 3) {
    let poly: ClipVertex[] = [];
    for (let k = 0; k < 3; k++) {
      const i = mesh.indices[tri + k]!;
      poly.push({ c: toCam(i), u: mesh.uv[i * 2]!, v: mesh.uv[i * 2 + 1]! });
    }
    poly = clipPolygon(poly, (p) => -p.c[2] - near);
    if (clipCam && poly.length >= 3) {
      poly = clipPolygon(poly, (p) => clipCam.offset - dot(clipCam.n, p.c));
    }
    if (poly.length < 3) continue;
    for (let k = 0; k < poly.length; k++) {
      const p = poly[k]!;
      const z = -p.c[2];
      sx[k] = ((((f / aspect) * p.c[0]) / z + 1) / 2) * W;
      sy[k] = ((1 - (f * p.c[1]) / z) / 2) * H;
      iz[k] = 1 / z;
      uz[k] = p.u / z;
      vz[k] = p.v / z;
    }
    for (let k = 1; k + 1 < poly.length; k++) {
      drawTriangle(raster, mesh.texture, [0, k, k + 1], sx, sy, iz, uz, vz, color);
    }
  }
}

function drawTriangle(
  raster: Raster,
  texture: RgbImage,
  [a, b, c]: [number, number, number],
  sx: Float64Array,
  sy: Float64Array,
  iz: Float64Array,
  uz: Float64Array,
  vz: Float64Array,
  color: Float32Array,
): void {
  const { width: W, height: H, depth } = raster;
  const ax = sx[a]!;
  const ay = sy[a]!;
  const bx = sx[b]!;
  const by = sy[b]!;
  const cx = sx[c]!;
  const cy = sy[c]!;
  const area = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
  if (area === 0) return;
  const minX = Math.max(0, Math.floor(Math.min(ax, bx, cx)));
  const maxX = Math.min(W - 1, Math.ceil(Math.max(ax, bx, cx)));
  const minY = Math.max(0, Math.floor(Math.min(ay, by, cy)));
  const maxY = Math.min(H - 1, Math.ceil(Math.max(ay, by, cy)));
  const inv = 1 / area;
  for (let y = minY; y <= maxY; y++) {
    const py = y + 0.5;
    for (let x = minX; x <= maxX; x++) {
      const px = x + 0.5;
      const w0 = ((bx - px) * (cy - py) - (by - py) * (cx - px)) * inv;
      const w1 = ((cx - px) * (ay - py) - (cy - py) * (ax - px)) * inv;
      const w2 = 1 - w0 - w1;
      if (w0 < 0 || w1 < 0 || w2 < 0) continue;
      const z = w0 * iz[a]! + w1 * iz[b]! + w2 * iz[c]!;
      const d = 1 / z;
      const at = y * W + x;
      if (d >= depth[at]!) continue;
      depth[at] = d;
      const u = (w0 * uz[a]! + w1 * uz[b]! + w2 * uz[c]!) * d;
      const v = (w0 * vz[a]! + w1 * vz[b]! + w2 * vz[c]!) * d;
      sampleBilinear(texture, u, v, color, at * 3);
    }
  }
}

const SUPERSAMPLE = 2;

/**
 * The meshes drawn unlit from `camera` at `target`'s size, `background` where nothing is, each
 * pixel the mean of a 2×2 supersample.
 */
export function renderColor(
  meshes: readonly Mesh[],
  camera: Camera,
  target: Target,
  options: { background: Vec3; clip?: ClipPlane },
): RgbImage {
  const W = target.width * SUPERSAMPLE;
  const H = target.height * SUPERSAMPLE;
  const color = new Float32Array(W * H * 3);
  for (let i = 0; i < W * H; i++) color.set(options.background, i * 3);
  const raster: Raster = {
    width: W,
    height: H,
    depth: new Float32Array(W * H).fill(Infinity),
    color,
  };
  for (const mesh of meshes) rasterize(raster, mesh, camera, options.clip);
  const data = new Uint8Array(target.width * target.height * 3);
  const n = SUPERSAMPLE * SUPERSAMPLE;
  for (let y = 0; y < target.height; y++) {
    for (let x = 0; x < target.width; x++) {
      for (let k = 0; k < 3; k++) {
        let s = 0;
        for (let dy = 0; dy < SUPERSAMPLE; dy++) {
          for (let dx = 0; dx < SUPERSAMPLE; dx++) {
            s += color[((y * SUPERSAMPLE + dy) * W + x * SUPERSAMPLE + dx) * 3 + k]!;
          }
        }
        data[(y * target.width + x) * 3 + k] = Math.round(s / n);
      }
    }
  }
  return { width: target.width, height: target.height, data };
}
