import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initWorkspace, run, runCapture } from "../../__tests__/harness.js";

const COLUMNS = ["ADAPTER", "BACKEND", "MEDIA", "INPUTS", "IMPORT", "DESCRIPTION"] as const;
type Row = Record<(typeof COLUMNS)[number], string>;

let tmpDir: string;
let workspaceDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "konte-adapter-list-"));
  ({ workspace: workspaceDir } = await initWorkspace(path.join(tmpDir, "ws")));
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

// The table is the listing: split it back into rows so a test reads one adapter's cells by name.
async function listRows(args: string[] = []): Promise<Row[]> {
  const { stdout } = await runCapture(["adapter", "list", ...args], workspaceDir);
  const lines = stdout.split("\n");
  const headerAt = lines.findIndex((line) => line.startsWith("ADAPTER"));
  if (headerAt === -1) return [];
  const header = lines[headerAt]!;
  const starts = COLUMNS.map((column) => header.indexOf(column));
  const body = lines.slice(headerAt + 1);
  const endAt = body.findIndex((line) => line.trim() === "");
  return body.slice(0, endAt === -1 ? body.length : endAt).map((line) => {
    const row = {} as Row;
    COLUMNS.forEach((column, i) => {
      const end = i + 1 < starts.length ? starts[i + 1]! : line.length;
      row[column] = line.slice(starts[i]!, end).trim();
    });
    return row;
  });
}

const rowFor = (rows: Row[], adapter: string): Row | undefined =>
  rows.find((row) => row.ADAPTER === adapter || row.ADAPTER === `adapters.${adapter}`);

async function writeConfig(config: unknown): Promise<void> {
  await fs.writeFile(path.join(workspaceDir, "konte.config.json"), JSON.stringify(config));
}

