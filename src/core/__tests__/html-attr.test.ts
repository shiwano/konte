import { describe, expect, it } from "vitest";
import { attrOf, numAttr, setAttr, timedElements, toNum } from "../html-attr.js";

describe("attrOf / numAttr", () => {
  const tag = `<video id="v" data-start="1.5" data-duration="" src="/a.mp4">`;

  it("reads an attribute's raw value, null when absent", () => {
    expect(attrOf(tag, "src")).toBe("/a.mp4");
    expect(attrOf(tag, "data-duration")).toBe("");
    expect(attrOf(tag, "data-media-start")).toBeNull();
  });

  it("reads a finite number, null for an empty or absent one", () => {
    expect(numAttr(tag, "data-start")).toBe(1.5);
    expect(numAttr(tag, "data-duration")).toBeNull();
    expect(numAttr(tag, "data-volume")).toBeNull();
    expect(toNum(Infinity)).toBeNull();
    expect(toNum("2")).toBe(2);
  });
});

describe("setAttr", () => {
  it("replaces an attribute where it stands", () => {
    expect(setAttr(`<video data-start="1" src="a">`, "data-start", 0.5)).toBe(
      `<video data-start="0.5" src="a">`,
    );
  });

  it("adds a missing attribute at the tag's end", () => {
    expect(setAttr(`<video src="a">`, "data-media-start", 2)).toBe(
      `<video src="a" data-media-start="2">`,
    );
    expect(setAttr(`<img src="a" />`, "data-start", 0)).toBe(`<img src="a" data-start="0"/>`);
  });
});

describe("timedElements", () => {
  it("lists the opening tags with a numeric data-start, of one element when named", () => {
    const html = `<div data-start="0" data-duration="2"><video data-start="1" src="a"></video><span data-start="x"></span></div>`;

    expect(timedElements(html).map((e) => [e.start, e.duration])).toEqual([
      [0, 2],
      [1, null],
    ]);
    expect(timedElements(html, "video").map((e) => e.tag)).toEqual([
      `<video data-start="1" src="a">`,
    ]);
  });
});
