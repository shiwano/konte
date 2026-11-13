import { describe, expect, it } from "vitest";
import { type Finding, formatFindingBlockLines, formatFindingBlocks } from "../finding.js";

const unpinned = (id: string): Finding => ({
  code: "join-unpinned",
  subject: id,
  key: `join-unpinned_${id}`,
  fixIn: { stage: "direction" },
  message: `shot ${id} pins nothing at its end — pin it to \`animatic:shot.${id}.key\``,
  judgedBy: [`video:shot.${id}#composition`],
});

const action: Finding = {
  code: "multi-sentence-action",
  subject: "01",
  key: "multi-sentence-action_01",
  fixIn: { stage: "direction" },
  message: "shot 01's action is two sentences",
};

describe("formatFindingBlocks", () => {
  it("prints each code's remedy once over its findings", () => {
    const lines = formatFindingBlockLines(
      formatFindingBlocks([unpinned("05"), action, unpinned("28")]),
    );
    expect(lines).toHaveLength(5);
    expect(lines[0]).toMatch(/^join-unpinned ×2 — .*the boundary may jump/);
    expect(lines[1]).toBe(
      "  [join-unpinned_05] shot 05 pins nothing at its end — pin it to `animatic:shot.05.key`",
    );
    expect(lines[2]).toMatch(/^ {2}\[join-unpinned_28\] shot 28/);
    expect(lines[3]).toMatch(/^multi-sentence-action — /);
    expect(lines[4]).toBe("  [multi-sentence-action_01] shot 01's action is two sentences");
  });

  it("omits the count for a lone finding", () => {
    const [head] = formatFindingBlockLines(formatFindingBlocks([unpinned("05")]));
    expect(head).toMatch(/^join-unpinned — /);
  });
});
