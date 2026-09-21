import tailwindPackage from "tailwindcss/package.json" with { type: "json" };

// The page's Tailwind is the release konte checks classes against (see tailwind-classes.ts).
export const TAILWIND_BROWSER_SRC = `https://cdn.jsdelivr.net/npm/@tailwindcss/browser@${tailwindPackage.version}`;
