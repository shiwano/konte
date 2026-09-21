import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkForUpdate, compareVersions } from "../update-check.js";

describe("compareVersions", () => {
  it("orders dotted numeric versions, ignoring a leading v", () => {
    expect(compareVersions("v0.2.0", "0.1.9")).toBeGreaterThan(0);
    expect(compareVersions("0.1.0", "v0.1.0")).toBe(0);
    expect(compareVersions("0.1", "0.1.0")).toBe(0);
    expect(compareVersions("1.0.0", "0.99.99")).toBeGreaterThan(0);
  });

  it("ranks a pre-release below its release", () => {
    expect(compareVersions("1.0.0-rc.1", "1.0.0")).toBeLessThan(0);
    expect(compareVersions("1.0.0", "1.0.0-rc.1")).toBeGreaterThan(0);
  });
});

describe("checkForUpdate", () => {
  let cacheDir: string;
  let savedEnv: string | undefined;

  beforeEach(async () => {
    cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), "konte-update-check-"));
    savedEnv = process.env.KONTE_UPDATE_CHECK;
    delete process.env.KONTE_UPDATE_CHECK;
  });

  afterEach(async () => {
    if (savedEnv === undefined) delete process.env.KONTE_UPDATE_CHECK;
    else process.env.KONTE_UPDATE_CHECK = savedEnv;
    await fs.rm(cacheDir, { recursive: true, force: true });
  });

  it("reports outdated when the latest tag is newer, and caches it", async () => {
    let fetches = 0;
    const fetchLatestTag = async () => {
      fetches++;
      return "v0.2.0";
    };
    const now = () => new Date("2026-08-20T00:00:00Z");

    const first = await checkForUpdate("0.1.0", { cacheDir, fetchLatestTag, now });
    expect(first).toEqual({ kind: "outdated", current: "0.1.0", latest: "0.2.0" });

    const second = await checkForUpdate("0.2.0", { cacheDir, fetchLatestTag, now });
    expect(second).toEqual({ kind: "current", current: "0.2.0", latest: "0.2.0" });
    expect(fetches).toBe(1);
  });

  it("refetches once the cache is a day old", async () => {
    let fetches = 0;
    const fetchLatestTag = async () => {
      fetches++;
      return "v0.2.0";
    };
    await checkForUpdate("0.1.0", {
      cacheDir,
      fetchLatestTag,
      now: () => new Date("2026-08-20T00:00:00Z"),
    });
    await checkForUpdate("0.1.0", {
      cacheDir,
      fetchLatestTag,
      now: () => new Date("2026-08-21T00:00:01Z"),
    });
    expect(fetches).toBe(2);
  });

  it("answers unknown, not an error, when the lookup fails", async () => {
    const result = await checkForUpdate("0.1.0", {
      cacheDir,
      fetchLatestTag: async () => {
        throw new Error("offline");
      },
    });
    expect(result).toEqual({ kind: "unknown", current: "0.1.0", reason: "offline" });
  });

  it("is off under KONTE_UPDATE_CHECK=0 and touches nothing", async () => {
    process.env.KONTE_UPDATE_CHECK = "0";
    const result = await checkForUpdate("0.1.0", {
      cacheDir,
      fetchLatestTag: async () => {
        throw new Error("must not be called");
      },
    });
    expect(result).toEqual({ kind: "disabled", current: "0.1.0" });
    expect(await fs.readdir(cacheDir)).toEqual([]);
  });
});
