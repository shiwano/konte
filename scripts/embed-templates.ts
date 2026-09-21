import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  agentsDir,
  DEV_SKILLS,
  DEV_VIDEO_TEMPLATES,
  listVideoTemplates,
  VIDEOS_DIR,
  workspaceDir,
} from "./lib/template-dirs.js";

const outDir = path.resolve(import.meta.dirname, "../src/core/generated");

// Managed templates are re-synced into existing workspaces when konte is upgraded.
// A prefix matches a directory subtree, and every one is always-overwrite. A user who wants their
// own skill or reviewer adds it under a different name; an adapter takes a custom guide by
// re-pointing its `konte/guides/…` import at a file under adapters/comfy/.
// Agent settings are rendered separately during workspace setup.
// User-owned escape hatches: personal Claude Code overrides go in
// .claude/settings.local.json (gitignored, never shipped/managed), and project
// content (video.tsx, konte.config.json, adapters/**, .gitignore) stays seed.
const MANAGED_PREFIXES = [
  ".claude/skills/",
  ".agents/skills/",
  ".konte/guides/",
  ".claude/agents/",
  ".codex/agents/",
];
const MANAGED_EXACTS = [
  ".konte/mod.ts",
  "AGENTS.md",
  "CLAUDE.md",
  "HOUSE_RULES.md",
  "tsconfig.json",
];
const ALWAYS_OVERWRITE_EXACTS = [".konte/mod.ts", "AGENTS.md", "CLAUDE.md", "tsconfig.json"];

function isManaged(key: string): boolean {
  if (key === ".claude/skills/konte-lsp/.claude-plugin/plugin.json") return false;
  return MANAGED_EXACTS.includes(key) || MANAGED_PREFIXES.some((p) => key.startsWith(p));
}

function collectFiles(dir: string): string[] {
  const results: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...collectFiles(full));
    } else {
      results.push(full);
    }
  }
  return results;
}

function toOutputKey(relPath: string): string {
  return relPath
    .split(path.sep)
    .map((seg) => {
      if (seg.startsWith("dot.")) return "." + seg.slice(4);
      return seg;
    })
    .join("/");
}

const BINARY_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".ico",
  ".woff",
  ".woff2",
  ".ttf",
  ".otf",
  ".mp3",
  ".wav",
  ".mp4",
  ".webm",
  ".ogg",
]);

