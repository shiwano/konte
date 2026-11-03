import * as fs from "node:fs";
import * as path from "node:path";
import { adapterReleasesFile, workspaceDir } from "./lib/template-dirs.js";

const version = process.argv[2];
if (!version || !/^\d+\.\d+\.\d+$/.test(version)) {
  console.error("Usage: bun run release:version <major.minor.patch>");
  process.exit(1);
}

const packageFile = path.resolve(import.meta.dirname, "../package.json");
const pkg = JSON.parse(fs.readFileSync(packageFile, "utf-8")) as { version: string };
pkg.version = version;
fs.writeFileSync(packageFile, `${JSON.stringify(pkg, null, 2)}\n`);

const previous: Record<string, string> = JSON.parse(fs.readFileSync(adapterReleasesFile, "utf-8"));
const releases: Record<string, string> = {};
const adapterKeys = fs
  .readdirSync(path.join(workspaceDir, "adapters"), { recursive: true, withFileTypes: true })
  .filter((entry) => entry.isFile())
  .map((entry) => path.relative(workspaceDir, path.join(entry.parentPath, entry.name)))
  .map((key) => key.split(path.sep).join("/"))
  .sort();
for (const key of adapterKeys) releases[key] = previous[key] ?? version;
fs.writeFileSync(adapterReleasesFile, `${JSON.stringify(releases, null, 2)}\n`);

const added = adapterKeys.filter((key) => !(key in previous));
console.log(`package.json → ${version}; adapters first shipped in it: ${added.length}`);
for (const key of added) console.log(`  ${key}`);
