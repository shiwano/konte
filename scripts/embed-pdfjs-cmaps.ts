import * as fs from "node:fs";
import * as path from "node:path";

const cmapsDir = path.resolve(import.meta.dirname, "../node_modules/pdfjs-dist/cmaps");
const outFile = path.resolve(import.meta.dirname, "../src/core/generated/pdfjs-cmaps.ts");

const entries = fs
  .readdirSync(cmapsDir)
  .filter((f) => f.endsWith(".bcmap"))
  .sort()
  .map(
    (f) =>
      `  ${JSON.stringify(f)}: ${JSON.stringify(fs.readFileSync(path.join(cmapsDir, f)).toString("base64"))},`,
  );

const source = `// pdf.js's packed CMaps, base64, by file name: what a CJK font naming a predefined CMap draws with.
export const PDFJS_CMAPS: Readonly<Record<string, string>> = {
${entries.join("\n")}
};
`;

fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(outFile, source, "utf-8");

console.log(`Embedded ${entries.length} pdf.js CMaps → ${path.relative(process.cwd(), outFile)}`);
