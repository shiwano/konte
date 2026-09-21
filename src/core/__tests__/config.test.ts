import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_COMFYUI_UNREACHABLE_TIMEOUT_MINUTES,
  resolveComfyUIConfig,
} from "../../comfyui/config.js";
import { loadKonteConfig } from "../config.js";
import { allowedHostIssue, KonteConfigSchema } from "../types/config.js";

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
      comfyui: {},
    });
  });

  it("parses a valid config.json", async () => {
    const configPath = path.join(tmpDir, "konte.config.json");
    await fs.writeFile(
      configPath,
      JSON.stringify({ comfyui: { url: "http://localhost:9000" } }),
      "utf-8",
    );
    const config = await loadKonteConfig(tmpDir);
    expect(config.comfyui?.url).toBe("http://localhost:9000");
  });

  it("throws for invalid JSON", async () => {
    const configPath = path.join(tmpDir, "konte.config.json");
    await fs.writeFile(configPath, "not json", "utf-8");
    await expect(loadKonteConfig(tmpDir)).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });

  it("throws for schema-invalid content", async () => {
    const configPath = path.join(tmpDir, "konte.config.json");
    await fs.writeFile(configPath, JSON.stringify({ comfyui: { url: 123 } }), "utf-8");
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
    await fs.writeFile(configPath, JSON.stringify({ comfyui: {} }), "utf-8");
    const config = await loadKonteConfig(tmpDir);
    expect(config).toEqual({ comfyui: {} });
  });
});

// The config states patience in minutes — the only granularity anyone sets it at — while the
// waiters take milliseconds, so the conversion happens once, here, at the boundary.
describe("resolveComfyUIConfig unreachable ceiling", () => {
  async function writeConfig(comfyui: Record<string, unknown>): Promise<void> {
    await fs.writeFile(
      path.join(tmpDir, "konte.config.json"),
      JSON.stringify({ comfyui }),
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
