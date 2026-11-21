import { describe, expect, it } from "vitest";
import { keptViaMarker, parseKeptVia } from "../kept-via.js";

describe("kept-via", () => {
  it("round-trips upstreams in address order", () => {
    const marker = keptViaMarker({ "reference:b": "h2", "animatic:plate.a": "h1" });
    expect(marker).toBe("via:animatic:plate.a=h1,reference:b=h2");
    expect(parseKeptVia(marker)).toEqual({ "animatic:plate.a": "h1", "reference:b": "h2" });
  });

  it("reads a plain hash as no marker", () => {
    expect(parseKeptVia("abc123")).toBeNull();
  });

  it("reads a marker with a broken pair as no marker", () => {
    expect(parseKeptVia("via:reference:a=h1,broken")).toBeNull();
  });
});
