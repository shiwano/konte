// Lists the code kept only for users of an earlier konte.
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import pkg from "../package.json" with { type: "json" };
import { compareVersions } from "../src/core/update-check.js";

const ROOT = path.resolve(import.meta.dirname, "..");
const TAG = "SUNSET" + "(";
const CODE = /\.(?:ts|tsx|js|sh|ps1)$/;
const MARKER = /(?:\/\/|#) SUNSET\((\d+\.\d+\.\d+)\):/;

const files = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], {
  cwd: ROOT,
  encoding: "utf8",
})
  .split("\n")
  .filter((file) => CODE.test(file) && !file.includes("/generated/"))
  .filter((file) => fs.statSync(path.join(ROOT, file), { throwIfNoEntry: false })?.isFile());

const errors: string[] = [];
const markers: string[] = [];
for (const file of files) {
  const text = fs.readFileSync(path.join(ROOT, file), "utf8");
  if (!text.includes(TAG)) continue;
  text.split("\n").forEach((line, i) => {
    if (!line.includes(TAG)) return;
    const at = `${file}:${i + 1}`;
    const match = MARKER.exec(line);
    if (!match) {
      errors.push(`${at}: write it as // ${TAG}X.Y.Z):`);
      return;
    }
    if (compareVersions(pkg.version, match[1]!) >= 0) {
      errors.push(`${at}: due in ${match[1]} (package is ${pkg.version}); remove it`);
    }
    markers.push(`${at}: ${line.trim()}`);
  });
}

for (const marker of markers) console.log(marker);
if (errors.length > 0) {
  for (const error of errors) console.error(`check-sunset: ${error}`);
  process.exit(1);
}
console.log(`check-sunset: ok (${markers.length} marker(s))`);
