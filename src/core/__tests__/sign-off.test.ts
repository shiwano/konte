import { describe, expect, it } from "vitest";
import { acceptedIn } from "../board-analysis.js";
import { signOffFinding } from "../checks.js";
import type { Finding } from "../finding.js";
import { signedOffBy } from "../sign-off.js";
import type { StateManager } from "../state/index.js";
import type { AnimaticDefinition } from "../types/index.js";

const finding = (addresses: string[]): Finding => ({
  code: "prompt-negation",
  subject: '"no outlines"',
  fixIn: { stage: "video" },
  message: addresses.join(", "),
  targets: addresses,
  judgedBy: addresses,
});

describe("signOffFinding", () => {
  const both = ["video:shot.01.motion", "video:shot.02.motion"];

  it("moves an accepted address out of what the finding sits on", () => {
    const f = signOffFinding(finding(both), (a) => a === "video:shot.01.motion");
    expect(f).toMatchObject({
      targets: ["video:shot.02.motion"],
      signedOff: ["video:shot.01.motion"],
    });
    expect(f.message).toBe(
      "video:shot.01.motion, video:shot.02.motion — awaiting accept: video:shot.02.motion",
    );
  });

  it("sits on nothing once every address is accepted", () => {
    const f = signOffFinding(finding(both), () => true);
    expect(f).toMatchObject({ targets: [], signedOff: both });
    expect(f.message).toContain("accepted as drawn; fix it before drawing it again");
  });
});

describe("signedOffBy", () => {
  it("signs off nothing a finding names no address for", () => {
    expect(signedOffBy([], () => true)).toBe(false);
  });
});

describe("acceptedIn", () => {
  it("counts no accept of an undeveloped shot's composition", () => {
    const manager = { acceptedAsDefined: () => true } as unknown as StateManager;
    const animatic = { shots: [{ id: "01", pending: true }] } as unknown as AnimaticDefinition;
    expect(acceptedIn(manager, { animatic })("animatic:shot.01#composition")).toBe(false);
  });
});

describe("judgedBy", () => {
  it("is required of a code an accept signs off, and refused elsewhere", () => {
    const fields = { subject: "", fixIn: { stage: "direction" as const }, message: "" };
    // @ts-expect-error return-unlinked is signed off by an accept, so it names what judges it
    const missing: Finding = { ...fields, code: "return-unlinked" };
    // @ts-expect-error unused-setup is signed off by no accept
    const extra: Finding = { ...fields, code: "unused-setup", judgedBy: [] };
    expect([missing, extra]).toHaveLength(2);
  });
});
