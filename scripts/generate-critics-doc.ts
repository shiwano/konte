import * as fs from "node:fs";
import * as path from "node:path";
import { renderCriticsDoc } from "../src/core/critics-doc.js";

const outFile = path.resolve(import.meta.dirname, "../docs/CRITICS.md");
fs.writeFileSync(outFile, await renderCriticsDoc());
console.log(`Generated critics list → ${path.relative(process.cwd(), outFile)}`);
