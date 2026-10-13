import { describe, expect, it } from "vitest";
import { KonteError } from "../errors.js";
import { assertPinGate, checkPins, pinWaiverKey, type PinOccurrence } from "../pin-check.js";

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
      ]).active,
    ).toEqual([]);
  });

  it("flags a reference sheet and a plate, naming which each is", () => {
    const active = checkPins([
      pin("video:shot.01.motion", "startImage", "reference:hero"),
      pin("video:shot.02.motion", "endImage", "animatic:plate.kitchen", "end"),
    ]).active;
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
    ]).active;
    expect(active).toHaveLength(1);
    expect(active[0]!.sites.map((s) => s.address)).toEqual([
      "video:shot.01.motion",
      "video:shot.02.motion",
      "video:shot.03.motion",
    ]);
  });

  it("folds a finding its key waives", () => {
    const key = pinWaiverKey("pin-unanchored", "animatic:plate.kitchen");
    const result = checkPins(
      [pin("video:shot.01.motion", "startImage", "animatic:plate.kitchen")],
      { [key]: "the shot opens on the empty room and the cast walks in" },
    );
    expect(result.active).toEqual([]);
    expect(result.waived.map((f) => f.source)).toEqual(["animatic:plate.kitchen"]);
  });

  // An asset name may carry uppercase, so two addresses that differ only in case are two assets.
  it("keys case-sensitively, so one sheet's waiver never cancels another's", () => {
    expect(pinWaiverKey("pin-unanchored", "reference:Hero")).not.toEqual(
      pinWaiverKey("pin-unanchored", "reference:hero"),
    );
    const result = checkPins(
      [
        pin("video:shot.01.motion", "startImage", "reference:hero"),
        pin("video:shot.02.motion", "startImage", "reference:Hero"),
      ],
      { [pinWaiverKey("pin-unanchored", "reference:hero")]: "deliberate" },
    );
    expect(result.active.map((f) => f.source)).toEqual(["reference:Hero"]);
    expect(result.waived.map((f) => f.source)).toEqual(["reference:hero"]);
  });

  it("reports a waiver whose source is no longer pinned, and ignores another class's key", () => {
    const result = checkPins([], {
      [pinWaiverKey("pin-unanchored", "reference:hero")]: "was deliberate",
      "prompt-negation:deadbeef": "the prompt check's",
    });
    expect(result.staleWaivers.map((w) => w.reason)).toEqual(["was deliberate"]);
  });
});

describe("assertPinGate", () => {
  it("passes a stage that pins only frames", () => {
    expect(() =>
      assertPinGate(
        { pins: [pin("video:shot.01.motion", "startImage", "animatic:shot.01.first")] },
        "video.tsx",
      ),
    ).not.toThrow();
  });

  it("aborts with PIN_CHECK_FAILED, naming the key, the source and the site", () => {
    try {
      assertPinGate(
        { pins: [pin("video:shot.01.motion", "startImage", "reference:hero")] },
        "video.tsx",
      );
      expect.unreachable("expected the gate to abort");
    } catch (error) {
      expect(error).toBeInstanceOf(KonteError);
      const konte = error as KonteError;
      expect(konte.code).toBe("PIN_CHECK_FAILED");
      expect(konte.message).toContain(pinWaiverKey("pin-unanchored", "reference:hero"));
      expect(konte.message).toContain("video:shot.01.motion.startImage");
      expect(konte.message).toContain("video.tsx");
    }
  });

  it("says each remedy once for a stage pinning both kinds", () => {
    try {
      assertPinGate(
        {
          pins: [
            pin("video:shot.01.motion", "startImage", "reference:hero"),
            pin("video:shot.02.motion", "startImage", "reference:street"),
            pin("video:shot.03.motion", "endImage", "animatic:plate.kitchen", "end"),
          ],
        },
        "video.tsx",
      );
      expect.unreachable("expected the gate to abort");
    } catch (error) {
      const message = (error as KonteError).message;
      expect(message.match(/a sheet is conditioning/g)).toHaveLength(1);
      expect(message.match(/a plate holds the frame empty/g)).toHaveLength(1);
    }
  });
});
