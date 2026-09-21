// Validates the marketplace plugin (plugin/): the two
// manifests agree, the catalog points at the plugin, every skill has a frontmatter name matching
// its directory, and `claude plugin validate` passes when the Claude CLI is on PATH.
import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";

const ROOT = path.resolve(import.meta.dirname, "..");
const PLUGIN_ROOT = path.join(ROOT, "plugin");
const PLUGIN_DIR = path.join(PLUGIN_ROOT, "plugins", "konte");
const MARKETPLACE = path.join(PLUGIN_ROOT, ".claude-plugin", "marketplace.json");
const AGENT_PLUGINS_SCHEMA = "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json";

const errors: string[] = [];
const fail = (message: string) => errors.push(message);

function readJson(file: string): Record<string, unknown> | null {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
  } catch (err) {
    fail(`${path.relative(ROOT, file)}: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

const portable = readJson(path.join(PLUGIN_DIR, "plugin.json"));
const claude = readJson(path.join(PLUGIN_DIR, ".claude-plugin", "plugin.json"));
const marketplace = readJson(MARKETPLACE);

if (portable) {
  if (portable.$schema !== AGENT_PLUGINS_SCHEMA) {
    fail(`plugin.json: $schema must be ${AGENT_PLUGINS_SCHEMA}`);
  }
  if (portable.name !== "konte") fail(`plugin.json: name must be "konte"`);
}
if (claude && claude.name !== "konte") fail(`.claude-plugin/plugin.json: name must be "konte"`);
if (portable && claude) {
  for (const key of ["version", "description"] as const) {
    if (portable[key] !== claude[key]) {
      fail(`plugin.json and .claude-plugin/plugin.json disagree on ${key}`);
    }
  }
}

if (marketplace) {
  const plugins = Array.isArray(marketplace.plugins) ? marketplace.plugins : [];
  const entry = plugins.find(
    (p): p is { name: string; source: unknown } =>
      typeof p === "object" && p !== null && (p as { name?: unknown }).name === "konte",
  );
  if (!entry) fail(`marketplace.json: no plugin named "konte"`);
  // A bare relative path is the one source shape both Claude Code and Codex read; Codex also
  // requires the leading "./".
  else if (entry.source !== "./plugins/konte") {
    fail(`marketplace.json: konte's source must be the string "./plugins/konte"`);
  }
}

const skillsDir = path.join(PLUGIN_DIR, "skills");
for (const name of fs.readdirSync(skillsDir)) {
  const skill = path.join(skillsDir, name, "SKILL.md");
  if (!fs.existsSync(skill)) {
    fail(`skills/${name}: missing SKILL.md`);
    continue;
  }
  const text = fs.readFileSync(skill, "utf8");
  const fm = /^---\n([\s\S]*?)\n---\n/.exec(text);
  const fmName = fm ? /^name:\s*(.+)$/m.exec(fm[1]!)?.[1]?.trim() : undefined;
  if (fmName !== name) fail(`skills/${name}/SKILL.md: frontmatter name "${fmName}" ≠ directory`);
  if (!fm || !/^description:\s*\S/m.test(fm[1]!)) {
    fail(`skills/${name}/SKILL.md: missing description`);
  }
  if (name.startsWith("konte-")) {
    fail(`skills/${name}: the plugin namespace already prefixes it — drop "konte-"`);
  }
}

const claudeCli = spawnSync("claude", ["--version"], { encoding: "utf8" });
if (claudeCli.status === 0) {
  for (const target of [PLUGIN_DIR, MARKETPLACE]) {
    const result = spawnSync("claude", ["plugin", "validate", target], { encoding: "utf8" });
    if (result.status !== 0) {
      fail(
        `claude plugin validate ${path.relative(ROOT, target)}:\n${result.stdout}${result.stderr}`,
      );
    }
  }
} else {
  console.log("check-plugin: `claude` not on PATH — skipping `claude plugin validate`");
}

if (errors.length > 0) {
  for (const message of errors) console.error(`check-plugin: ${message}`);
  process.exit(1);
}
console.log("check-plugin: ok");
