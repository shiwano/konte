import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { KonteError } from "../errors.js";
import {
  isProjectModule,
  loadVideoDefinition,
  projectRootPrefixes,
  resolveKontePackageRoot,
} from "../loader.js";

const fixturesDir = path.resolve(import.meta.dirname, "fixtures");
const badSchemaPath = path.join(fixturesDir, "bad-schema-video.ts");
const throwingPath = path.join(fixturesDir, "throwing-video.ts");

afterAll(() => {
  for (const p of [badSchemaPath, throwingPath]) {
    if (fs.existsSync(p)) fs.unlinkSync(p);
  }
});

describe("loadVideoDefinition", () => {
  it("loads a valid video definition", async () => {
    const video = await loadVideoDefinition(path.join(fixturesDir, "valid-video.ts"));
    expect(video.format.fps).toBe(30);
    expect(video.format.size).toEqual({ width: 1024, height: 576 });
    expect(video.shots).toHaveLength(2);
    expect(video.shots[0]!.id).toBe("01");
    expect(video.shots[1]!.id).toBe("02");
  });

  it("throws LOAD_FAILED when file does not exist", async () => {
    let error: unknown;
    try {
      await loadVideoDefinition(path.join(fixturesDir, "nonexistent.ts"));
      expect.unreachable("Expected to throw");
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(KonteError);
    expect((error as KonteError).code).toBe("LOAD_FAILED");
  });

  it("throws LOAD_FAILED when file has no default export", async () => {
    let error: unknown;
    try {
      await loadVideoDefinition(path.join(fixturesDir, "invalid-video.ts"));
      expect.unreachable("Expected to throw");
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(KonteError);
    expect((error as KonteError).code).toBe("LOAD_FAILED");
  });

  it("keeps the code of a KonteError the definition throws, naming the file", async () => {
    fs.writeFileSync(
      throwingPath,
      'import { KonteError } from "../../errors.js";\n' +
        'throw new KonteError("ADAPTER_OUT_OF_SCOPE", "out of scope", ["item"]);\n',
    );
    let error: unknown;
    try {
      await loadVideoDefinition(throwingPath);
      expect.unreachable("Expected to throw");
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(KonteError);
    expect((error as KonteError).code).toBe("ADAPTER_OUT_OF_SCOPE");
    expect((error as KonteError).headline).toBe(`video file "${throwingPath}": out of scope`);
    expect((error as KonteError).items).toEqual(["item"]);
  });

  it("names the imported file a KonteError was thrown in", async () => {
    const imported = path.join(fixturesDir, "throwing-import.ts");
    fs.writeFileSync(
      imported,
      'import { KonteError } from "../../errors.js";\n' +
        'throw new KonteError("VALIDATION_FAILED", "bad span");\n',
    );
    fs.writeFileSync(throwingPath, 'import "./throwing-import.ts";\n');
    try {
      const error = await loadVideoDefinition(throwingPath).catch((e: unknown) => e);
      expect((error as KonteError).headline).toBe(
        `"${imported}" (imported by video file "${throwingPath}"): bad span`,
      );
    } finally {
      fs.unlinkSync(imported);
    }
  });

  it("names the imported file a plain Error was thrown in", async () => {
    const imported = path.join(fixturesDir, "throwing-plain-import.ts");
    fs.writeFileSync(imported, 'throw new Error("bad adapter");\n');
    fs.writeFileSync(throwingPath, 'import "./throwing-plain-import.ts";\n');
    try {
      const error = await loadVideoDefinition(throwingPath).catch((e: unknown) => e);
      expect((error as KonteError).code).toBe("LOAD_FAILED");
      expect((error as KonteError).headline).toBe(
        `Failed to load "${imported}" (imported by video file "${throwingPath}"): bad adapter`,
      );
    } finally {
      fs.unlinkSync(imported);
    }
  });

  it("names an imported file whose path holds a space", async () => {
    const dir = path.join(fixturesDir, "with space");
    const imported = path.join(dir, "throwing-import.ts");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(imported, 'function f() {\n  throw new Error("bad adapter");\n}\nf();\n');
    fs.writeFileSync(throwingPath, 'import "./with space/throwing-import.ts";\n');
    try {
      const error = await loadVideoDefinition(throwingPath).catch((e: unknown) => e);
      expect((error as KonteError).headline).toBe(
        `Failed to load "${imported}" (imported by video file "${throwingPath}"): bad adapter`,
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("names a shared file outside the project a plain Error was thrown in", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "konte-shared-"));
    const shared = path.join(dir, "shared-adapter.ts");
    fs.writeFileSync(shared, 'throw new Error("bad shared adapter");\n');
    fs.writeFileSync(throwingPath, `import ${JSON.stringify(shared)};\n`);
    try {
      const error = await loadVideoDefinition(throwingPath).catch((e: unknown) => e);
      expect((error as KonteError).headline).toBe(
        `Failed to load "${fs.realpathSync(shared)}" (imported by video file "${throwingPath}"): bad shared adapter`,
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps LOAD_FAILED when the thrown error's stack cannot be read", async () => {
    fs.writeFileSync(
      throwingPath,
      'const err = new Error("bad stack");\n' +
        'Object.defineProperty(err, "stack", { get() { throw new Error("no stack"); } });\n' +
        "throw err;\n",
    );
    const error = await loadVideoDefinition(throwingPath).catch((e: unknown) => e);
    expect((error as KonteError).code).toBe("LOAD_FAILED");
    expect((error as KonteError).headline).toBe(
      `Failed to load video file "${throwingPath}": bad stack`,
    );
  });

  it("throws VALIDATION_FAILED for duplicate shot IDs", async () => {
    let error: unknown;
    try {
      await loadVideoDefinition(path.join(fixturesDir, "duplicate-shot-video.ts"));
      expect.unreachable("Expected to throw");
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(KonteError);
    expect((error as KonteError).code).toBe("VALIDATION_FAILED");
  });

  it("throws VALIDATION_FAILED when default export is not a valid VideoDefinition", async () => {
    fs.writeFileSync(badSchemaPath, "export default { id: 123, bad: true };\n");
    let error: unknown;
    try {
      await loadVideoDefinition(badSchemaPath);
      expect.unreachable("Expected to throw");
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(KonteError);
    expect((error as KonteError).code).toBe("VALIDATION_FAILED");
  });
});

describe("resolveKontePackageRoot", () => {
  it("takes the checkout root when it carries a package.json (dev/test layout)", () => {
    const root = resolveKontePackageRoot(
      "file:///home/u/konte/src/core/loader.ts",
      (dir) => dir === "/home/u/konte",
    );
    expect(root).toBe("/home/u/konte/");
  });

  it("keeps the bundle dir in a compiled binary, never the filesystem root", () => {
    const root = resolveKontePackageRoot("file:///$bunfs/root/konte", () => false);
    expect(root).toBe("/$bunfs/root/");
  });

  it("keeps the bundle dir even when the host has a /package.json", () => {
    const root = resolveKontePackageRoot("file:///$bunfs/root/konte", () => true);
    expect(root).toBe("/$bunfs/root/");
  });

  it("refuses a root with no parent", () => {
    expect(resolveKontePackageRoot("file:///konte", () => true)).toBeNull();
    expect(resolveKontePackageRoot(undefined, () => true)).toBeNull();
  });
});

describe("projectRootPrefixes", () => {
  let workspaceRoot: string;

  beforeEach(() => {
    workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "konte-ws-"));
    fs.writeFileSync(path.join(workspaceRoot, "konte.config.json"), "{}\n");
    fs.mkdirSync(path.join(workspaceRoot, "videos", "amedama"), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  });

  // The regression: adapters/ lives at the workspace root, so a reload that only knew the video
  // root left every adapter module pinned in a long-lived process.
  it("covers the workspace root a video's adapters live in", () => {
    const videoRoot = path.join(workspaceRoot, "videos", "amedama");
    const prefixes = projectRootPrefixes(videoRoot);
    expect(prefixes).toEqual([`${videoRoot}${path.sep}`, `${workspaceRoot}${path.sep}`]);
    // Asserted with no konte package root, so the roots have to carry the adapter themselves: the
    // "on disk and outside konte's runtime" fallback would otherwise hide a missing prefix.
    const adapter = path.join(workspaceRoot, "adapters", "comfy", "x.ts");
    expect(isProjectModule(adapter, prefixes, null)).toBe(true);
    expect(isProjectModule(path.join(videoRoot, "animatic.tsx"), prefixes, null)).toBe(true);
  });

  it("falls back to the video root alone outside any workspace", () => {
    const orphan = fs.mkdtempSync(path.join(os.tmpdir(), "konte-orphan-"));
    try {
      expect(projectRootPrefixes(orphan)).toEqual([`${orphan}${path.sep}`]);
    } finally {
      fs.rmSync(orphan, { recursive: true, force: true });
    }
  });

  it("does not repeat the prefix when the video root is the workspace root", () => {
    expect(projectRootPrefixes(workspaceRoot)).toEqual([`${workspaceRoot}${path.sep}`]);
  });
});

describe("isProjectModule", () => {
  const videoRoot = "/w/videos/amedama/";
  const workspaceRoot = "/w/";
  const prefixes = [videoRoot, workspaceRoot];

  it("evicts a workspace adapter, which sits above the video root", () => {
    expect(isProjectModule("/w/adapters/comfy/x.ts", prefixes, "/$bunfs/root/")).toBe(true);
  });

  it("evicts the video's own definition files", () => {
    expect(isProjectModule("/w/videos/amedama/animatic.tsx", prefixes, "/$bunfs/root/")).toBe(true);
  });

  it("keeps konte's own runtime and dependencies", () => {
    expect(isProjectModule("/$bunfs/root/konte", prefixes, "/$bunfs/root/")).toBe(false);
    expect(isProjectModule("/home/u/konte/src/dsl/index.ts", prefixes, "/home/u/konte/")).toBe(
      false,
    );
    expect(isProjectModule("/w/node_modules/zod/index.js", prefixes, "/$bunfs/root/")).toBe(false);
    expect(isProjectModule("konte", prefixes, "/$bunfs/root/")).toBe(false);
  });

  it("evicts a shared module imported from outside the workspace", () => {
    expect(isProjectModule("/shared/adapters/x.ts", prefixes, "/$bunfs/root/")).toBe(true);
  });

  it("evicts only the project roots when konte's root is unknown", () => {
    expect(isProjectModule("/w/adapters/comfy/x.ts", prefixes, null)).toBe(true);
    expect(isProjectModule("/shared/adapters/x.ts", prefixes, null)).toBe(false);
  });
});
