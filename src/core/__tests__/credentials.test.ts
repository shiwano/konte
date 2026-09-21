import * as fs from "node:fs/promises";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  applyCredentials,
  credentialsPath,
  hasEnvironmentOverride,
  loadCredentials,
  missingCredentialMessage,
  saveCredentials,
  updateCredentials,
} from "../credentials.js";
import { makeWorkspace, type Workspace } from "./helpers/workspace.js";

let ws: Workspace;

beforeEach(async () => {
  ws = await makeWorkspace();
  // Settle the module's record of what it injected — it is process-wide, so a previous test's key
  // would otherwise count as a change on this test's first pass.
  await applyCredentials(ws.root);
});

afterEach(async () => {
  delete process.env.KONTE_TEST_CRED;
  await ws.cleanup();
});

async function write(contents: string): Promise<void> {
  await fs.writeFile(credentialsPath(ws.root), contents);
}

describe("loadCredentials", () => {
  it("returns nothing when the workspace has no credentials file", async () => {
    await expect(loadCredentials(ws.root)).resolves.toEqual({});
  });

  it("round-trips through saveCredentials", async () => {
    await saveCredentials(ws.root, { FAL_KEY: "k", MY_TOKEN: "t" });
    await expect(loadCredentials(ws.root)).resolves.toEqual({ FAL_KEY: "k", MY_TOKEN: "t" });
  });

  // The old .env loader swallowed every read failure, so a sandbox that denied the file looked
  // exactly like no credentials at all — and the first sign was a backend auth error.
  it("fails on invalid JSON rather than reporting no credentials", async () => {
    await write("{ not json");
    await expect(loadCredentials(ws.root)).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });

  it("fails on a non-string value, without naming it", async () => {
    await write(JSON.stringify({ FAL_KEY: { nested: "secret-value" } }));
    const err = await loadCredentials(ws.root).catch((e: Error) => e);
    expect(err).toMatchObject({ code: "VALIDATION_FAILED" });
    expect((err as Error).message).not.toContain("secret-value");
  });

  it("fails when the path is not a readable file", async () => {
    await fs.mkdir(credentialsPath(ws.root));
    await expect(loadCredentials(ws.root)).rejects.toMatchObject({
      code: "CREDENTIALS_UNREADABLE",
    });
  });
});

describe("applyCredentials", () => {
  it("puts a stored credential into the environment", async () => {
    await saveCredentials(ws.root, { KONTE_TEST_CRED: "from-file" });
    await applyCredentials(ws.root);
    expect(process.env.KONTE_TEST_CRED).toBe("from-file");
  });

  it("leaves a real environment variable alone, so a shell or CI overrides the file", async () => {
    process.env.KONTE_TEST_CRED = "from-shell";
    await saveCredentials(ws.root, { KONTE_TEST_CRED: "from-file" });
    await applyCredentials(ws.root);
    expect(process.env.KONTE_TEST_CRED).toBe("from-shell");
  });

  // An exported-but-empty variable is not a credential. Treating it as one would leave the
  // backend with "" — reported as unset — while the settings page shows the stored key as set.
  it("overwrites an empty environment variable with the stored value", async () => {
    process.env.KONTE_TEST_CRED = "";
    await saveCredentials(ws.root, { KONTE_TEST_CRED: "from-file" });
    await applyCredentials(ws.root);
    expect(process.env.KONTE_TEST_CRED).toBe("from-file");
    expect(hasEnvironmentOverride("KONTE_TEST_CRED")).toBe(false);
  });

  // The MCP daemon loads credentials once at startup and then lives for the whole session, so a key
  // set, rotated or deleted in `konte settings` has to reach it on a later pass — otherwise the
  // daemon keeps submitting on a key the workspace no longer has.
  it("picks up a key added after it first ran, and reports the change", async () => {
    expect(await applyCredentials(ws.root)).toBe(false);

    await saveCredentials(ws.root, { KONTE_TEST_CRED: "added-later" });

    expect(await applyCredentials(ws.root)).toBe(true);
    expect(process.env.KONTE_TEST_CRED).toBe("added-later");
    // Nothing moved the second time round.
    expect(await applyCredentials(ws.root)).toBe(false);
  });

  it("follows a rotated value", async () => {
    await saveCredentials(ws.root, { KONTE_TEST_CRED: "first" });
    await applyCredentials(ws.root);

    await saveCredentials(ws.root, { KONTE_TEST_CRED: "second" });

    expect(await applyCredentials(ws.root)).toBe(true);
    expect(process.env.KONTE_TEST_CRED).toBe("second");
  });

  it("takes a deleted credential back out of the environment", async () => {
    await saveCredentials(ws.root, { KONTE_TEST_CRED: "from-file" });
    await applyCredentials(ws.root);

    await saveCredentials(ws.root, {});

    expect(await applyCredentials(ws.root)).toBe(true);
    expect(process.env.KONTE_TEST_CRED).toBeUndefined();
  });

  // The override rule holds whenever the shell's variable arrived — before konte's first pass or
  // between two of them.
  it("never overwrites a real environment variable on a later pass", async () => {
    await saveCredentials(ws.root, { KONTE_TEST_CRED: "from-file" });
    await applyCredentials(ws.root);

    process.env.KONTE_TEST_CRED = "from-shell";
    await saveCredentials(ws.root, { KONTE_TEST_CRED: "rotated" });

    expect(await applyCredentials(ws.root)).toBe(false);
    expect(process.env.KONTE_TEST_CRED).toBe("from-shell");
  });

  it("leaves a shell variable behind when the file's own copy is deleted", async () => {
    await saveCredentials(ws.root, { KONTE_TEST_CRED: "from-file" });
    await applyCredentials(ws.root);
    process.env.KONTE_TEST_CRED = "from-shell";

    await saveCredentials(ws.root, {});
    await applyCredentials(ws.root);

    expect(process.env.KONTE_TEST_CRED).toBe("from-shell");
  });
});

