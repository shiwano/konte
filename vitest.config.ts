import { existsSync, readdirSync, readFileSync } from "node:fs";
import { availableParallelism } from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { configDefaults, defineConfig, type Plugin } from "vitest/config";
import { TRANSPILER_CACHE_DISABLED, TRANSPILER_CACHE_ENV } from "./src/cli/transpiler-cache.js";

// An adapter imports its craft guide, and a served page its markup, via
// `import x from "./y.md" with { type: "text" }` — Bun's runtime and bundler inline the file as a
// string, but vite/esbuild would try to parse it as JS. Load it as a default-string export instead
// so the test transform matches runtime behavior.
const TEXT_IMPORT_EXTS = [".md", ".html", ".css"];
const fileAsText: Plugin = {
  name: "file-as-text",
  enforce: "pre",
  load(id) {
    const file = id.split("?")[0]!;
    if (!TEXT_IMPORT_EXTS.some((ext) => file.endsWith(ext))) return null;
    return `export default ${JSON.stringify(readFileSync(file, "utf8"))};`;
  },
};

// A shipped adapter imports its guide via the `konte/guides/*` alias, which the workspace tsconfig's
// `paths` maps to `<workspaceRoot>/.konte/guides/*`. Bun's runtime honors that at load time; vite
// does not, so resolve it here the same way — walk up from the importer to the workspace that owns
// the `.konte/guides/` file. Per-importer, so each test's temp workspace resolves to its own guides.
const GUIDES_PREFIX = "konte/guides/";
const konteGuides: Plugin = {
  name: "konte-guides",
  enforce: "pre",
  resolveId(id, importer) {
    if (!id.startsWith(GUIDES_PREFIX) || !importer) return null;
    const rel = id.slice(GUIDES_PREFIX.length);
    const importerPath = importer.split("?")[0]!;
    let dir = path.dirname(
      importerPath.startsWith("file:") ? fileURLToPath(importerPath) : importerPath,
    );
    for (;;) {
      const candidate = path.join(dir, ".konte", "guides", rel);
      if (existsSync(candidate)) return candidate;
      const parent = path.dirname(dir);
      if (parent === dir) return null;
      dir = parent;
    }
  },
};

// A user file reaches anything under the workspace root via the `konte/workspace/*` alias, which the
// workspace tsconfig's `paths` maps to `<workspaceRoot>/*` and the loader shim resolves at runtime.
// vite honors neither, so resolve it here the same way — walk up from the importer to the workspace
// root (konte.config.json) and join the remainder, mapping the specifier's `.js` to the `.ts` on disk.
// Per-importer, so each test's temp workspace resolves to its own files.
const WORKSPACE_ALIAS_PREFIX = "konte/workspace/";
const WORKSPACE_ALIAS_EXTS = [".ts", ".tsx", ".js", ".jsx"];
const konteWorkspaceAlias: Plugin = {
  name: "konte-workspace-alias",
  enforce: "pre",
  resolveId(id, importer) {
    if (!id.startsWith(WORKSPACE_ALIAS_PREFIX) || !importer) return null;
    const rest = id.slice(WORKSPACE_ALIAS_PREFIX.length);
    const importerPath = importer.split("?")[0]!;
    let dir = path.dirname(
      importerPath.startsWith("file:") ? fileURLToPath(importerPath) : importerPath,
    );
    for (;;) {
      if (existsSync(path.join(dir, "konte.config.json"))) {
        const joined = path.join(dir, rest);
        const base = joined.replace(/\.[jt]sx?$/, "");
        for (const ext of WORKSPACE_ALIAS_EXTS) {
          if (existsSync(base + ext)) return base + ext;
        }
        return existsSync(joined) ? joined : null;
      }
      const parent = path.dirname(dir);
      if (parent === dir) return null;
      dir = parent;
    }
  },
};

