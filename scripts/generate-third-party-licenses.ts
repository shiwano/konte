import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const repoRoot = path.resolve(import.meta.dirname, "..");
const modulesRoot = path.join(repoRoot, "node_modules");
const textsDir = path.join(import.meta.dirname, "lib/license-texts");
// Inside src/ so the compile inlines it into the binary.
const markdownOut = path.join(repoRoot, "src/core/generated/third-party-licenses.md");

// Every entry point whose output reaches the binary.
const ENTRIES: [entry: string, target: string][] = [
  ["src/cli/index.ts", "bun"],
  ["src/pages/preview/index.tsx", "browser"],
  ["src/pages/settings/index.tsx", "browser"],
];

// The bundler's unminified output labels each module with the path it came from. An install that
// nests a package under its dependent (node_modules/postcss/node_modules/nanoid/…) is the same
// package, so take the last node_modules segment rather than the first.
const MODULE_MARKER = /^\/\/ (?:.*\/)?node_modules\/((?:@[^/\s]+\/)?[^/\s]+)\//gm;

// A package whose tarball carries no license file of its own. The SPDX id must match what its
// package.json declares, so a dependency bump that changes the license fails the lookup.
const TEXT_FALLBACKS: Record<string, string> = {
  puppeteer: "Apache-2.0",
  "puppeteer-core": "Apache-2.0",
  "@puppeteer/browsers": "Apache-2.0",
  degenerator: "MIT",
  "proxy-agent-negotiate": "MIT",
  "quickjs-wasi": "MIT",
};

// The copyright holder for a vendored text, for a package whose manifest names no author. Taken
// from the upstream repository's license file.
const HOLDER_FALLBACKS: Record<string, string> = {
  "quickjs-wasi": "2026 Vercel, Inc.",
};

// MIT carries the copyright line inside the grant, so a vendored copy is only correct once the
// holder is filled in.
const HOLDER_PLACEHOLDER = "[[HOLDER]]";

const LICENSE_FILE = /^(licence|license|copying)([.-].*)?$/i;

interface Pkg {
  name: string;
  version: string;
  license: string;
  text: string;
}

function readManifest(name: string): {
  version?: string;
  license?: unknown;
  author?: unknown;
} | null {
  const file = path.join(modulesRoot, name, "package.json");
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, "utf-8"));
}

// A package that ships its license as a file but declares no `license` in package.json.
const TEXT_SIGNATURES: [RegExp, string][] = [
  [/Apache License\s+Version 2\.0/, "Apache-2.0"],
  [/^\s*MIT License/m, "MIT"],
  [/^\s*ISC License/m, "ISC"],
  [/SIL OPEN FONT LICENSE Version 1\.1/, "OFL-1.1"],
];

function declaredSpdx(manifest: { license?: unknown }): string | null {
  const { license } = manifest;
  if (typeof license === "string") return license;
  if (license && typeof license === "object" && "type" in license) {
    return String((license as { type: unknown }).type);
  }
  return null;
}

function detectSpdx(text: string): string | null {
  return TEXT_SIGNATURES.find(([pattern]) => pattern.test(text))?.[1] ?? null;
}

function holderOf(manifest: { author?: unknown }): string | null {
  const { author } = manifest;
  if (typeof author === "string") return author;
  if (author && typeof author === "object" && "name" in author) {
    return String((author as { name: unknown }).name);
  }
  return null;
}

function shippedText(name: string): string | null {
  const dir = path.join(modulesRoot, name);
  const found = fs.readdirSync(dir).find((f) => LICENSE_FILE.test(f));
  return found === undefined ? null : fs.readFileSync(path.join(dir, found), "utf-8").trimEnd();
}

function vendoredText(
  name: string,
  id: string | null,
  manifest: { author?: unknown },
): string | null {
  if (id === null || TEXT_FALLBACKS[name] !== id) return null;
  const vendored = path.join(textsDir, `${id}.txt`);
  if (!fs.existsSync(vendored)) return null;
  const text = fs.readFileSync(vendored, "utf-8").trimEnd();
  if (!text.includes(HOLDER_PLACEHOLDER)) return text;

  const holder = holderOf(manifest) ?? HOLDER_FALLBACKS[name] ?? null;
  if (holder === null) return null;
  return text.replaceAll(HOLDER_PLACEHOLDER, holder);
}

