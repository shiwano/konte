import * as fs from "node:fs";
import * as path from "node:path";
import { KonteError } from "./errors.js";
import { exeName, provisionOnce, toolCacheDir, unpackTarballInto } from "./tool-cache.js";
import { toolPin } from "./tool-checksums.js";

const TSC_VERSION = "7.0.2";

export { TSC_VERSION };

let tscPath: string | null = null;

/** Where each platform/arch fetches its version-pinned tsc. Pure (for testing). */
export function tscDownloadUrl(platform: NodeJS.Platform, arch: string): string {
  // `arm` (32-bit) ships for linux only; @typescript publishes no darwin-arm or win32-arm package.
  const archs: Partial<Record<NodeJS.Platform, string[]>> = {
    linux: ["x64", "arm64", "arm"],
    darwin: ["x64", "arm64"],
    win32: ["x64", "arm64"],
  };
  if (!archs[platform]?.includes(arch)) {
    throw new KonteError("TSC_SETUP_FAILED", `Unsupported platform: ${platform}-${arch}`);
  }
  const pkg = `typescript-${platform}-${arch}`;
  return `https://registry.npmjs.org/@typescript/${pkg}/-/${pkg}-${TSC_VERSION}.tgz`;
}

/**
 * Absolute path to a usable tsc, provisioning the managed native build on first use if needed.
 *
 * `KONTE_TSC_PATH` overrides it with a local binary, skipping the download. The type-check passes
 * `--noEmit --pretty`, which the JS `tsc` also accepts.
 */
export async function ensureTsc(): Promise<string> {
  if (tscPath) return tscPath;

  const override = process.env.KONTE_TSC_PATH;
  if (override) {
    tscPath = override;
    return override;
  }

  const url = tscDownloadUrl(process.platform, process.arch);
  const cacheDir = toolCacheDir(`tsc-${TSC_VERSION}`);
  const tscBin = path.join(cacheDir, exeName("tsc"));
  await provisionOnce({
    dir: cacheDir,
    pin: toolPin([url]),
    files: [path.basename(tscBin)],
    label: `tsc ${TSC_VERSION}`,
    errorCode: "TSC_SETUP_FAILED",
    fill: async () => {
      await unpackTarballInto(url, cacheDir, "tsc", path.join("package", "lib"));
      fs.chmodSync(tscBin, 0o755);
    },
  });

  tscPath = tscBin;
  return tscBin;
}
