import * as fs from "node:fs/promises";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { workflowContentHash } from "../workflow-content-hash.js";
import { setWorkspaceRoot } from "../workspace-context.js";
import { makeWorkspace, type Workspace } from "./helpers/workspace.js";

let ws: Workspace;
let dir: string;

beforeEach(async () => {
  ws = await makeWorkspace();
  dir = path.join(ws.root, "adapters", "comfy");
  await fs.mkdir(dir, { recursive: true });
  setWorkspaceRoot(ws.root);
});

afterEach(async () => {
  setWorkspaceRoot(null);
  await ws.cleanup();
});

describe("workflowContentHash", () => {
  it("hashes the graph, not its file name or formatting", async () => {
    await fs.writeFile(path.join(dir, "a.json"), '{"1":{"class_type":"X","inputs":{}}}');
    await fs.writeFile(
      path.join(dir, "b.json"),
      JSON.stringify({ "1": { inputs: {}, class_type: "X" } }, null, 2),
    );

    expect(workflowContentHash("a.json")).toBeDefined();
    expect(workflowContentHash("b.json")).toBe(workflowContentHash("a.json"));
  });

  it("ignores a node's display title", async () => {
    await fs.writeFile(
      path.join(dir, "a.json"),
      '{"1":{"class_type":"X","inputs":{},"_meta":{"title":"Load"}}}',
    );
    await fs.writeFile(
      path.join(dir, "b.json"),
      '{"1":{"class_type":"X","inputs":{},"_meta":{"title":"Load the model"}}}',
    );

    expect(workflowContentHash("b.json")).toBe(workflowContentHash("a.json"));
  });

  it("moves when the graph is rewritten", async () => {
    const file = path.join(dir, "a.json");
    await fs.writeFile(file, '{"1":{"class_type":"X","inputs":{"steps":4}}}');
    const before = workflowContentHash("a.json");
    await fs.writeFile(file, '{"1":{"class_type":"X","inputs":{"steps":8}}}');
    const stat = await fs.stat(file);
    await fs.utimes(file, stat.atime, new Date(stat.mtimeMs + 60_000));

    expect(workflowContentHash("a.json")).not.toBe(before);
  });

  it("is undefined outside a workspace or for a missing file", () => {
    expect(workflowContentHash("missing.json")).toBeUndefined();
    setWorkspaceRoot(null);
    expect(workflowContentHash("a.json")).toBeUndefined();
  });
});
