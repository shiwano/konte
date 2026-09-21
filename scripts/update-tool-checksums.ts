#!/usr/bin/env bun
/**
 * Regenerates `src/core/tool-checksums.ts` — the pinned SHA-256 of every managed-tool artifact, for
 * every platform/arch konte supports, not just this machine's.
 *
 * Each artifact is streamed and hashed without touching disk, so this costs bandwidth (~1 GB) and
 * nothing else. Run it after bumping any pinned version, and review the diff: a hash that moved
 * without its version moving means the upstream artifact was replaced in place.
 */
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { toolDownloadUrls } from "./lib/tool-download-urls.js";

async function sha256Of(url: string): Promise<string> {
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  const hash = createHash("sha256");
  let received = 0;
  for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
    hash.update(chunk);
    received += chunk.byteLength;
    if (process.stderr.isTTY) {
      process.stderr.write(`\r  ${(received / 1048576).toFixed(1)} MB\x1b[K`);
    }
  }
  if (process.stderr.isTTY) process.stderr.write("\r\x1b[K");
  return hash.digest("hex");
}

const MANIFEST = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "src",
  "core",
  "tool-checksums.ts",
);

const urls = toolDownloadUrls();
const checksums: Record<string, string> = {};
for (const [i, url] of urls.entries()) {
  console.error(`[${i + 1}/${urls.length}] ${url}`);
  checksums[url] = await sha256Of(url);
}

const entries = Object.keys(checksums)
  .sort()
  .map((url) => `  ${JSON.stringify(url)}: ${JSON.stringify(checksums[url])},`)
  .join("\n");
const BLOCK = /export const TOOL_CHECKSUMS: Readonly<Record<string, string>> = \{[\s\S]*?\};/;
const source = fs.readFileSync(MANIFEST, "utf-8");
// Matched separately from the rewrite: identical output means the manifest was already current,
// which is a successful run, not a missing block.
if (!BLOCK.test(source)) throw new Error("TOOL_CHECKSUMS block not found in tool-checksums.ts");
fs.writeFileSync(
  MANIFEST,
  source.replace(
    BLOCK,
    () => `export const TOOL_CHECKSUMS: Readonly<Record<string, string>> = {\n${entries}\n};`,
  ),
);
console.error(`wrote ${urls.length} checksums → ${path.relative(process.cwd(), MANIFEST)}`);
