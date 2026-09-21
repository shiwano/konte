import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// The reload has to be exercised by the Bun runtime itself: vitest runs modules through its own
// runner, whose cache is not the one a daemon evicts. The child is the `bun` on PATH — the same one
// `bun run build` embeds — so a Bun upgrade that changes how modules are cached fails here, not in
// a daemon that quietly keeps serving the definitions it loaded first.
const loaderPath = new URL("../loader.ts", import.meta.url).pathname;

let root: string;

beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "konte-reload-")));
  await fs.writeFile(path.join(root, "konte.config.json"), "{}\n");
  const video = path.join(root, "videos", "v1");
  await fs.mkdir(path.join(root, "adapters"), { recursive: true });
  await fs.mkdir(video, { recursive: true });
  await fs.writeFile(path.join(root, "adapters", "tag.ts"), 'export const tag = "adapter-1";\n');
  await fs.writeFile(path.join(video, "names.ts"), 'export const names = ["a"];\n');
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe("reloadFreshModule in a long-lived Bun process", () => {
  it("sees edits to transitively imported files on every reload", { timeout: 30_000 }, async () => {
    const video = path.join(root, "videos", "v1");
    const entry = path.join(video, "video.ts");
    await fs.writeFile(
      entry,
      [
        'import { names } from "./names.ts";',
        'import { tag } from "konte/workspace/adapters/tag.ts";',
        "export default [...names, tag];",
      ].join("\n"),
    );
    const script = `
      const fs = await import("node:fs");
      const { reloadFreshModule } = await import(${JSON.stringify(loaderPath)});
      const seen = [];
      const read = async () => {
        try {
          seen.push((await reloadFreshModule(${JSON.stringify(entry)})).default);
        } catch (err) {
          seen.push(String(err.code ?? err.message));
        }
      };
      await read();
      fs.writeFileSync(${JSON.stringify(path.join(video, "names.ts"))}, 'export const names = ["a", "b"];\\n');
      await read();
      fs.writeFileSync(${JSON.stringify(path.join(root, "adapters", "tag.ts"))}, 'export const tag = "adapter-2";\\n');
      await read();
      fs.writeFileSync(${JSON.stringify(path.join(video, "names.ts"))}, 'export const names = ["a", "b", "c"];\\n');
      await read();
      console.log(JSON.stringify(seen));
    `;
    const { stdout } = await promisify(execFile)("bun", ["-e", script], {
      encoding: "utf8",
      cwd: video,
    });
    expect(JSON.parse(stdout.trim().split("\n").at(-1)!)).toEqual([
      ["a", "adapter-1"],
      ["a", "b", "adapter-1"],
      ["a", "b", "adapter-2"],
      ["a", "b", "c", "adapter-2"],
    ]);
  });
  it.each([
    ["a syntax error", "export const names = [;\\n"],
    ["a throw during evaluation", 'throw new Error("boom");\\nexport const names = ["x"];\\n'],
    ["a missing export", 'export const renamed = ["x"];\\n'],
  ])(
    "recovers once %s in an imported file is fixed",
    { timeout: 30_000 },
    async (_label, broken) => {
      const video = path.join(root, "videos", "v1");
      const entry = path.join(video, "video.ts");
      const names = path.join(video, "names.ts");
      await fs.writeFile(entry, 'import { names } from "./names.ts";\nexport default names;\n');
      const script = `
      const fs = await import("node:fs");
      const { reloadFreshModule } = await import(${JSON.stringify(loaderPath)});
      const seen = [];
      const read = async () => {
        try {
          seen.push((await reloadFreshModule(${JSON.stringify(entry)})).default);
        } catch {
          seen.push("error");
        }
      };
      await read();
      fs.writeFileSync(${JSON.stringify(names)}, '${broken}');
      await read();
      fs.writeFileSync(${JSON.stringify(names)}, 'export const names = ["fixed"];\\n');
      await read();
      console.log(JSON.stringify(seen));
    `;
      const { stdout } = await promisify(execFile)("bun", ["-e", script], {
        encoding: "utf8",
        cwd: video,
        timeout: 20_000,
      });
      expect(JSON.parse(stdout.trim().split("\n").at(-1)!)).toEqual([["a"], "error", ["fixed"]]);
    },
  );
});
