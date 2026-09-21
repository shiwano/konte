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
