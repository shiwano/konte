import { describe, expect, it } from "vitest";
import type { PointMap } from "../moge.js";
import type { RgbImage } from "../rgb-image.js";
import { orbitCamera, orbitSize } from "../image-orbit.js";
import { pointMapMesh, renderColor, roomFrame, type Mesh, type Vec3 } from "../view-scene.js";

const texture = (width: number, height: number, rgb: Vec3): RgbImage => {
  const data = new Uint8Array(width * height * 3);
  for (let i = 0; i < width * height; i++) data.set(rgb, i * 3);
  return { width, height, data };
};

// A square facing the camera at distance `z`, `size` metres across, in one colour.
function square(z: number, size: number, rgb: Vec3): Mesh {
  const h = size / 2;
  return {
    positions: Float32Array.from([-h, -h, -z, h, -h, -z, h, h, -z, -h, h, -z]),
    uv: Float32Array.from([0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5]),
    indices: Uint32Array.from([0, 1, 2, 0, 2, 3]),
    texture: texture(1, 1, rgb),
  };
}

const target = { width: 16, height: 8 };
const camera = { position: [0, 0, 0] as Vec3, target: [0, 0, -1] as Vec3, fovY: 60 };

describe("pointMapMesh", () => {
  const map = (depth: (x: number, y: number) => number): PointMap => {
    const width = 8;
    const height = 8;
    const points = new Float32Array(width * height * 3);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const k = y * width + x;
        points.set([x - 4, y - 4, depth(x, y)], k * 3);
      }
    }
    return { width, height, points, fovX: 60 };
  };

  it("joins every other pixel into two triangles a quad, y up and -z forward", () => {
    const mesh = pointMapMesh(
      map(() => 5),
      texture(8, 8, [0, 0, 0]),
    );
    expect(mesh.positions.length / 3).toBe(16);
    expect(mesh.indices.length / 3).toBe(2 * 3 * 3);
    expect(Array.from(mesh.positions.slice(0, 3))).toEqual([-4, 4, -5]);
    expect(Array.from(mesh.uv.slice(0, 2))).toEqual([0.5, 0.5]);
  });

  it("drops the pixels along a depth edge", () => {
    const mesh = pointMapMesh(
      map((x) => (x < 4 ? 2 : 6)),
      texture(8, 8, [0, 0, 0]),
    );
    expect(mesh.positions.length / 3).toBe(12);
  });
});

describe("roomFrame", () => {
  // A floor 1.5 m below a camera pitched down 10°, plus a far wall, as the camera sees them.
  function tiltedRoom(): Mesh {
    const pitch = (10 * Math.PI) / 180;
    const positions: number[] = [];
    const indices: number[] = [];
    const grid = (at: (u: number, v: number) => Vec3) => {
      const base = positions.length / 3;
      const n = 20;
      for (let j = 0; j <= n; j++) {
        for (let i = 0; i <= n; i++) {
          const [x, y, z] = at(i / n, j / n);
          positions.push(
            x,
            y * Math.cos(pitch) + z * Math.sin(pitch),
            -y * Math.sin(pitch) + z * Math.cos(pitch),
          );
        }
      }
      for (let j = 0; j < n; j++) {
        for (let i = 0; i < n; i++) {
          const a = base + j * (n + 1) + i;
          indices.push(a, a + n + 1, a + 1, a + 1, a + n + 1, a + n + 2);
        }
      }
    };
    grid((u, v) => [-2 + 4 * u, -1.5, -1 - 5 * v]);
    grid((u, v) => [-2 + 4 * u, -1.5 + 3 * v, -6]);
    return {
      positions: Float32Array.from(positions),
      uv: new Float32Array((positions.length / 3) * 2),
      indices: Uint32Array.from(indices),
      texture: texture(1, 1, [0, 0, 0]),
    };
  }

  it("levels the floor at y = 0 and reads the master camera's height", () => {
    const scene = roomFrame(tiltedRoom());
    expect(scene.room.eye).toBeCloseTo(1.5, 2);
    expect(scene.room.x[0]).toBeCloseTo(-2, 1);
    expect(scene.room.x[1]).toBeCloseTo(2, 1);
    expect(scene.room.z[0]).toBeCloseTo(-6, 1);
    expect(scene.room.ceiling).toBeCloseTo(3, 1);
    expect(scene.mesh.positions[1]).toBeCloseTo(0, 3);
  });

  it("takes the master's camera as level over its lowest point when no floor shows", () => {
    const wall = square(4, 2, [0, 0, 0]);
    const scene = roomFrame(wall);
    expect(scene.room.eye).toBeCloseTo(1, 3);
    expect(Array.from(scene.mesh.positions.slice(0, 3))).toEqual([-1, 0, -4]);
  });
});

