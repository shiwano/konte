import { describe, expect, it } from "vitest";
import { checkPins, pinFindings, type PinOccurrence } from "../pin-check.js";

function pin(address: string, input: string, source: string, end: "start" | "end" = "start") {
  return { address, input, pin: end, source } satisfies PinOccurrence;
}

describe("checkPins", () => {
  it("passes a board panel, a seam frame and a local file", () => {
    expect(
      checkPins([
        pin("video:shot.01.motion", "startImage", "animatic:shot.01.first"),
        pin("video:shot.01.motionB", "startImage", "video:shot.01.seam"),
        pin("video:shot.02.motion", "endImage", "animatic:shot.02#composition", "end"),
        pin("video:shot.03.motion", "startImage", "assets/plate.png"),
      ]),
    ).toEqual([]);
  });

  it("flags a reference sheet and a plate, naming which each is", () => {
    const active = checkPins([
      pin("video:shot.01.motion", "startImage", "reference:hero"),
      pin("video:shot.02.motion", "endImage", "animatic:plate.kitchen", "end"),
    ]);
    expect(active.map((f) => [f.source, f.subject])).toEqual([
      ["reference:hero", "sheet"],
      ["animatic:plate.kitchen", "plate"],
    ]);
  });

  it("keys on the pinned source, so one sheet across many shots is one finding", () => {
    const active = checkPins([
      pin("video:shot.01.motion", "startImage", "reference:hero"),
      pin("video:shot.02.motion", "startImage", "reference:hero"),
      pin("video:shot.03.motion", "endImage", "reference:hero", "end"),
    ]);
    expect(active).toHaveLength(1);
    expect(active[0]!.sites.map((s) => s.address)).toEqual([
      "video:shot.01.motion",
      "video:shot.02.motion",
      "video:shot.03.motion",
    ]);
  });

  // An asset name may carry uppercase, so two addresses that differ only in case are two assets.
  it("keeps two sources apart that differ only in case", () => {
    const active = checkPins([
      pin("video:shot.01.motion", "startImage", "reference:hero"),
      pin("video:shot.02.motion", "startImage", "reference:Hero"),
    ]);
    expect(active.map((f) => f.source)).toEqual(["reference:hero", "reference:Hero"]);
  });
});

describe("pinFindings", () => {
  it("reports nothing for a stage that pins only frames", () => {
    expect(
      pinFindings(
        { pins: [pin("video:shot.01.motion", "startImage", "animatic:shot.01.first")] },
        { stage: "video" },
      ),
    ).toEqual([]);
  });

  it("names the source, the site and the remedy", () => {
    const [finding] = pinFindings(
      { pins: [pin("video:shot.01.motion", "startImage", "reference:hero")] },
      { stage: "video" },
    );
    expect(finding).toMatchObject({
      code: "pin-unanchored",
      subject: "reference:hero",
      fixIn: { stage: "video" },
      targets: ["video:shot.01.motion"],
    });
    expect(finding!.message).toContain("video:shot.01.motion.startImage");
    expect(finding!.message).toContain("a sheet is conditioning");
  });

  it("gives a plate its own remedy", () => {
    const [finding] = pinFindings(
      { pins: [pin("video:shot.03.motion", "endImage", "animatic:plate.kitchen", "end")] },
      { stage: "video" },
    );
    expect(finding!.message).toContain("a plate holds the frame empty");
  });
});
