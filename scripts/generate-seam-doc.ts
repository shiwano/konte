import * as fs from "node:fs";
import * as path from "node:path";
import { renderSeamDoc } from "../src/core/seam-doc.js";

const outFile = path.resolve(import.meta.dirname, "../docs/SEAMS.md");
fs.writeFileSync(outFile, await renderSeamDoc());
console.log(`Generated seam table → ${path.relative(process.cwd(), outFile)}`);
