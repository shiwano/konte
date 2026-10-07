import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_COMFYUI_UNREACHABLE_TIMEOUT_MINUTES,
  resolveComfyUIConfig,
} from "../../comfyui/config.js";
import { loadKonteConfig } from "../config.js";
import { allowedHostIssue, ComfyTargetSchema, KonteConfigSchema } from "../types/config.js";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "konte-config-test-"));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true });
});

describe("loadKonteConfig", () => {
  it("returns default when config file does not exist", async () => {
    const config = await loadKonteConfig(tmpDir);
    expect(config).toEqual({
      comfy: {},
    });
  });

  it("parses a valid config.json", async () => {
    const configPath = path.join(tmpDir, "konte.config.json");
    await fs.writeFile(
      configPath,
      JSON.stringify({ comfy: { comfyui: { url: "http://localhost:9000" } } }),
      "utf-8",
    );
    const config = await loadKonteConfig(tmpDir);
    expect(config.comfy?.comfyui?.url).toBe("http://localhost:9000");
  });

  it("throws for invalid JSON", async () => {
    const configPath = path.join(tmpDir, "konte.config.json");
    await fs.writeFile(configPath, "not json", "utf-8");
    await expect(loadKonteConfig(tmpDir)).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });

  it("throws for schema-invalid content", async () => {
    const configPath = path.join(tmpDir, "konte.config.json");
    await fs.writeFile(configPath, JSON.stringify({ comfy: { comfyui: { url: 123 } } }), "utf-8");
    await expect(loadKonteConfig(tmpDir)).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });

  it("handles empty object config", async () => {
    const configPath = path.join(tmpDir, "konte.config.json");
    await fs.writeFile(configPath, JSON.stringify({}), "utf-8");
    const config = await loadKonteConfig(tmpDir);
    expect(config).toEqual({});
  });

  it("handles partial config with empty comfyui", async () => {
    const configPath = path.join(tmpDir, "konte.config.json");
    await fs.writeFile(configPath, JSON.stringify({ comfy: { comfyui: {} } }), "utf-8");
    const config = await loadKonteConfig(tmpDir);
    expect(config).toEqual({ comfy: { comfyui: {} } });
  });
});

// The config states patience in minutes — the only granularity anyone sets it at — while the
// waiters take milliseconds, so the conversion happens once, here, at the boundary.
describe("resolveComfyUIConfig unreachable ceiling", () => {
  async function writeConfig(comfyui: Record<string, unknown>): Promise<void> {
    await fs.writeFile(
      path.join(tmpDir, "konte.config.json"),
      JSON.stringify({ comfy: { comfyui } }),
      "utf-8",
    );
  }

  const LOCAL = "http://127.0.0.1:8000";

  it("converts the configured minutes to milliseconds", async () => {
    await writeConfig({ url: LOCAL, unreachableTimeoutMinutes: 3 });
    expect((await resolveComfyUIConfig(tmpDir)).unreachableTimeoutMs).toBe(180_000);
  });

  it("defaults a local ComfyUI to 15 minutes", async () => {
    await writeConfig({ url: LOCAL });
    expect((await resolveComfyUIConfig(tmpDir)).unreachableTimeoutMs).toBe(
      DEFAULT_COMFYUI_UNREACHABLE_TIMEOUT_MINUTES * 60_000,
    );
  });

  // Over a network, silence can be the path breaking rather than the server dying, so the
  // "unreachable therefore restarted" inference does not hold and nothing is failed by default.
  it("gives a remote ComfyUI no ceiling by default", async () => {
    await writeConfig({ url: "http://gpu-box.lan:8000" });
    expect((await resolveComfyUIConfig(tmpDir)).unreachableTimeoutMs).toBe(0);
  });

  it("honours an explicit ceiling on a remote ComfyUI", async () => {
    await writeConfig({ url: "http://gpu-box.lan:8000", unreachableTimeoutMinutes: 5 });
    expect((await resolveComfyUIConfig(tmpDir)).unreachableTimeoutMs).toBe(300_000);
  });

  it("keeps 0 as 0 — the opt-out must survive the default", async () => {
    await writeConfig({ url: LOCAL, unreachableTimeoutMinutes: 0 });
    expect((await resolveComfyUIConfig(tmpDir)).unreachableTimeoutMs).toBe(0);
  });
});

describe("preview.allowedHosts", () => {
  it("takes a host name pattern", () => {
    expect(allowedHostIssue("*.trycloudflare.com")).toBeNull();
    expect(allowedHostIssue("review.example.com")).toBeNull();
    expect(allowedHostIssue("*")).toBeNull();
  });

  it("rejects a pasted URL, naming what to write instead", () => {
    expect(allowedHostIssue("https://review.example.com")).toContain("host name alone");
  });

  it("rejects a port, which is never compared", () => {
    expect(allowedHostIssue("review.example.com:8080")).toContain("port");
  });

  it("rejects an empty entry", () => {
    expect(allowedHostIssue("  ")).not.toBeNull();
  });

  it("fails the schema, so a bad pattern never reaches the server", () => {
    const parsed = KonteConfigSchema.safeParse({
      preview: { allowedHosts: ["https://review.example.com"] },
    });
    expect(parsed.success).toBe(false);
  });

  it("keeps a valid pair of settings", () => {
    const parsed = KonteConfigSchema.safeParse({
      preview: { host: "0.0.0.0", allowedHosts: ["*.trycloudflare.com"] },
    });
    expect(parsed.success).toBe(true);
  });
});

describe("comfy.adapters", () => {
  const deployments = { main: {} };

  it("takes routes onto a declared deployment", () => {
    const parsed = KonteConfigSchema.safeParse({
      comfy: {
        adapters: { "*": ["comfyui", "comfycloud"], image: ["comfyapi:main", "comfyui"] },
        comfyapi: { deployments },
      },
    });
    expect(parsed.success).toBe(true);
  });

  it("takes no compute on a deployment — it is chosen when deploying the Build", () => {
    const parsed = KonteConfigSchema.safeParse({
      comfy: { comfyapi: { deployments: { main: { gpuClass: "L40S" } } } },
    });
    expect(parsed.success).toBe(false);
  });

  it("refuses a comfyapi target naming no declared deployment", () => {
    const parsed = KonteConfigSchema.safeParse({
      comfy: { adapters: { image: ["comfyapi:other"] }, comfyapi: { deployments } },
    });
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues[0]?.message).toContain('"comfyapi:other" names no deployment');
    expect(parsed.error?.issues[0]?.path).toEqual(["comfy", "adapters", "image"]);
  });

  it("names a target only as comfyui, comfycloud or comfyapi:<name>", () => {
    expect(ComfyTargetSchema.safeParse("comfyapi:main").success).toBe(true);
    for (const junk of ["comfy", "comfyapi:", "comfyapi:a/b", "ComfyUI", ""]) {
      expect(ComfyTargetSchema.safeParse(junk).success).toBe(false);
    }
  });
});
