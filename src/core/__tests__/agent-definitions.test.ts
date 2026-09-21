import { describe, expect, it } from "vitest";
import { ALWAYS_OVERWRITE_TEMPLATES, MANAGED_TEMPLATES } from "../generated/template-assets.js";
import { WORKSPACE_TEMPLATE } from "../generated/template-workspace-files.js";

// Both shipped forms are generated from one contract under src/cli/templates/agents/, so a critic
// cannot be told different things depending on which client spawned it.
const CLAUDE_KEY = ".claude/agents/konte-direction-critic.md";
const CODEX_KEY = ".codex/agents/konte-direction-critic.toml";

const claude = WORKSPACE_TEMPLATE[CLAUDE_KEY]!;
const codex = WORKSPACE_TEMPLATE[CODEX_KEY]!;

function claudeFrontmatter(key: string): string {
  return claude.match(new RegExp(`^${key}: (.+)$`, "m"))![1]!;
}

function codexString(key: string): string {
  return JSON.parse(codex.match(new RegExp(`^${key} = (".*")$`, "m"))![1]!);
}

function claudeBodyOf(source: string): string {
  return source.match(/^---\n[\s\S]*?\n---\n\n([\s\S]*)$/)![1]!;
}

function codexInstructionsOf(source: string): string {
  return source
    .match(/\ndeveloper_instructions = """\n([\s\S]*)"""\n$/)![1]!
    .replace(/""\\"/g, '"""')
    .replace(/\\\\/g, "\\");
}

const claudeBody = claudeBodyOf(claude);
const codexInstructions = codexInstructionsOf(codex);

describe("generated agent definitions", () => {
  it("ships one definition per client", () => {
    expect(claude).toBeTypeOf("string");
    expect(codex).toBeTypeOf("string");
  });

  it("declares the same name and description in both", () => {
    expect(claudeFrontmatter("name")).toBe("konte-direction-critic");
    expect(codexString("name")).toBe("konte-direction-critic");
    expect(codexString("description")).toBe(claudeFrontmatter("description"));
  });

  it("carries the identical contract body in both", () => {
    expect(codexInstructions).toBe(claudeBody);
  });

  // The critic reads the direction and nothing else — a stage's definitions get `layout-guide`'s
  // self-check instead — so there is no per-stage contract to carry. The negative assertion is the
  // point: a stage split creeping back in would leave the critic reading media it must never see.
  it("contracts the direction alone, with the shared frame and output fields", () => {
    expect(claudeBody).toContain("the **target**, the path to `direction.ts`");
    expect(claudeBody).not.toContain("## Stage contract");
    for (const field of ["target:", "problem:", "evidence:", "smallest-fix:"]) {
      expect(claudeBody).toContain(field);
    }
    expect(claudeBody).toContain("Verdict: pass | revise");
  });

  it("is konte-owned: managed and never edited in place", () => {
    for (const key of [CLAUDE_KEY, CODEX_KEY]) {
      expect(MANAGED_TEMPLATES.has(key)).toBe(true);
      expect(ALWAYS_OVERWRITE_TEMPLATES.has(key)).toBe(true);
    }
  });
});

// The second shipped contract, generated through the same embed step. The negative assertions hold
// it to a stage's prompts: given media or the direction's own cut it would re-review what the split
// took away from it.
describe("generated konte-prompt-critic definition", () => {
  const promptClaude = WORKSPACE_TEMPLATE[".claude/agents/konte-prompt-critic.md"]!;
  const promptCodex = WORKSPACE_TEMPLATE[".codex/agents/konte-prompt-critic.toml"]!;

  it("carries the identical contract body in both", () => {
    expect(codexInstructionsOf(promptCodex)).toBe(claudeBodyOf(promptClaude));
  });

  it("contracts a stage definition, findings-only", () => {
    const body = claudeBodyOf(promptClaude);
    expect(body).toContain("the path to a stage definition file");
    for (const field of ["target:", "problem:", "evidence:", "smallest-fix:"]) {
      expect(body).toContain(field);
    }
    expect(body).toContain("Findings:");
    expect(body).not.toContain("Verdict:");
  });

  it("is konte-owned: managed and never edited in place", () => {
    for (const key of [
      ".claude/agents/konte-prompt-critic.md",
      ".codex/agents/konte-prompt-critic.toml",
    ]) {
      expect(MANAGED_TEMPLATES.has(key)).toBe(true);
      expect(ALWAYS_OVERWRITE_TEMPLATES.has(key)).toBe(true);
    }
  });
});