function bundledPackages(): Set<string> {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "konte-licenses-"));
  const names = new Set<string>();
  try {
    for (const [entry, target] of ENTRIES) {
      const outfile = path.join(scratch, `${path.basename(path.dirname(entry))}.js`);
      const { exitCode, stderr } = Bun.spawnSync(
        ["bun", "build", entry, `--target=${target}`, "--outfile", outfile],
        { cwd: repoRoot },
      );
      if (exitCode !== 0) {
        console.error(`Bundling ${entry} failed:\n${new TextDecoder().decode(stderr)}`);
        process.exit(1);
      }
      for (const [, name] of fs.readFileSync(outfile, "utf-8").matchAll(MODULE_MARKER)) {
        if (name !== undefined) names.add(name);
      }
    }
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
  return names;
}

// The walk bundles src/cli/index.ts, which imports this script's own output as text. On a clean
// checkout it does not exist yet, so seed it before bundling.
fs.mkdirSync(path.dirname(markdownOut), { recursive: true });
if (!fs.existsSync(markdownOut)) fs.writeFileSync(markdownOut, "", "utf-8");

const bundled = bundledPackages();

// The marker comments are an undocumented shape of Bun's output, and a format change would show up
// as a quietly shorter list.
const rootManifest = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf-8"));
const undetected = Object.keys(rootManifest.dependencies ?? {}).filter((d) => !bundled.has(d));
if (undetected.length > 0) {
  console.error(
    `Declared dependencies missing from the bundle: ${undetected.join(", ")}\n` +
      `Either they are genuinely unused, or Bun no longer labels bundled modules with\n` +
      `\`// node_modules/…\` and MODULE_MARKER needs updating.`,
  );
  process.exit(1);
}

const collected = new Map<string, Pkg>();
const noText: string[] = [];
const noId: string[] = [];

for (const name of bundled) {
  const manifest = readManifest(name);
  if (manifest === null) continue;

  const declared = declaredSpdx(manifest);
  const text = shippedText(name) ?? vendoredText(name, declared, manifest);
  if (text === null) {
    noText.push(name);
    continue;
  }
  const id = declared ?? detectSpdx(text);
  if (id === null) {
    noId.push(name);
    continue;
  }
  collected.set(name, { name, version: manifest.version ?? "0.0.0", license: id, text });
}

// A bundled dependency konte cannot attribute is one it cannot ship.
if (noText.length > 0) {
  console.error(
    `No license text for: ${noText.join(", ")}\n` +
      `Add the SPDX id to TEXT_FALLBACKS in scripts/generate-third-party-licenses.ts and vendor\n` +
      `the text under scripts/lib/license-texts/<spdx>.txt.`,
  );
}
if (noId.length > 0) {
  console.error(
    `No SPDX identifier for: ${noId.join(", ")}\n` +
      `The package declares none and its license text matches no TEXT_SIGNATURES entry.\n` +
      `Add a signature in scripts/generate-third-party-licenses.ts.`,
  );
}
if (noText.length > 0 || noId.length > 0) process.exit(1);

const packages = [...collected.values()].sort((a, b) => a.name.localeCompare(b.name));

const header = `# Third-party licenses

konte is distributed as a single self-contained binary that bundles the software listed below,
each reproduced with its own license.

ffmpeg, Chromium and the TypeScript compiler are **not** listed here: konte downloads them onto
your machine from their own publishers rather than redistributing them.

Regenerate with \`bun run build:third-party-licenses\`.
`;

const summary = packages.map((p) => `| ${p.name} | ${p.version} | ${p.license} |`).join("\n");

const bodies = packages
  .map(
    (p) =>
      `## ${p.name} ${p.version}\n\nSPDX-License-Identifier: ${p.license}\n\n\`\`\`\n${p.text}\n\`\`\``,
  )
  .join("\n\n");

fs.writeFileSync(
  markdownOut,
  `${header}\n| Package | Version | License |\n| --- | --- | --- |\n${summary}\n\n${bodies}\n`,
  "utf-8",
);

console.log(
  `Third-party licenses: ${packages.length} packages → ${path.relative(repoRoot, markdownOut)}`,
);