describe("hasEnvironmentOverride", () => {
  it("is false for a key konte itself loaded, and true for one the shell exported", async () => {
    await saveCredentials(ws.root, { KONTE_TEST_CRED: "from-file" });
    await applyCredentials(ws.root);
    expect(hasEnvironmentOverride("KONTE_TEST_CRED")).toBe(false);

    process.env.KONTE_TEST_CRED = "changed-since";
    expect(hasEnvironmentOverride("KONTE_TEST_CRED")).toBe(true);
  });

  it("is false for a key nothing has set", () => {
    expect(hasEnvironmentOverride("KONTE_TEST_CRED")).toBe(false);
  });
});

describe("saveCredentials", () => {
  it("rejects a key that is not an environment variable name", async () => {
    await expect(saveCredentials(ws.root, { "not a key": "v" })).rejects.toThrow();
    await expect(fs.access(credentialsPath(ws.root))).rejects.toThrow();
  });

  it("writes into the workspace root, beside konte.config.json", async () => {
    await saveCredentials(ws.root, { FAL_KEY: "k" });
    expect(credentialsPath(ws.root)).toBe(path.join(ws.root, "konte.credentials.json"));
  });

  // The workspace directory is often world-readable; the file inside it must not be.
  it.skipIf(process.platform === "win32")("writes owner-only", async () => {
    await saveCredentials(ws.root, { FAL_KEY: "k" });
    const { mode } = await fs.stat(credentialsPath(ws.root));
    expect(mode & 0o077).toBe(0);
  });
});

describe("updateCredentials", () => {
  it("applies the mutation to what is on disk", async () => {
    await saveCredentials(ws.root, { FAL_KEY: "k" });

    await updateCredentials(ws.root, (current) => ({ ...current, HF_TOKEN: "t" }));

    await expect(loadCredentials(ws.root)).resolves.toEqual({ FAL_KEY: "k", HF_TOKEN: "t" });
  });

  // Each edit is a read-modify-write of one shared document, so unserialized writers would each
  // save the version they read and the later rename would drop the other's key.
  it("serializes concurrent edits instead of losing one", async () => {
    await Promise.all([
      updateCredentials(ws.root, (c) => ({ ...c, FAL_KEY: "a" })),
      updateCredentials(ws.root, (c) => ({ ...c, HF_TOKEN: "b" })),
    ]);

    await expect(loadCredentials(ws.root)).resolves.toEqual({ FAL_KEY: "a", HF_TOKEN: "b" });
  });
});

describe("missingCredentialMessage", () => {
  it("names where to get a key konte knows", () => {
    expect(missingCredentialMessage("FAL_KEY")).toContain("https://fal.ai/dashboard/keys");
    expect(missingCredentialMessage("FAL_KEY")).toContain("konte settings");
  });

  it("still points somewhere for a key it does not know", () => {
    expect(missingCredentialMessage("MY_TOKEN")).toContain("konte settings");
  });
});
