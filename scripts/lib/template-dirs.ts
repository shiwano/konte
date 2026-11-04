import * as fs from "node:fs";
import * as path from "node:path";

const templatesDir = path.resolve(import.meta.dirname, "../../src/cli/templates");

/**
 * The dev tree mirrors the layout it produces: `workspace/` is the workspace scaffold, and each
 * `workspace/videos/<name>/` is one video template. So `../../adapters/comfy/x` — the import a
 * video's video.tsx writes — is a literally correct path here too, with no rootDirs fiction.
 */
const WORKSPACE_DIR = "workspace";
export const VIDEOS_DIR = "videos";

export const workspaceDir = path.join(templatesDir, WORKSPACE_DIR);

/** Each bundled adapter file (`adapters/…`) and the konte release that first shipped it. */
export const adapterReleasesFile = path.join(templatesDir, "adapter-releases.json");

/**
 * Subagent contracts, one markdown file each. Outside `workspace/` because neither shipped form is
 * this file: embed generates a Claude Code and a Codex definition from every source here.
 */
export const agentsDir = path.join(templatesDir, "agents");

/**
 * Video templates for konte's own development — scaffoldable from a source checkout or a
 * `bun run build` binary, compiled out of a release binary.
 */
export const DEV_VIDEO_TEMPLATES: ReadonlySet<string> = new Set(["kitchen-sink"]);

/**
 * Skills for konte's own development — scaffolded from a source checkout or a `bun run build`
 * binary, compiled out of a release binary.
 */
export const DEV_SKILLS: ReadonlySet<string> = new Set(["konte-dev-feedback"]);

/** Video template names: every subdirectory of `workspace/videos/`. */
export function listVideoTemplates(): string[] {
  return fs
    .readdirSync(path.join(workspaceDir, VIDEOS_DIR), { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();
}
