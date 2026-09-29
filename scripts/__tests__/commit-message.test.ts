import { describe, expect, it } from "vitest";
import { checkCommitMessage, stripGitComments } from "../lib/commit-message.js";

const SUBJECT = "Name the refused host and preview.allowedHosts on a Forbidden host";
const BODY = [
  "A browser opening the review page under an unadmitted host gets a plain-text",
  "403 naming the host and the line to hand the agent.",
].join("\n");

describe("checkCommitMessage", () => {
  it("accepts a subject alone and a subject with a prose body", () => {
    expect(checkCommitMessage(SUBJECT)).toEqual([]);
    expect(checkCommitMessage(`${SUBJECT}\n\n${BODY}\n`)).toEqual([]);
  });

  it("does not count a squash merge's pull request suffix", () => {
    const subject = `${"A".repeat(72)} (#123)`;
    expect(checkCommitMessage(subject)).toEqual([]);
    expect(checkCommitMessage(`${"A".repeat(73)} (#123)`)).toHaveLength(1);
  });

  it.each([
    ["a type prefix", "fix: name the refused host"],
    ["a scoped type prefix", "feat(preview)!: Name the refused host"],
    ["a lowercase start", "name the refused host"],
    ["a trailing period", "Name the refused host."],
    ["an emoji", "Name the refused host ✨"],
    ["an overlong subject", `Name ${"x".repeat(70)}`],
  ])("refuses %s in the subject", (_name, subject) => {
    expect(checkCommitMessage(subject)).toHaveLength(1);
  });

  it.each([
    ["a body on line 2", `${SUBJECT}\nA browser gets a 403.`],
    ["an overlong line", `${SUBJECT}\n\n${"word ".repeat(17)}`],
    ["an attribution trailer", `${SUBJECT}\n\n${BODY}\n\nCo-Authored-By: Agent <a@example.com>`],
    ["a generated-with line", `${SUBJECT}\n\nGenerated with an agent`],
    ["a bullet list", `${SUBJECT}\n\n- src/cli/preview.ts`],
    ["a heading", `${SUBJECT}\n\n## Summary`],
  ])("refuses %s in the body", (_name, message) => {
    expect(checkCommitMessage(message)).toHaveLength(1);
  });

  it("leaves a line it cannot wrap", () => {
    const url = `https://example.com/${"a".repeat(80)}`;
    expect(checkCommitMessage(`${SUBJECT}\n\nSee ${url}\n${"a".repeat(90)}`)).toEqual([]);
  });

  it("reads a pull request description's line endings", () => {
    expect(checkCommitMessage(`${SUBJECT}\r\n\r\n${BODY.replace(/\n/g, "\r\n")}`)).toEqual([]);
  });

  it.each(["fixup! Name the refused host", "squash! x", "Merge branch 'main' into fix/x"])(
    "skips the git-authored subject %s",
    (subject) => {
      expect(checkCommitMessage(subject)).toEqual([]);
    },
  );

  it("does not hold a revert to the subject length", () => {
    expect(checkCommitMessage(`Revert "${"A".repeat(72)}"`)).toEqual([]);
  });

  describe("release", () => {
    it("accepts the version package.json is at", () => {
      expect(checkCommitMessage("🎬 Cut v0.1.2", { version: "0.1.2" })).toEqual([]);
      expect(checkCommitMessage("🎬 Cut v0.1.2 (#12)", { version: "0.1.2" })).toEqual([]);
      expect(checkCommitMessage("🎬 Cut v0.1.2")).toEqual([]);
    });

    it("is the commit that moves the version", () => {
      const moved = { version: "0.1.2", previousVersion: "0.1.1" };
      expect(checkCommitMessage("🎬 Cut v0.1.2", moved)).toEqual([]);
      expect(checkCommitMessage("Bump the version to 0.1.2", moved)).toEqual([
        `package.json moves to v0.1.2 — the subject is "🎬 Cut v0.1.2", with no body`,
      ]);
      const held = { version: "0.1.2", previousVersion: "0.1.2" };
      expect(checkCommitMessage("🎬 Cut v0.1.2", held)).toHaveLength(1);
      expect(checkCommitMessage("Bump nothing", held)).toEqual([]);
    });

    it.each([
      ["another version", "🎬 Cut v0.1.3"],
      ["another subject", "🎬 The second cut"],
      ["a body", "🎬 Cut v0.1.2\n\nThe preview names the refused host."],
    ])("refuses %s", (_name, message) => {
      expect(checkCommitMessage(message, { version: "0.1.2" })).toHaveLength(1);
    });
  });
});

describe("stripGitComments", () => {
  it("drops comment lines and everything under the scissors", () => {
    const file = [
      SUBJECT,
      "",
      "# Please enter the commit message for your changes.",
      "# ------------------------ >8 ------------------------",
      "diff --git a/x b/x",
      "- removed",
    ].join("\n");
    expect(checkCommitMessage(stripGitComments(file))).toEqual([]);
  });
});
