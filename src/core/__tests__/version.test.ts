import { describe, expect, it } from "vitest";
import { compareVersions, isReleaseVersion } from "../version.js";

describe("compareVersions", () => {
  it("orders dotted numeric versions, ignoring a leading v", () => {
    expect(compareVersions("v0.2.0", "0.1.9")).toBeGreaterThan(0);
    expect(compareVersions("0.1.0", "v0.1.0")).toBe(0);
    expect(compareVersions("0.1", "0.1.0")).toBe(0);
    expect(compareVersions("1.0.0", "0.99.99")).toBeGreaterThan(0);
  });

  it("ranks a pre-release below its release", () => {
    expect(compareVersions("1.0.0-rc.1", "1.0.0")).toBeLessThan(0);
    expect(compareVersions("1.0.0", "1.0.0-rc.1")).toBeGreaterThan(0);
  });

  it("orders pre-release identifiers numerically where numeric", () => {
    expect(compareVersions("1.0.0-rc.10", "1.0.0-rc.2")).toBeGreaterThan(0);
    expect(compareVersions("1.0.0-alpha", "1.0.0-alpha.1")).toBeLessThan(0);
    expect(compareVersions("1.0.0-1", "1.0.0-alpha")).toBeLessThan(0);
    expect(compareVersions("1.0.0-beta", "1.0.0-alpha.9")).toBeGreaterThan(0);
  });

  it("ignores build metadata", () => {
    expect(compareVersions("0.6.0-rc.2+sha.abc", "0.6.0-rc.10")).toBeLessThan(0);
    expect(compareVersions("0.6.0+build.1", "0.6.0")).toBe(0);
  });
});

describe("isReleaseVersion", () => {
  it("accepts X.Y.Z with an optional pre-release suffix", () => {
    expect(isReleaseVersion("0.6.0")).toBe(true);
    expect(isReleaseVersion("v0.6.0-rc.1")).toBe(true);
    expect(isReleaseVersion("0.6.0-rc.1+sha.abc")).toBe(true);
    expect(isReleaseVersion("0.6")).toBe(false);
    expect(isReleaseVersion("garbage")).toBe(false);
    expect(isReleaseVersion("0.6.0-")).toBe(false);
  });
});
