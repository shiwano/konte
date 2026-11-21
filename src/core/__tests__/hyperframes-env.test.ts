import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { sha256Hex } from "../content-hash.js";
import { HYPERFRAME_MANIFEST, HYPERFRAME_RUNTIME } from "../generated/hyperframes-assets.js";
import { ensureHyperFramesEnv } from "../hyperframes-env.js";

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "konte-hyperframes-env-"));
  vi.stubEnv("KONTE_CACHE_DIR", dir);
  vi.stubEnv("PRODUCER_HYPERFRAME_MANIFEST_PATH", "");
});

afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(dir, { recursive: true, force: true });
});

it("rewrites an unmarked runtime directory and points HyperFrames at its manifest", async () => {
  const runtimeDir = path.join(
    dir,
    `hyperframes-${sha256Hex(HYPERFRAME_MANIFEST, HYPERFRAME_RUNTIME).slice(0, 16)}`,
  );
  fs.mkdirSync(runtimeDir, { recursive: true });
  fs.writeFileSync(path.join(runtimeDir, "hyperframe.manifest.json"), "{}");
  fs.writeFileSync(path.join(runtimeDir, "hyperframe.runtime.iife.js"), "");

  await ensureHyperFramesEnv();

  const manifest = path.join(runtimeDir, "hyperframe.manifest.json");
  expect(process.env.PRODUCER_HYPERFRAME_MANIFEST_PATH).toBe(manifest);
  expect(fs.readFileSync(manifest, "utf-8")).toBe(HYPERFRAME_MANIFEST);
  expect(fs.readFileSync(path.join(runtimeDir, "hyperframe.runtime.iife.js"), "utf-8")).toBe(
    HYPERFRAME_RUNTIME,
  );
  expect(fs.existsSync(path.join(runtimeDir, ".konte-verified"))).toBe(true);
});
