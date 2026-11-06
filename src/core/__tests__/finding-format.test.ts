import { describe, expect, it } from "vitest";
import { type Finding, formatFindingBlockLines, formatFindingBlocks } from "../finding.js";

const unlinked = (from: string, id: string): Finding => ({
  code: "return-unlinked",
  subject: `${from}-${id}`,
  key: `return-unlinked_${from}-${id}`,
  fixIn: { stage: "direction" },
  message: `shot ${id}'s opening keyframe takes no frame — pass \`animatic:shot.${from}.key\``,
  judgedBy: [`animatic:shot.${id}.key`],
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
      formatFindingBlocks([unlinked("03", "05"), action, unlinked("25", "28")]),
    );
    expect(lines).toHaveLength(5);
    expect(lines[0]).toMatch(/^return-unlinked ×2 — .*`jump-forward`/);
    expect(lines[1]).toBe(
      "  [return-unlinked_03-05] shot 05's opening keyframe takes no frame — pass `animatic:shot.03.key`",
    );
    expect(lines[2]).toMatch(/^ {2}\[return-unlinked_25-28\] shot 28/);
    expect(lines[3]).toMatch(/^multi-sentence-action — /);
    expect(lines[4]).toBe("  [multi-sentence-action_01] shot 01's action is two sentences");
  });

  it("omits the count for a lone finding", () => {
    const [head] = formatFindingBlockLines(formatFindingBlocks([unlinked("03", "05")]));
    expect(head).toMatch(/^return-unlinked — /);
  });
});