describe("renderColor", () => {
  it("paints the surface's texture over the background", () => {
    const image = renderColor([square(2, 1, [255, 0, 0])], camera, target, {
      background: [128, 128, 128],
    });
    expect(Array.from(image.data.slice((4 * 16 + 8) * 3, (4 * 16 + 8) * 3 + 3))).toEqual([
      255, 0, 0,
    ]);
    expect(Array.from(image.data.slice(0, 3))).toEqual([128, 128, 128]);
  });

  it("clips what is nearer than the camera's near plane", () => {
    const image = renderColor(
      [square(4, 10, [0, 0, 255]), square(1, 10, [255, 0, 0])],
      { ...camera, near: 2 },
      target,
      { background: [128, 128, 128] },
    );
    expect(Array.from(image.data.slice((4 * 16 + 8) * 3, (4 * 16 + 8) * 3 + 3))).toEqual([
      0, 0, 255,
    ]);
  });

  it("drops what lies beyond a clip plane", () => {
    const image = renderColor([square(2, 10, [255, 0, 0])], camera, target, {
      background: [128, 128, 128],
      clip: { normal: [0, 0, 1], offset: -3 },
    });
    expect(Array.from(image.data.slice(0, 3))).toEqual([128, 128, 128]);
  });
});

describe("orbitCamera", () => {
  const room = {
    eye: 1.2,
    x: [-2, 3] as [number, number],
    z: [-6, -0.5] as [number, number],
    ceiling: 3,
  };
  const pose = { yaw: 0, pitch: 0, distance: 1, fovY: 45 };
  const close = (v: number[], want: number[]): void =>
    v.forEach((x, i) => expect(x).toBeCloseTo(want[i]!));

  it("stands a yaw of -90 on the left wall, facing the room's centre at eye height", () => {
    const { camera, clip } = orbitCamera({ ...pose, yaw: -90 }, room);
    close(camera.position, [-2, 1.2, -3.25]);
    close(camera.target, [0.5, 1.2, -3.25]);
    close(clip.normal, [-1, 0, 0]);
    expect(clip.offset).toBeCloseTo(0.8);
  });

  it("looks straight down from the ceiling at a pitch of 90, the far wall up", () => {
    const { camera, clip } = orbitCamera({ ...pose, pitch: 90 }, room);
    close(camera.position, [0.5, 3, -3.25]);
    close(camera.up!, [0, 0, -1]);
    expect(clip.offset).toBeCloseTo(2.1);
  });

  it("backs out past the wall by distance, keeping the cut at the wall", () => {
    const { camera, clip } = orbitCamera({ ...pose, yaw: -90, distance: 2 }, room);
    close(camera.position, [-4.5, 1.2, -3.25]);
    expect(clip.offset).toBeCloseTo(0.8);
  });
});

describe("orbitSize", () => {
  it("keeps the canvas's aspect at about a megapixel", () => {
    expect(orbitSize({ width: 2496, height: 1248 })).toEqual({ width: 1424, height: 712 });
  });
});
