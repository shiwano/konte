import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import pkg from "../../../package.json" with { type: "json" };
import {
  ALWAYS_OVERWRITE_TEMPLATES,
  loadManagedTemplateContents,
  loadWorkspaceTemplate,
  TEMPLATE_HASH,
} from "../generated/template-assets.js";
import { syncManagedTemplates, writeTemplateLock } from "../template-sync.js";

const MANAGED_TEMPLATE_CONTENTS = await loadManagedTemplateContents();

const LOCK_FILE = ".konte/template.lock.json";
const VERSION_FILE = "konte.version";
const EDIT_RESPECTING_KEY = "HOUSE_RULES.md";
const SKILL_KEY = ".claude/skills/prompt-guide/SKILL.md";
const ALWAYS_OVERWRITE_KEY = ".konte/mod.ts";
const AGENT_KEY = ".claude/agents/konte-direction-critic.md";

function sha256(content: string): string {
  return crypto.createHash("sha256").update(content).digest("hex");
}

async function writeFileAt(dir: string, key: string, content: string): Promise<void> {
  const full = path.join(dir, key);
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, content, "utf-8");
}

async function readFileAt(dir: string, key: string): Promise<string> {
  return fs.readFile(path.join(dir, key), "utf-8");
}

async function writeLock(
  dir: string,
  lock: { hash: string; files: Record<string, string> },
): Promise<void> {
  await writeFileAt(dir, LOCK_FILE, JSON.stringify({ version: "test", updatedAt: "x", ...lock }));
}

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "konte-template-sync-test-"));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true });
});

