import * as fs from "node:fs";
import * as path from "node:path";
import { renderFindingsDoc } from "../src/core/findings-doc.js";

const outFile = path.resolve(import.meta.dirname, "../docs/FINDINGS.md");
fs.writeFileSync(outFile, await renderFindingsDoc());
console.log(`Generated findings list → ${path.relative(process.cwd(), outFile)}`);