function isBinaryFile(filePath: string): boolean {
  return BINARY_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

const transforms: Record<string, (content: string) => string> = {
  "tsconfig.json": (c) => c.replace(/"\.\/dot\.konte\//g, '"./.konte/'),
};

// Skills are authored once under dot.agents/skills/ and mirrored to
// .claude/skills/ here at embed time, so agents is the single source of truth
// (Codex and Claude both read their own dir). AGENTS_SKILL_RE matches a skill's
// SKILL.md body and its references/ docs (the capture group is the path relative
// to the skills root, reused verbatim for the claude twin). konte-lsp is a
// Claude-only plugin (a .claude-plugin/plugin.json, no SKILL.md), so it is
// authored directly under dot.claude/skills/ and never mirrored. That same
// dot.claude/skills/ holds the README documenting the arrangement; it is ignored
// so it never ships to user projects. CLAUDE_SKILL_GUARD_RE rejects a
// hand-written SKILL.md on the mirror-target side.
const AGENTS_SKILL_RE = /^\.agents\/skills\/(.+\/SKILL\.md|.+\/references\/.+)$/;
const CLAUDE_SKILL_GUARD_RE = /^\.claude\/skills\/.+\/SKILL\.md$/;
// Both agent-definition formats are generated from templates/agents/ below; a hand-written one here
// would be the second copy of a contract that must not drift between clients.
const AGENT_GUARD_RE = /^\.(?:claude|codex)\/agents\//;
const IGNORED_KEYS = new Set([".claude/skills/README.md"]);

interface FileContent {
  content: string;
  isBinary: boolean;
}

// Reads every file under the workspace template into an outputKey → content map, applying the
// dot-prefix rename, transforms, binary base64 encoding and agents-skill mirroring. Keys under
// `videos/` are the video templates; everything else is the workspace scaffold.
function processDir(dir: string): Map<string, FileContent> {
  const out = new Map<string, FileContent>();
  for (const filePath of collectFiles(dir).sort()) {
    const outputKey = toOutputKey(path.relative(dir, filePath));

    if (IGNORED_KEYS.has(outputKey)) continue;

    if (CLAUDE_SKILL_GUARD_RE.test(outputKey)) {
      throw new Error(
        `Found a hand-written skill at ${outputKey}. Claude skills are mirrored ` +
          `from dot.agents/skills/ at embed time — add or edit the skill under ` +
          `dot.agents/skills/ instead.`,
      );
    }

    if (AGENT_GUARD_RE.test(outputKey)) {
      throw new Error(
        `Found a hand-written agent definition at ${outputKey}. Both client formats are ` +
          `generated at embed time — add or edit the contract under templates/agents/ instead.`,
      );
    }

    if (isBinaryFile(filePath)) {
      out.set(outputKey, { content: fs.readFileSync(filePath).toString("base64"), isBinary: true });
      continue;
    }

    let content = fs.readFileSync(filePath, "utf-8");
    const transform = transforms[outputKey];
    if (transform) content = transform(content);
    out.set(outputKey, { content, isBinary: false });

    const skillMatch = outputKey.match(AGENTS_SKILL_RE);
    if (skillMatch) out.set(`.claude/skills/${skillMatch[1]}`, { content, isBinary: false });
  }
  return out;
}

// One subagent contract per file under templates/agents/, written client-neutrally: YAML
// frontmatter (name + description) over the instructions body. Embed emits both shipped forms from
// it — Claude Code reads `.claude/agents/<name>.md`, Codex reads `.codex/agents/<name>.toml` — so
// the two clients cannot disagree about what the agent is told.
const AGENT_FRONTMATTER_RE = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/;

function frontmatterField(frontmatter: string, key: string, file: string): string {
  const match = frontmatter.match(new RegExp(`^${key}: *(.+)$`, "m"));
  if (!match) throw new Error(`Agent contract ${file} has no "${key}:" frontmatter field`);
  return match[1]!.trim();
}

// A TOML multi-line basic string. Only a backslash and a `"""` run can corrupt or close it early;
// a lone `"` is legal, so the body stays readable in the emitted file.
function tomlMultiline(value: string): string {
  const escaped = value.replace(/\\/g, "\\\\").replace(/"""/g, '""\\"').replace(/"$/, '\\"');
  return `"""\n${escaped}"""`;
}

function buildAgentDefinitions(): Map<string, FileContent> {
  const out = new Map<string, FileContent>();
  for (const filePath of collectFiles(agentsDir).sort()) {
    const rel = path.relative(agentsDir, filePath);
    if (path.extname(filePath) !== ".md") throw new Error(`Agent contract ${rel} must be markdown`);

    const parsed = fs.readFileSync(filePath, "utf-8").match(AGENT_FRONTMATTER_RE);
    if (!parsed) throw new Error(`Agent contract ${rel} has no YAML frontmatter`);
    const [, frontmatter = "", rawBody = ""] = parsed;
    const name = frontmatterField(frontmatter, "name", rel);
    const description = frontmatterField(frontmatter, "description", rel);
    if (name !== path.basename(rel, ".md")) {
      throw new Error(`Agent contract ${rel} declares a mismatched name "${name}"`);
    }
    const body = `${rawBody.trim()}\n`;

    out.set(`.claude/agents/${name}.md`, {
      content: `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}`,
      isBinary: false,
    });
    out.set(`.codex/agents/${name}.toml`, {
      content:
        "# Generated by konte; edits are overwritten on upgrade.\n" +
        `name = ${JSON.stringify(name)}\n` +
        `description = ${JSON.stringify(description)}\n` +
        `developer_instructions = ${tomlMultiline(body)}\n`,
      isBinary: false,
    });
  }
  return out;
}

const allFiles = processDir(workspaceDir);
for (const [key, value] of buildAgentDefinitions()) allFiles.set(key, value);

const videoTemplateNames = listVideoTemplates();
for (const name of DEV_VIDEO_TEMPLATES) {
  if (!videoTemplateNames.includes(name)) {
    throw new Error(`Dev video template "${name}" has no directory under ${VIDEOS_DIR}/`);
  }
}
const shippedVideoTemplateNames = videoTemplateNames.filter((n) => !DEV_VIDEO_TEMPLATES.has(n));
const devVideoTemplateNames = videoTemplateNames.filter((n) => DEV_VIDEO_TEMPLATES.has(n));

for (const name of DEV_SKILLS) {
  if (!fs.existsSync(path.join(workspaceDir, "dot.agents/skills", name, "SKILL.md"))) {
    throw new Error(`Dev skill "${name}" has no SKILL.md under dot.agents/skills/`);
  }
}
const DEV_SKILL_KEY_RE = /^\.(?:agents|claude)\/skills\/([^/]+)\//;

function isDevSkillKey(key: string): boolean {
  const match = key.match(DEV_SKILL_KEY_RE);
  return match !== null && DEV_SKILLS.has(match[1]!);
}

// Partition on the one axis that separates the two lifetimes: a key under `videos/<name>/` belongs
// to that video template; every other key is the workspace scaffold.
const workspaceFiles = new Map<string, FileContent>();
const videoFiles = new Map<string, Map<string, FileContent>>(
  videoTemplateNames.map((name) => [name, new Map()]),
);

for (const [key, value] of allFiles) {
  const match = key.match(/^videos\/([^/]+)\/(.+)$/);
  if (!match) {
    workspaceFiles.set(key, value);
    continue;
  }
  const [, name, rest] = match as unknown as [string, string, string];
  const target = videoFiles.get(name);
  if (!target) throw new Error(`Unknown video template "${name}" for key ${key}`);
  target.set(rest, value);
}

const managedKeys: string[] = [];
const managedContents = new Map<string, string>();
for (const [key, { content, isBinary }] of workspaceFiles) {
  if (!isBinary && isManaged(key)) {
    managedKeys.push(key);
    managedContents.set(key, content);
  }
}
managedKeys.sort();

const alwaysOverwrite = [
  ...ALWAYS_OVERWRITE_EXACTS,
  ...managedKeys.filter((key) => MANAGED_PREFIXES.some((p) => key.startsWith(p))),
];
const shippedManagedKeys = managedKeys.filter((key) => !isDevSkillKey(key));
const shippedAlwaysOverwrite = alwaysOverwrite.filter((key) => !isDevSkillKey(key));

// syncManagedTemplates writes every managed key relative to the WORKSPACE root, so a managed key
// under videos/ would land a video's file at the workspace root on the next upgrade. The
// partition above already guarantees this; assert it so a future move cannot quietly break it.
for (const key of managedKeys) {
  if (key.startsWith(`${VIDEOS_DIR}/`)) {
    throw new Error(
      `Managed template "${key}" belongs to a video; managed files are workspace-wide`,
    );
  }
}

const workspaceBinaryKeys = new Set<string>();
const workspaceTemplate: Record<string, string> = {};
const workspaceDevTemplate: Record<string, string> = {};
for (const key of [...workspaceFiles.keys()].sort()) {
  const { content, isBinary } = workspaceFiles.get(key)!;
  (isDevSkillKey(key) ? workspaceDevTemplate : workspaceTemplate)[key] = content;
  if (isBinary) workspaceBinaryKeys.add(key);
}

const videoBinaryKeys = new Set<string>();
const videoTemplates: Record<string, Record<string, string>> = {};
for (const name of videoTemplateNames) {
  const files = videoFiles.get(name)!;
  const entries: Record<string, string> = {};
  for (const key of [...files.keys()].sort()) {
    const { content, isBinary } = files.get(key)!;
    entries[key] = content;
    if (isBinary) videoBinaryKeys.add(key);
  }
  videoTemplates[name] = entries;
}

function templateHashOf(keys: readonly string[]): string {
  const hash = crypto.createHash("sha256");
  for (const key of keys) {
    hash.update(`${key}\n${managedContents.get(key)}\n`);
  }
  return hash.digest("hex");
}

// A file's content reaches the runtime as one JSON string parsed on first use, not as an object
// literal: `konte workspace new` embeds ~6 MB of templates, and every test file that loads the CLI paid to
// re-parse that as JavaScript. Splitting the maps into their own modules keeps the metadata this
// one exports — the sets and the hash, all a command reads on the common path — free of it.
function jsonModule(exportName: string, value: unknown): string {
  return (
    "// Generated by scripts/embed-templates.ts; do not edit.\n" +
    `export const ${exportName}: Record<string, string> = JSON.parse(\n` +
    `  ${JSON.stringify(JSON.stringify(value))},\n` +
    ");\n"
  );
}

function videoModuleName(name: string): string {
  return `template-video-${name}-files`;
}

const written: string[] = [];
function emit(file: string, source: string): void {
  fs.writeFileSync(path.join(outDir, `${file}.ts`), source, "utf-8");
  written.push(file);
}

fs.mkdirSync(outDir, { recursive: true });

emit("template-workspace-files", jsonModule("WORKSPACE_TEMPLATE", workspaceTemplate));
emit("template-workspace-dev-files", jsonModule("WORKSPACE_DEV_TEMPLATE", workspaceDevTemplate));
for (const name of videoTemplateNames) {
  emit(videoModuleName(name), jsonModule("VIDEO_TEMPLATE_FILES", videoTemplates[name]!));
}

function videoLoader(name: string): string {
  return `async () => (await import("./${videoModuleName(name)}.js")).VIDEO_TEMPLATE_FILES`;
}

// The compiled binary defines KONTE_COMPILED as `true` (scripts/compile-binary.ts), so Bun folds
// these guards and drops the dev templates' and dev skills' modules from it. The guard is inlined at each use: Bun
// keeps a dynamic import that sits behind a const alias of it.
const COMPILED = 'typeof KONTE_COMPILED !== "undefined" && KONTE_COMPILED';
const devLoaderBlock =
  devVideoTemplateNames.length === 0
    ? []
    : [
        `if (!(${COMPILED})) {`,
        ...devVideoTemplateNames.map(
          (name) => `  VIDEO_TEMPLATE_LOADERS[${JSON.stringify(name)}] = ${videoLoader(name)};`,
        ),
        "}",
      ];

emit(
  "template-assets",
  [
    "// Generated by scripts/embed-templates.ts; do not edit.",
    "declare const KONTE_COMPILED: boolean | undefined;",
    "",
    `export const WORKSPACE_BINARY_FILES: ReadonlySet<string> = new Set(${JSON.stringify([...workspaceBinaryKeys].sort())});`,
    `export const VIDEO_BINARY_FILES: ReadonlySet<string> = new Set(${JSON.stringify([...videoBinaryKeys].sort())});`,
    `export const MANAGED_TEMPLATES: ReadonlySet<string> = new Set(${COMPILED}`,
    `  ? ${JSON.stringify(shippedManagedKeys)}`,
    `  : ${JSON.stringify(managedKeys)});`,
    `export const ALWAYS_OVERWRITE_TEMPLATES: ReadonlySet<string> = new Set(${COMPILED}`,
    `  ? ${JSON.stringify(shippedAlwaysOverwrite)}`,
    `  : ${JSON.stringify(alwaysOverwrite)});`,
    `export const TEMPLATE_HASH = ${COMPILED}`,
    `  ? ${JSON.stringify(templateHashOf(shippedManagedKeys))}`,
    `  : ${JSON.stringify(templateHashOf(managedKeys))};`,
    `export const VIDEO_TEMPLATE_NAMES: readonly string[] = ${COMPILED}`,
    `  ? ${JSON.stringify(shippedVideoTemplateNames)}`,
    `  : ${JSON.stringify(videoTemplateNames)};`,
    "",
    "export async function loadWorkspaceTemplate(): Promise<Record<string, string>> {",
    '  const template = (await import("./template-workspace-files.js")).WORKSPACE_TEMPLATE;',
    `  if (!(${COMPILED})) {`,
    '    return { ...template, ...(await import("./template-workspace-dev-files.js")).WORKSPACE_DEV_TEMPLATE };',
    "  }",
    "  return template;",
    "}",
    "",
    "// The managed contents are the managed slice of the workspace template — derived here rather",
    "// than emitted a second time.",
    "export async function loadManagedTemplateContents(): Promise<Record<string, string>> {",
    "  const template = await loadWorkspaceTemplate();",
    "  const contents: Record<string, string> = {};",
    "  for (const key of MANAGED_TEMPLATES) {",
    "    const content = template[key];",
    "    if (content !== undefined) contents[key] = content;",
    "  }",
    "  return contents;",
    "}",
    "",
    "const VIDEO_TEMPLATE_LOADERS: Record<string, () => Promise<Record<string, string>>> = {",
    ...shippedVideoTemplateNames.map((name) => `  ${JSON.stringify(name)}: ${videoLoader(name)},`),
    "};",
    ...devLoaderBlock,
    "",
    "export async function loadVideoTemplate(",
    "  name: string,",
    "): Promise<Record<string, string> | undefined> {",
    "  return VIDEO_TEMPLATE_LOADERS[name]?.();",
    "}",
    "",
  ].join("\n"),
);

console.log(`Embedded templates → ${written.map((f) => `${f}.ts`).join(", ")}`);