describe("syncManagedTemplates", () => {
  it("returns null when the lock hash already matches (cheap fast-path)", async () => {
    // Fast path requires every always-overwrite stub to be present.
    for (const key of ALWAYS_OVERWRITE_TEMPLATES) {
      await writeFileAt(tmpDir, key, MANAGED_TEMPLATE_CONTENTS[key]!);
    }
    await writeLock(tmpDir, { hash: TEMPLATE_HASH, files: {} });
    const result = await syncManagedTemplates(tmpDir);
    expect(result).toBeNull();
    // No other managed files were created.
    await expect(readFileAt(tmpDir, EDIT_RESPECTING_KEY)).rejects.toThrow();
  });

  it("writes the version marker even when the fast path skips the templates", async () => {
    for (const key of ALWAYS_OVERWRITE_TEMPLATES) {
      await writeFileAt(tmpDir, key, MANAGED_TEMPLATE_CONTENTS[key]!);
    }
    await writeLock(tmpDir, { hash: TEMPLATE_HASH, files: {} });
    await writeFileAt(tmpDir, VERSION_FILE, "0.0.0-old\n");

    expect(await syncManagedTemplates(tmpDir)).toBeNull();
    expect(await readFileAt(tmpDir, VERSION_FILE)).toBe(`${pkg.version}\n`);
  });

  it("creates missing managed files and writes a lock with the current hash", async () => {
    const result = await syncManagedTemplates(tmpDir);
    expect(result).not.toBeNull();
    expect(result?.created).toContain(EDIT_RESPECTING_KEY);
    expect(await readFileAt(tmpDir, EDIT_RESPECTING_KEY)).toBe(
      MANAGED_TEMPLATE_CONTENTS[EDIT_RESPECTING_KEY]!,
    );

    const lock = JSON.parse(await readFileAt(tmpDir, LOCK_FILE));
    expect(lock.hash).toBe(TEMPLATE_HASH);
    expect(lock.files[EDIT_RESPECTING_KEY]).toBe(
      sha256(MANAGED_TEMPLATE_CONTENTS[EDIT_RESPECTING_KEY]!),
    );
  });

  it("overwrites a pristine (unedited) file that is out of date", async () => {
    const oldContent = "OLD KONTE-WRITTEN CONTENT";
    await writeFileAt(tmpDir, EDIT_RESPECTING_KEY, oldContent);
    await writeLock(tmpDir, {
      hash: "stale",
      files: { [EDIT_RESPECTING_KEY]: sha256(oldContent) },
    });

    const result = await syncManagedTemplates(tmpDir);
    expect(result?.updated).toContain(EDIT_RESPECTING_KEY);
    expect(await readFileAt(tmpDir, EDIT_RESPECTING_KEY)).toBe(
      MANAGED_TEMPLATE_CONTENTS[EDIT_RESPECTING_KEY],
    );
  });

  it("skips a user-edited file and preserves its content", async () => {
    const userEdited = "MY HAND-EDITED NOTES";
    await writeFileAt(tmpDir, EDIT_RESPECTING_KEY, userEdited);
    // Lock records a different hash than the current file => user edited it.
    await writeLock(tmpDir, {
      hash: "stale",
      files: { [EDIT_RESPECTING_KEY]: sha256("something-else") },
    });

    const result = await syncManagedTemplates(tmpDir);
    expect(result?.skipped).toContain(EDIT_RESPECTING_KEY);
    expect(await readFileAt(tmpDir, EDIT_RESPECTING_KEY)).toBe(userEdited);

    // Provenance is carried forward so it stays protected next time.
    const lock = JSON.parse(await readFileAt(tmpDir, LOCK_FILE));
    expect(lock.files[EDIT_RESPECTING_KEY]).toBe(sha256("something-else"));
  });

  it("replaces a user-edited skill with the current one", async () => {
    await writeFileAt(tmpDir, SKILL_KEY, "MY HAND-EDITED PROMPT GUIDE");
    await writeLock(tmpDir, { hash: "stale", files: { [SKILL_KEY]: sha256("something-else") } });

    const result = await syncManagedTemplates(tmpDir);
    expect(result?.updated).toContain(SKILL_KEY);
    expect(await readFileAt(tmpDir, SKILL_KEY)).toBe(MANAGED_TEMPLATE_CONTENTS[SKILL_KEY]);
  });

  it("protects a differing file with unknown provenance (no lock)", async () => {
    const committed = "CUSTOMIZED AND COMMITTED";
    await writeFileAt(tmpDir, EDIT_RESPECTING_KEY, committed);

    const result = await syncManagedTemplates(tmpDir);
    expect(result?.skipped).toContain(EDIT_RESPECTING_KEY);
    expect(await readFileAt(tmpDir, EDIT_RESPECTING_KEY)).toBe(committed);
  });

  it("always overwrites the generated mod.ts even when edited", async () => {
    await writeFileAt(tmpDir, ALWAYS_OVERWRITE_KEY, "// user hacked the type stub");
    // No lock entry for it => unknown provenance, but it is always-overwrite.
    const result = await syncManagedTemplates(tmpDir);
    expect(result?.updated).toContain(ALWAYS_OVERWRITE_KEY);
    expect(await readFileAt(tmpDir, ALWAYS_OVERWRITE_KEY)).toBe(
      MANAGED_TEMPLATE_CONTENTS[ALWAYS_OVERWRITE_KEY]!,
    );
  });

  it("restores a missing mod.ts even when the lock hash matches (fast path)", async () => {
    // Hash matches => fast path, but the gitignored stub was deleted.
    await writeLock(tmpDir, { hash: TEMPLATE_HASH, files: {} });
    const result = await syncManagedTemplates(tmpDir);
    expect(result).not.toBeNull();
    expect(result?.created).toContain(ALWAYS_OVERWRITE_KEY);
    expect(await readFileAt(tmpDir, ALWAYS_OVERWRITE_KEY)).toBe(
      MANAGED_TEMPLATE_CONTENTS[ALWAYS_OVERWRITE_KEY]!,
    );
  });

  it("creates the agent definitions in a workspace that predates them", async () => {
    const result = await syncManagedTemplates(tmpDir);
    expect(result?.created).toContain(AGENT_KEY);
    expect(await readFileAt(tmpDir, AGENT_KEY)).toBe(MANAGED_TEMPLATE_CONTENTS[AGENT_KEY]);
  });

  it("replaces a user-edited agent definition with the current contract", async () => {
    await writeFileAt(tmpDir, AGENT_KEY, "MY OWN CRITIQUE CONTRACT");
    // Provenance says user-edited, which protects a workspace-owned exact — but a shipped subtree
    // is always-overwrite.
    await writeLock(tmpDir, { hash: "stale", files: { [AGENT_KEY]: sha256("something-else") } });

    const result = await syncManagedTemplates(tmpDir);
    expect(result?.updated).toContain(AGENT_KEY);
    expect(await readFileAt(tmpDir, AGENT_KEY)).toBe(MANAGED_TEMPLATE_CONTENTS[AGENT_KEY]);
  });

  it("leaves user-added files (not in the template set) untouched", async () => {
    const customKey = ".claude/skills/custom/SKILL.md";
    await writeFileAt(tmpDir, customKey, "my custom skill");
    await syncManagedTemplates(tmpDir);
    expect(await readFileAt(tmpDir, customKey)).toBe("my custom skill");
  });
});

describe("writeTemplateLock", () => {
  it("records every managed file as pristine so a follow-up sync is a no-op", async () => {
    // Simulate `init`: write the workspace template verbatim, then lock. The managed
    // files all live here — a video template holds none of them.
    for (const [key, content] of Object.entries(await loadWorkspaceTemplate())) {
      await writeFileAt(tmpDir, key, content);
    }
    await writeTemplateLock(tmpDir);

    const lock = JSON.parse(await readFileAt(tmpDir, LOCK_FILE));
    expect(lock.hash).toBe(TEMPLATE_HASH);
    expect(await syncManagedTemplates(tmpDir)).toBeNull();
  });

  it("writes the version marker at the workspace root", async () => {
    await writeTemplateLock(tmpDir);
    expect(await readFileAt(tmpDir, VERSION_FILE)).toBe(`${pkg.version}\n`);
  });
});