// Which module runner a test file gets. konte's own source is loaded by Bun directly wherever it
// can be: vite-node otherwise re-transforms and re-executes the ~500-module CLI graph once per test
// file, which was the suite's single largest cost. What cannot take that route is a test that
// REPLACES a module — vi.mock and friends put the replacement in vitest's own registry, and a
// module Bun imported natively never looks there. Those files are found by reading them rather
// than listed, so a new one lands on the right runner without anyone remembering to say so.
const SRC_DIR = path.resolve(__dirname, "src");
const SRC_DIR_RE = new RegExp(`^${SRC_DIR.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[\\/]`);
// only __tests__/ dirs — a misplaced test then won't run, instead of silently drifting outside the convention
const TEST_GLOB = "**/__tests__/**/*.{test,spec}.?(c|m)[jt]s?(x)";
const MOCKS_A_MODULE = /\bvi\.(?:mock|doMock|unmock|doUnmock|importActual|importMock)\s*\(/;
const TEST_FILE_RE = /__tests__\/.*\.(?:test|spec)\.[cm]?[jt]sx?$/;

function collectTestFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) collectTestFiles(full, out);
    else if (TEST_FILE_RE.test(full.split(path.sep).join("/"))) out.push(full);
  }
  return out;
}

const mockingTests = collectTestFiles(SRC_DIR)
  .filter((file) => MOCKS_A_MODULE.test(readFileSync(file, "utf8")))
  .map((file) => path.relative(__dirname, file).split(path.sep).join("/"));

export default defineConfig({
  plugins: [konteGuides, konteWorkspaceAlias, fileAsText],
  resolve: {
    alias: [
      // Exact match only: a bare `konte` string alias also swallows `konte/guides/*`, which the
      // konteGuides plugin resolves per-workspace instead.
      { find: /^konte$/, replacement: path.resolve(__dirname, "src/core/dsl/index.ts") },
      {
        find: "react/jsx-runtime",
        replacement: path.resolve(
          __dirname,
          "node_modules/react/cjs/react-jsx-runtime.development.js",
        ),
      },
      {
        find: "react/jsx-dev-runtime",
        replacement: path.resolve(
          __dirname,
          "node_modules/react/cjs/react-jsx-dev-runtime.development.js",
        ),
      },
    ],
  },
  esbuild: {
    jsx: "automatic",
    jsxDev: false,
  },
  test: {
    globals: false,
    passWithNoTests: true,
    testTimeout: 30_000,
    hookTimeout: 30_000,
    setupFiles: ["./vitest.setup.ts"],
    // The harness loads definitions in-process, skipping the entry's re-exec that points Bun's
    // transpiler cache at the workspace — so a fixture's absolute adapter path would land in the
    // machine-wide cache, keyed by content alone, and the next run's temp dir would load a gone path.
    // A fork reads this at process start, which vitest.setup.ts is too late for.
    env: { [TRANSPILER_CACHE_ENV]: TRANSPILER_CACHE_DISABLED },
    // A worker shells out to ffmpeg, which sizes its own thread pool to the machine, so the
    // suite's process/thread footprint is workers × cores rather than workers. Past ~20 workers a
    // 32-core box crosses its per-user process limit and ffmpeg starts failing to spawn — a
    // failure that surfaces as an unrelated assertion in whatever test was running. Measured: the
    // wall clock is flat from 20 workers up, so the cap costs nothing.
    maxWorkers: Math.min(availableParallelism(), 20),
    // Bun marks every ESM namespace `__esModule`, which vite-node's default-export interop reads as
    // CJS and collapses the module onto its `default` — dropping named exports (`zod`'s `z`).
    deps: { interopDefault: false },
    projects: [
      {
        extends: true,
        test: {
          name: "native",
          include: [TEST_GLOB],
          exclude: [...configDefaults.exclude, ...mockingTests],
          server: { deps: { external: [SRC_DIR_RE] } },
        },
      },
      {
        extends: true,
        test: { name: "mocking", include: mockingTests },
      },
    ],
  },
});
