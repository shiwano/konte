import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import {
  offeredSubtitleTracks,
  parseVtt,
  pickSubtitleTrack,
  readClipSubtitle,
} from "../clip-sidecars.js";

describe("pickSubtitleTrack", () => {
  const tracks = [
    { key: "de", auto: false },
    { key: "en", auto: false },
    { key: "en-orig", auto: true },
  ];

  it("takes a human's track in the clip's language over an auto-generated one", () => {
    expect(pickSubtitleTrack(tracks, "en")).toEqual({ key: "en", auto: false });
    expect(pickSubtitleTrack(tracks, "en-US")).toEqual({ key: "en", auto: false });
  });

  it("falls back to the auto-generated track", () => {
    expect(pickSubtitleTrack([{ key: "ko-orig", auto: true }], "ko")).toEqual({
      key: "ko-orig",
      auto: true,
    });
  });

  it("takes no translation into another language", () => {
    expect(pickSubtitleTrack(tracks, "ja")).toBeNull();
  });

  it("takes the one language there is where the clip's is unknown", () => {
    expect(pickSubtitleTrack([{ key: "fr", auto: false }], null)).toEqual({
      key: "fr",
      auto: false,
    });
    expect(pickSubtitleTrack(tracks, null)).toBeNull();
  });
});

describe("offeredSubtitleTracks", () => {
  it("offers every human track and the auto-generated one in the clip's language", () => {
    expect(
      offeredSubtitleTracks({
        subtitles: { en: [], live_chat: [] },
        automatic_captions: { ko: [], "ko-orig": [], fr: [] },
      }),
    ).toEqual([
      { key: "en", auto: false },
      { key: "ko-orig", auto: true },
    ]);
  });
});

describe("parseVtt", () => {
  it("reads each cue's lines as one, tags and entities resolved", () => {
    const vtt = [
      "WEBVTT",
      "Kind: captions",
      "",
      "00:00:22.640 --> 00:00:26.960",
      "♪ You know the rules",
      "and so do I &amp; you ♪",
      "",
      "01:02.000 --> 01:03.000",
      "<c.yellow>Never</c> gonna",
      "",
    ].join("\n");
    expect(parseVtt(vtt, false)).toEqual([
      { startSec: 22.64, text: "♪ You know the rules and so do I & you ♪" },
      { startSec: 62, text: "Never gonna" },
    ]);
  });

  it("keeps a line said again in its own cue", () => {
    const vtt = [
      "WEBVTT",
      "",
      "00:00:01.000 --> 00:00:02.000",
      "Hello",
      "",
      "00:00:10.000 --> 00:00:11.000",
      "Hello",
      "",
    ].join("\n");
    expect(parseVtt(vtt, false)).toEqual([
      { startSec: 1, text: "Hello" },
      { startSec: 10, text: "Hello" },
    ]);
  });

  it("drops the line a rolling track repeats", () => {
    const vtt = [
      "WEBVTT",
      "",
      "00:00:18.680 --> 00:00:22.670 align:start position:0%",
      " ",
      "낮에는<00:00:19.320><c> 커피</c>",
      "",
      "00:00:22.670 --> 00:00:22.680 align:start position:0%",
      "낮에는 커피",
      " ",
      "",
      "00:00:22.680 --> 00:00:25.710 align:start position:0%",
      "낮에는 커피",
      "잔에<00:00:23.160><c> 여유를</c>",
      "",
    ].join("\n");
    expect(parseVtt(vtt, true)).toEqual([
      { startSec: 18.68, text: "낮에는 커피" },
      { startSec: 22.68, text: "잔에 여유를" },
    ]);
  });
});

describe("readClipSubtitle", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(tmpdir(), "konte-clip-sidecars-"));
  });

  const cue = (text: string) => `WEBVTT\n\n00:00:01.000 --> 00:00:02.000\n${text}\n`;

  it("reads the track in the study directory that fits the clip's language", async () => {
    await fs.writeFile(path.join(dir, "ko-orig.vtt"), cue("auto"));
    await fs.writeFile(path.join(dir, "ko.vtt"), cue("human"));
    await fs.writeFile(path.join(dir, "heard.txt"), "");
    expect(readClipSubtitle(dir, "ko")).toEqual({
      lang: "ko",
      auto: false,
      cues: [{ startSec: 1, text: "human" }],
    });
  });

  it("is null where the study directory holds no track", () => {
    expect(readClipSubtitle(dir, "ko")).toBeNull();
  });
});
