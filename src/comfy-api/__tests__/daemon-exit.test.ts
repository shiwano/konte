import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeWorkspace, type Workspace } from "../../core/__tests__/helpers/workspace.js";
import { handOffDeploymentClose } from "../daemon-exit.js";
import { updateDeploymentState } from "../deploy-state.js";

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));
vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawn: spawnMock,
}));

let ws: Workspace;

beforeEach(async () => {
  spawnMock.mockReset();
  spawnMock.mockReturnValue({ unref: () => {} });
  vi.stubEnv("COMFY_API_KEY", "key");
  ws = await makeWorkspace();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("handOffDeploymentClose", () => {
  it("spawns no closer when nothing is open", () => {
    handOffDeploymentClose(ws.root);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("spawns a detached closer for an open deployment", async () => {
    await updateDeploymentState(ws.root, "main", () => ({ deploymentId: "dep-1" }));
    handOffDeploymentClose(ws.root);
    expect(spawnMock).toHaveBeenCalledWith(
      expect.any(String),
      expect.arrayContaining(["mcp", "close-deployments"]),
      expect.objectContaining({ cwd: ws.root, detached: true }),
    );
  });

  // A create whose answer was lost may have made a deployment only the closer can look up.
  it("spawns one for a create whose answer was lost", async () => {
    await updateDeploymentState(ws.root, "main", () => ({
      pendingCreate: { key: "key-1", releaseId: "rel-1", gpuClass: "L40S", region: "us", max: 1 },
    }));
    handOffDeploymentClose(ws.root);
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  it("spawns none for a deployment already stopped", async () => {
    await updateDeploymentState(ws.root, "main", () => ({ deploymentId: "dep-1", stopped: true }));
    handOffDeploymentClose(ws.root);
    expect(spawnMock).not.toHaveBeenCalled();
  });
});
