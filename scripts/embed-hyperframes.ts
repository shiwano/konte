import * as fs from "node:fs";
import * as path from "node:path";

const producerDist = path.resolve(
  import.meta.dirname,
  "../node_modules/@hyperframes/producer/dist",
);
const outFile = path.resolve(import.meta.dirname, "../src/core/generated/hyperframes-assets.ts");

const manifest = fs.readFileSync(path.join(producerDist, "hyperframe.manifest.json"), "utf-8");
const runtime = fs.readFileSync(path.join(producerDist, "hyperframe.runtime.iife.js"), "utf-8");

const escapedManifest = JSON.stringify(manifest);
const escapedRuntime = JSON.stringify(runtime);

const source = `export const HYPERFRAME_MANIFEST = ${escapedManifest};
export const HYPERFRAME_RUNTIME = ${escapedRuntime};
`;

fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(outFile, source, "utf-8");

console.log(`Embedded HyperFrames assets → ${path.relative(process.cwd(), outFile)}`);
