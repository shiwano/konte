import { describe, expect, it } from "vitest";
import {
  DIRECTION_ROOT_PATH,
  assertValidAddressScope,
  directionChildNodePath,
  directionSectionOf,
  formatDirectionBriefAddress,
  formatDirectionCharacterAddress,
  formatDirectionLocationAddress,
  formatDirectionPolicyAddress,
  formatDirectionPropAddress,
  formatDirectionSequenceAddress,
  formatDirectionShotAddress,
  formatDirectionWaiverAddress,
  getStage,
  parseAddress,
  parseAddressStream,
  parseStageScope,
} from "../address.js";
import { KonteError } from "../errors.js";

describe("direction addressing", () => {
  // Every part is the field path of what it reviews, so an address reads straight back into
  // direction.ts — `sequence.sequences.s1.shots.01` is `direction.sequence.sequences[s1].shots[01]`.
  it("formats the per-part feedback targets", () => {
    const s1 = directionChildNodePath(DIRECTION_ROOT_PATH, "s1");
    expect(formatDirectionSequenceAddress(DIRECTION_ROOT_PATH)).toBe("direction:sequence");
    expect(formatDirectionBriefAddress("logline")).toBe("direction:brief.logline");
    expect(formatDirectionBriefAddress("outOfScope")).toBe("direction:brief.outOfScope");
    expect(formatDirectionPolicyAddress("format")).toBe("direction:policy.format");
    expect(formatDirectionCharacterAddress("alice")).toBe("direction:characters.alice");
    expect(formatDirectionShotAddress(DIRECTION_ROOT_PATH, "01")).toBe(
      "direction:sequence.shots.01",
    );
    expect(formatDirectionSequenceAddress(s1)).toBe("direction:sequence.sequences.s1");
    expect(formatDirectionShotAddress(s1, "01")).toBe("direction:sequence.sequences.s1.shots.01");
    expect(formatDirectionShotAddress(directionChildNodePath(s1, "s2"), "01")).toBe(
      "direction:sequence.sequences.s1.sequences.s2.shots.01",
    );
  });

  // A waiver is declared in the bag of the node whose finding it cancels, so it is addressed there —
  // and its `<code>_<subject>` key is one segment, like every other key in the direction.
  it("formats a waiver at the node that declares it", () => {
    expect(formatDirectionWaiverAddress(DIRECTION_ROOT_PATH, "no-payoff")).toBe(
      "direction:sequence.waivers.no-payoff",
    );
    expect(
      formatDirectionWaiverAddress(
        directionChildNodePath(DIRECTION_ROOT_PATH, "s1"),
        "missing-beat_before",
      ),
    ).toBe("direction:sequence.sequences.s1.waivers.missing-beat_before");
  });

  it("routes a direction address to the direction stream", () => {
    expect(parseAddressStream("direction:sequence.shots.01")).toEqual({ stage: "direction" });
    expect(getStage("direction:sequence")).toBe("direction");
  });

  it("treats a direction address as a feedback-only target, not a full asset address", () => {
    expect(() => parseAddress("direction:sequence")).toThrow(KonteError);
  });

  it("parses the direction stage scope", () => {
    expect(parseStageScope("direction")).toEqual({ stage: "direction" });
    expect(() => parseStageScope("direction@static")).toThrow(KonteError);
  });

  it("accepts direction scopes and rejects malformed parts", () => {
    expect(() => assertValidAddressScope("direction")).not.toThrow();
    expect(() => assertValidAddressScope("direction:sequence")).not.toThrow();
    expect(() => assertValidAddressScope("direction:sequence.shots.01")).not.toThrow();
    expect(() => assertValidAddressScope("direction:sequence.sequences.s1")).not.toThrow();
    expect(() => assertValidAddressScope("direction:sequence.sequences.s1.shots.01")).not.toThrow();
    expect(() =>
      assertValidAddressScope("direction:sequence.waivers.missing-beat_before"),
    ).not.toThrow();
    expect(() => assertValidAddressScope("direction:characters.alice")).not.toThrow();
    expect(() => assertValidAddressScope("direction:props.lantern")).not.toThrow();
    expect(() => assertValidAddressScope("direction:locations.studio")).not.toThrow();
    expect(() => assertValidAddressScope("direction:policy.speech")).not.toThrow();
    expect(() => assertValidAddressScope("direction:bogus")).toThrow(KonteError);
    // The old profile-less parts are gone: a part is a field path or it is not an address.
    expect(() => assertValidAddressScope("direction:spine")).toThrow(KonteError);
    expect(() => assertValidAddressScope("direction:shot.01")).toThrow(KonteError);
    // A policy field is addressed under `policy.`; the bare field name is not an address.
    expect(() => assertValidAddressScope("direction:speech")).toThrow(KonteError);
    expect(() => assertValidAddressScope("direction:sequences.s1")).toThrow(KonteError);
    expect(() => assertValidAddressScope("direction:timeline.x")).toThrow(KonteError);
    expect(() => assertValidAddressScope("direction:")).toThrow(KonteError);
  });

  // The brief is reviewed field by field, so a stray field name is not a silently-accepted scope
  // that no page would ever render.
  it("scopes each brief field, rejecting unknown fields", () => {
    expect(() => assertValidAddressScope("direction:brief.logline")).not.toThrow();
    expect(() => assertValidAddressScope("direction:brief.outOfScope")).not.toThrow();
    expect(() => assertValidAddressScope("direction:brief.tolerances")).not.toThrow();
    expect(() => assertValidAddressScope("direction:brief.bogus")).toThrow(KonteError);
  });

  // A container prefix filters the parts under it — the same separator rule every address-scope
  // follows. It is a scope only: the live part set decides whether anything is actually there.
  it("accepts the container prefix a part hangs off", () => {
    expect(() => assertValidAddressScope("direction:brief")).not.toThrow();
    expect(() => assertValidAddressScope("direction:policy")).not.toThrow();
    expect(() => assertValidAddressScope("direction:characters")).not.toThrow();
    expect(() => assertValidAddressScope("direction:props")).not.toThrow();
    expect(() => assertValidAddressScope("direction:locations")).not.toThrow();
    expect(() => assertValidAddressScope("direction:setups")).not.toThrow();
    expect(() => assertValidAddressScope("direction:sequence.shots")).not.toThrow();
    expect(() => assertValidAddressScope("direction:sequence.waivers")).not.toThrow();
    expect(() => assertValidAddressScope("direction:sequence.sequences.s1.shots")).not.toThrow();
    expect(() => assertValidAddressScope("direction:narrator.voice")).toThrow(KonteError);
  });

  // Every part address routes to exactly one review section box; a location part lands in its own.
  it("routes each part address to its review section", () => {
    expect(directionSectionOf(formatDirectionBriefAddress("logline"))).toBe("brief");
    expect(directionSectionOf(formatDirectionPolicyAddress("format"))).toBe("policy");
    expect(directionSectionOf(formatDirectionCharacterAddress("alice"))).toBe("characters");
    expect(directionSectionOf(formatDirectionPropAddress("lantern"))).toBe("props");
    expect(directionSectionOf(formatDirectionLocationAddress("studio"))).toBe("locations");
    expect(directionSectionOf(formatDirectionShotAddress(DIRECTION_ROOT_PATH, "01"))).toBe("shots");
    expect(directionSectionOf(formatDirectionSequenceAddress(DIRECTION_ROOT_PATH))).toBe("shots");
    expect(directionSectionOf(formatDirectionWaiverAddress(DIRECTION_ROOT_PATH, "no-payoff"))).toBe(
      "waivers",
    );
  });
});
