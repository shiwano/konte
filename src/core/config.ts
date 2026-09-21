import * as fs from "node:fs/promises";
import * as path from "node:path";
import { writeFileAtomic } from "./atomic-write.js";
import { KonteError } from "./errors.js";
import type { KonteConfig } from "./types/config.js";
import { KonteConfigSchema } from "./types/config.js";

const DEFAULT_CONFIG: KonteConfig = {
  comfyui: {},
};

const CONFIG_FILE = "konte.config.json";

function konteConfigPath(workspaceRoot: string): string {
  return path.join(workspaceRoot, CONFIG_FILE);
}

export async function saveKonteConfig(
  workspaceRoot: string,
  config: KonteConfig,
): Promise<KonteConfig> {
  const validated = KonteConfigSchema.parse(config);
  await writeFileAtomic(konteConfigPath(workspaceRoot), `${JSON.stringify(validated, null, 2)}\n`);
  return validated;
}

export async function loadKonteConfig(workspaceRoot: string): Promise<KonteConfig> {
  const configPath = konteConfigPath(workspaceRoot);

  let raw: string;
  try {
    raw = await fs.readFile(configPath, "utf-8");
  } catch (err) {
    // Only a missing file falls back to defaults; any other read error is real.
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return DEFAULT_CONFIG;
    throw err;
  }

  // The file exists, so a typo must not silently revert config to defaults —
  // surface it instead.
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new KonteError("VALIDATION_FAILED", `Invalid JSON in config file "${configPath}"`);
  }

  const result = KonteConfigSchema.safeParse(json);
  if (!result.success) {
    throw new KonteError(
      "VALIDATION_FAILED",
      `Config validation failed for "${configPath}": ${result.error.message}`,
    );
  }
  return result.data;
}
