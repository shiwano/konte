import * as fs from "node:fs";
import * as path from "node:path";

// Every page under src/pages/ that the CLI opens in a browser. Each is built into its own dist/
// by `build:ui:<name>`.
const PAGES = ["preview", "settings"];

const pagesDir = path.resolve(import.meta.dirname, "../src/pages");
const outFile = path.resolve(import.meta.dirname, "../src/core/generated/ui-assets.ts");

// One icon for every page.
const iconBase64 = fs
  .readFileSync(path.join(pagesDir, "preview/assets/icon.png"))
  .toString("base64");

const entries = PAGES.map((name) => {
  const dist = path.join(pagesDir, name, "dist");
  const read = (file: string) => JSON.stringify(fs.readFileSync(path.join(dist, file), "utf-8"));
  return `  ${JSON.stringify(name)}: {
    html: ${read("index.html")},
    js: ${read("index.js")},
    css: ${read("index.css")},
  }`;
});

const source = `export const UI_ASSETS = {
${entries.join(",\n")},
};

export const UI_ICON_PNG_BASE64 = ${JSON.stringify(iconBase64)};
`;

fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(outFile, source, "utf-8");

console.log(`Embedded UI assets (${PAGES.join(", ")}) → ${path.relative(process.cwd(), outFile)}`);
