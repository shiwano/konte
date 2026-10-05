// Adapters import their craft guide as text (`import guide from "./x.md" with { type: "text" }`);
// Bun's runtime and bundler inline the file contents as a string default export.
declare module "*.md" {
  const content: string;
  export default content;
}

// Tailwind's stylesheet, imported as text to build its design system (see core/tailwind-classes.ts).
declare module "*.css" {
  const content: string;
  export default content;
}

// onnxruntime-web's WASM runtime, embedded as files (`with { type: "file" }`): the path it lands at.
declare module "onnxruntime-web/ort-wasm-simd-threaded.mjs" {
  const file: string;
  export default file;
}
declare module "onnxruntime-web/ort-wasm-simd-threaded.wasm" {
  const file: string;
  export default file;
}