describe("adapter list command", () => {
  it("lists the workspace's own adapters alongside the prebuilt ones", async () => {
    const rows = await listRows(["--all"]);

    expect(rowFor(rows, "videoMinimaxH3R2v")).toMatchObject({
      BACKEND: "comfy",
      IMPORT: "konte/workspace/adapters/comfy/video_minimax_h3_r2v.js",
    });
    expect(rowFor(rows, "videoMinimaxH3R2v")?.DESCRIPTION).not.toBe("");

    expect(rowFor(rows, "falSeedance25I2v")).toMatchObject({
      BACKEND: "fal",
      IMPORT: "konte/workspace/adapters/fal/seedance-2-5.js",
    });

    expect(rowFor(rows, "jsxImage")?.IMPORT).toBe("konte");
  });

  // A fresh workspace's konte.config.json carries a ComfyUI URL and no credential file, so comfy is
  // configured and fal is not — the listing shows exactly what `generate` would accept.
  it("lists the configured vendor backends, plus the exempt file/local ones", async () => {
    const { stdout } = await runCapture(["adapter", "list"], workspaceDir);
    const rows = await listRows();

    expect(new Set(rows.map((row) => row.BACKEND))).toEqual(new Set(["comfy", "local", "file"]));
    expect(stdout).toContain("on a backend this workspace has not configured");
  });

  // --all widens the listing, not the workspace. The widened listing still has to name what
  // generate would refuse, or a flag the caller passed for its own reasons would read as an answer
  // to "what may this workspace spend on".
  it("still names what is unconfigured under --all", async () => {
    await writeConfig({});

    const { stdout } = await runCapture(["adapter", "list", "--all"], workspaceDir);

    expect((await listRows(["--all"])).some((row) => row.BACKEND === "fal")).toBe(true);
    expect(stdout).toMatch(/! \d+ of these are on a backend this workspace has not configured/);
    expect(stdout).toContain("FAL_KEY");
  });

  it("claims nothing about the vendors under --all when konte.config.json cannot be read", async () => {
    await fs.writeFile(path.join(workspaceDir, "konte.config.json"), "{ not valid json");

    const { stdout } = await runCapture(["adapter", "list", "--all"], workspaceDir);

    expect(stdout).toContain("konte.config.json failed to load");
    expect(stdout).not.toContain("of these are on a backend this workspace has not configured");
  });

  it("hides a vendor once its own requirement goes away", async () => {
    await writeConfig({});

    const rows = await listRows();

    expect(new Set(rows.map((row) => row.BACKEND))).toEqual(new Set(["local", "file"]));
  });

  it("honours an explicit --backend that is not configured, and says so", async () => {
    const { stdout } = await runCapture(["adapter", "list", "--backend", "fal"], workspaceDir);

    expect(stdout).toContain("falSeedance25I2v");
    expect(stdout).toContain("fal is not configured");
    expect(stdout).toContain("FAL_KEY");
  });

  // Adapters are picked while the config is still being edited, so a konte.config.json mid-edit
  // must not take the inventory down with it.
  it("lists every backend when konte.config.json fails to load, and says why", async () => {
    await fs.writeFile(path.join(workspaceDir, "konte.config.json"), "{ not valid json");

    const { stdout } = await runCapture(["adapter", "list", "--kind", "video"], workspaceDir);

    expect(stdout).toContain("falSeedance25T2v");
    expect(stdout).toContain("konte.config.json failed to load");
  });

  it("lists fal once its credential is set", async () => {
    vi.stubEnv("FAL_KEY", "test-key");

    const rows = await listRows();

    expect(rows.some((row) => row.BACKEND === "fal")).toBe(true);
  });

  it("reports each adapter's required inputs, so a caller can tell I2V from T2V", async () => {
    const rows = await listRows(["--all"]);
    const required = (name: string) => rowFor(rows, name)?.INPUTS;

    expect(required("falSeedance25I2v")).toBe("prompt, image");
    expect(required("falSeedance25T2v")).toBe("prompt");
    expect(required("videoMinimaxH3R2v")).toBe("image1, prompt");
    expect(required("imageKrea2TurboT2i")).toBe("-");
  });

  it("filters by backend and by output media", async () => {
    const rows = await listRows(["--backend", "comfy", "--kind", "audio"]);

    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.BACKEND).toBe("comfy");
      expect(row.MEDIA).toBe("audio");
    }
  });

  it("rejects an unknown --backend", async () => {
    await expect(run(["adapter", "list", "--backend", "nope"], workspaceDir)).rejects.toMatchObject(
      { stderr: expect.stringContaining("VALIDATION_FAILED") },
    );
  });

  it("reports a broken adapter file per file instead of failing the whole listing", async () => {
    await fs.writeFile(
      path.join(workspaceDir, "adapters", "comfy", "broken.ts"),
      "import { nope } from './does-not-exist.js';\nexport const broken = nope;\n",
    );

    const { stdout } = await runCapture(["adapter", "list", "--all"], workspaceDir);

    expect(stdout).toContain(`! ${path.join("adapters", "comfy", "broken.ts")} failed to load`);
    expect(rowFor(await listRows(["--all"]), "videoMinimaxH3R2v")).toBeDefined();
  });

  it("collapses a multi-paragraph description to one row without cutting it", async () => {
    const long = `${"a very wordy adapter. ".repeat(20)}\nand a second paragraph.`;
    await fs.writeFile(
      path.join(workspaceDir, "adapters", "comfy", "wordy.ts"),
      `import { defineComfyAsset } from "konte";
export const wordy = defineComfyAsset({
  workflow: "wordy.json",
  description: ${JSON.stringify(long)},
  inputs: {},
  outputs: { image: { nodeId: "9", type: "image" } },
});
`,
    );

    const { stdout } = await runCapture(["adapter", "list", "--backend", "comfy"], workspaceDir);
    const row = stdout.split("\n").find((line) => line.startsWith("wordy"));
    expect(row).toBeDefined();
    expect(row).toContain("and a second paragraph.");
    expect(row).not.toContain("…");
  });

  it("prints the import specifier and required inputs in the text table", async () => {
    const { stdout } = await runCapture(["adapter", "list", "--backend", "comfy"], workspaceDir);

    expect(stdout).toContain("ADAPTER");
    expect(stdout).toContain("videoMinimaxH3R2v");
    expect(stdout).toContain("image1");
    expect(stdout).toContain("konte/workspace/adapters/comfy/video_minimax_h3_r2v.js");
  });

  // The IMPORT column is a specifier, not an import statement; the legend tells the reader these are
  // named exports so a bare path is not mistaken for a default import.
  it("annotates the IMPORT column as a named export", async () => {
    const { stdout } = await runCapture(["adapter", "list", "--backend", "comfy"], workspaceDir);

    expect(stdout).toContain('import { <ADAPTER> } from "<IMPORT>"');
    expect(stdout).toContain('import { adapters } from "konte"');
  });
});
