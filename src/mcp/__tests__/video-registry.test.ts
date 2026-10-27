import * as fs from "node:fs/promises";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyCredentials, saveCredentials } from "../../core/credentials.js";
import { makeWorkspace, type Workspace } from "../../core/__tests__/helpers/workspace.js";
import { JobWatcher } from "../job-watcher.js";
import { VideoRegistry } from "../video-registry.js";

// The registry only needs the one call the job watcher makes on a real McpServer.
function makeFakeServer(): { server: unknown } {
  const server = {
    server: {
      sendLoggingMessage: (): void => {},
    },
  };
  return { server };
}

// Nothing in the daemon's own surface reports the watcher set.
function watched(registry: VideoRegistry): string[] {
  return [...(registry as unknown as { watchers: Map<string, unknown> }).watchers.keys()];
}

function watchers(registry: VideoRegistry): JobWatcher[] {
  return [...(registry as unknown as { watchers: Map<string, JobWatcher> }).watchers.values()];
}

function backendCache(watcher: JobWatcher): Map<string, unknown> {
  return (watcher as unknown as { backendCache: Map<string, unknown> }).backendCache;
}

async function waitFor(predicate: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("waitFor: timed out");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

let ws: Workspace;
let registry: VideoRegistry | null = null;

beforeEach(async () => {
  ws = await makeWorkspace({ videos: ["opening"] });
  // applyCredentials keeps a process-wide record of what it injected; settle it against this
  // workspace so a previous test's key is not this one's first change.
  await applyCredentials(ws.root);
});

afterEach(async () => {
  await registry?.stop();
  vi.restoreAllMocks();
  registry = null;
  delete process.env.KONTE_TEST_CRED;
  await ws.cleanup();
});

describe("VideoRegistry", () => {
  it.each(["updated", undefined])(
    "refreshes credentials before its first scan (%s)",
    async (value) => {
      await saveCredentials(ws.root, { KONTE_TEST_CRED: "old" });
      await applyCredentials(ws.root);
      await saveCredentials(ws.root, value ? { KONTE_TEST_CRED: value } : {});
      let observed: string | undefined = "not-scanned";
      vi.spyOn(JobWatcher.prototype, "start").mockImplementation(async () => {
        observed = process.env.KONTE_TEST_CRED;
      });
      const { server } = makeFakeServer();
      registry = new VideoRegistry(server as never, ws.root);
      await registry.start();
      expect(observed).toBe(value);
    },
  );

  it("keeps every stop waiting for the same outstanding cleanup", async () => {
    const { server } = makeFakeServer();
    registry = new VideoRegistry(server as never, ws.root);
    await registry.start();
    const release = Promise.withResolvers<void>();
    vi.spyOn(watchers(registry)[0]!, "settled").mockReturnValue(release.promise);
    const first = registry.stop();
    const second = registry.stop();
    expect(second).toBe(first);
    let stopped = false;
    void second.then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(stopped).toBe(false);
    release.resolve();
    await second;
    expect(stopped).toBe(true);
  });

  it("watches every video the workspace already has", async () => {
    const { server } = makeFakeServer();
    registry = new VideoRegistry(server as never, ws.root);
    await registry.start();

    expect(watched(registry)).toEqual(["opening"]);
  });

  it("picks up a video created while the daemon is running", async () => {
    const { server } = makeFakeServer();
    registry = new VideoRegistry(server as never, ws.root);
    await registry.start();

    const ending = path.join(ws.root, "videos", "ending");
    await fs.mkdir(ending, { recursive: true });
    await fs.writeFile(path.join(ending, "konte.state.json"), "{}");

    const r = registry;
    await waitFor(() => watched(r).includes("ending"));
    expect(watched(r).sort()).toEqual(["ending", "opening"]);
  });

  it("drops the watcher of a video that is removed", async () => {
    const { server } = makeFakeServer();
    registry = new VideoRegistry(server as never, ws.root);
    await registry.start();

    await fs.rm(path.join(ws.root, "videos", "opening"), { recursive: true, force: true });

    const r = registry;
    await waitFor(() => watched(r).length === 0);
  });

  // The CLI loads credentials once at startup, which is the whole life of a daemon. A key set in
  // `konte settings` after it started has to reach the environment it submits from — and every
  // backend already built from the old one has to go.
  it("picks up a credential set after it started, and drops the backends built without it", async () => {
    const { server } = makeFakeServer();
    // The 5s production poll outruns waitFor under a loaded suite.
    registry = new VideoRegistry(server as never, ws.root, { reconcileIntervalMs: 50 });
    await registry.start();

    const watcher = watchers(registry)[0]!;
    backendCache(watcher).set("fal", {});

    await saveCredentials(ws.root, { KONTE_TEST_CRED: "set-after-start" });

    await waitFor(() => process.env.KONTE_TEST_CRED === "set-after-start");
    expect(backendCache(watcher).size).toBe(0);
  });

  // A submit past its cache miss resolves the backend across an await and then writes it into the
  // map it was handed. Clearing in place would let that write — a backend built on the old key —
  // land back in the live cache and stay until the next rotation.
  it("leaves a submit already resolving a backend writing into a map nothing reads again", async () => {
    const { server } = makeFakeServer();
    registry = new VideoRegistry(server as never, ws.root);
    await registry.start();

    const watcher = watchers(registry)[0]!;
    // What a submit captured before the drop.
    const captured = backendCache(watcher);

    watcher.dropBackendCache();
    // ...and writes into afterwards.
    captured.set("fal", { builtOnTheOldKey: true });

    expect(backendCache(watcher)).not.toBe(captured);
    expect(backendCache(watcher).size).toBe(0);
  });
});
