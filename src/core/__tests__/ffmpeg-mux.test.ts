import { describe, expect, it } from "vitest";
import { buildAudioMixArgs, buildMuxArgs, type MuxAudioTrack } from "../ffmpeg.js";

const track = (over: Partial<MuxAudioTrack> = {}): MuxAudioTrack => ({
  file: "/abs/bgm.mp3",
  start: 0,
  mediaStart: 0,
  duration: 10,
  volume: 1,
  loop: false,
  ...over,
});

const filterGraph = (args: string[]): string => args[args.indexOf("-filter_complex") + 1]!;

describe("buildMuxArgs", () => {
  it("maps video from input 0 only and the mixed audio out, copying video", () => {
    const args = buildMuxArgs("/abs/video.mp4", "/abs/out.mp4", [track()]);
    expect(args.slice(0, 3)).toEqual(["-y", "-i", "/abs/video.mp4"]);
    // video discarded from input 0's audio: only the picture is mapped.
    expect(args).toContain("-map");
    const mapIdx = args.indexOf("-map");
    expect(args[mapIdx + 1]).toBe("0:v");
    expect(args).toContain("[aout]");
    expect(args).toContain("copy"); // -c:v copy
    expect(args.at(-1)).toBe("/abs/out.mp4");
  });

  it("seeks each track with -ss and trims/places it via the filtergraph", () => {
    const args = buildMuxArgs("/v.mp4", "/o.mp4", [
      track({ file: "/a.mp3", start: 3, mediaStart: 5, duration: 4, volume: 0.35 }),
    ]);
    // -ss before -i for a decode-accurate seek.
    expect(args.join(" ")).toContain("-ss 5 -i /a.mp3");
    const fc = args[args.indexOf("-filter_complex") + 1];
    expect(fc).toContain("atrim=0:4");
    expect(fc).toContain("volume=0.35");
    expect(fc).toContain("adelay=3000|3000");
    // clip-prevention limiter, no loudness normalization.
    expect(fc).toContain("alimiter=level=false:limit=0.95");
  });

  it("loops a bed shorter than its span with -stream_loop", () => {
    const args = buildMuxArgs("/v.mp4", "/o.mp4", [track({ loop: true })]);
    expect(args.join(" ")).toContain("-stream_loop -1");
  });

  it("does not loop when loop is false", () => {
    const args = buildMuxArgs("/v.mp4", "/o.mp4", [track({ loop: false })]);
    expect(args).not.toContain("-stream_loop");
  });

  it("sums multiple tracks with amix(normalize=0) before the limiter", () => {
    const args = buildMuxArgs("/v.mp4", "/o.mp4", [
      track({ file: "/a.mp3", start: 0 }),
      track({ file: "/b.mp3", start: 2, volume: 0.5 }),
    ]);
    const fc = args[args.indexOf("-filter_complex") + 1];
    expect(fc).toContain("amix=inputs=2:normalize=0");
    expect(fc).toContain("[a0]");
    expect(fc).toContain("[a1]");
    // two extra inputs beyond the video.
    expect(args.filter((a) => a === "-i")).toHaveLength(3);
  });

  it("plays a track to source end when duration is null (no per-track atrim)", () => {
    const args = buildMuxArgs("/v.mp4", "/o.mp4", [track({ duration: null })]);
    const fc = args[args.indexOf("-filter_complex") + 1];
    // The per-track atrim is absent; the mix is still clamped to the video when a duration is given.
    expect(fc).not.toContain("atrim=0:");
  });

  it("applies afade in/out before adelay, placing the out-fade by duration", () => {
    const args = buildMuxArgs("/v.mp4", "/o.mp4", [
      track({ start: 2, duration: 10, fadeIn: 1, fadeOut: 2 }),
    ]);
    const fc = args[args.indexOf("-filter_complex") + 1]!;
    expect(fc).toContain("afade=t=in:st=0:d=1");
    expect(fc).toContain("afade=t=out:st=8:d=2"); // duration 10 - fadeOut 2
    // fades sit before adelay (operate on the trimmed stream, pre-placement).
    expect(fc.indexOf("afade=t=out")).toBeLessThan(fc.indexOf("adelay="));
  });

  it("skips the out-fade when duration is null (no place to anchor it)", () => {
    const args = buildMuxArgs("/v.mp4", "/o.mp4", [
      track({ duration: null, fadeIn: 1, fadeOut: 2 }),
    ]);
    const fc = args[args.indexOf("-filter_complex") + 1];
    expect(fc).toContain("afade=t=in:st=0:d=1");
    expect(fc).not.toContain("afade=t=out");
  });

  it("clamps the mix to the video duration so a long track can't stretch the file", () => {
    const args = buildMuxArgs("/v.mp4", "/o.mp4", [track({ duration: null })], 10);
    const fc = args[args.indexOf("-filter_complex") + 1];
    expect(fc).toContain("alimiter=level=false:limit=0.95,atrim=0:10[aout]");
    // never -shortest, which could truncate the stream-copied video if audio came out shorter.
    expect(args).not.toContain("-shortest");
  });

  it("omits the clamp when no video duration is provided", () => {
    const args = buildMuxArgs("/v.mp4", "/o.mp4", [track()]);
    const fc = args[args.indexOf("-filter_complex") + 1];
    expect(fc).toContain("alimiter=level=false:limit=0.95[aout]");
  });
});

describe("buildAudioMixArgs", () => {
  it("mixes tracks into an audio-only output (no video, tracks at input 0)", () => {
    const args = buildAudioMixArgs(
      [track({ file: "/a.mp3", start: 0 }), track({ file: "/b.mp3", start: 2, volume: 0.5 })],
      "/out.wav",
    );
    // audio-only: only [aout] is mapped, no 0:v, no -c:v copy.
    expect(args).not.toContain("0:v");
    expect(args).not.toContain("copy");
    const mapIdx = args.indexOf("-map");
    expect(args[mapIdx + 1]).toBe("[aout]");
    const fc = args[args.indexOf("-filter_complex") + 1];
    expect(fc).toContain("[0:a]"); // first track is input 0 (no preceding video)
    expect(fc).toContain("amix=inputs=2:normalize=0");
    expect(fc).toContain("alimiter=level=false:limit=0.95[aout]");
    expect(args.filter((a) => a === "-i")).toHaveLength(2);
    expect(args.at(-1)).toBe("/out.wav");
  });

  // The clamp an animatic stem depends on: exactly `duration`, whichever way the takes fall. `apad`
  // before `atrim` is what makes it hold in both directions — pad a short mix up, cut a long one down.
  it("clamps the mix to `duration` when given one, on one track and on several", () => {
    for (const tracks of [[track()], [track(), track({ file: "/b.mp3", start: 2 })]]) {
      expect(filterGraph(buildAudioMixArgs(tracks, "/o.wav", 4))).toContain(
        "alimiter=level=false:limit=0.95,apad=whole_dur=4,atrim=0:4[aout]",
      );
    }
  });

  it("leaves the mix at its takes' own length when no duration is given", () => {
    const fc = filterGraph(buildAudioMixArgs([track()], "/o.wav"));
    expect(fc).toContain("alimiter=level=false:limit=0.95[aout]");
    expect(fc).not.toContain("apad");
  });

  it("applies per-track trim, fades, and placement", () => {
    const args = buildAudioMixArgs(
      [track({ start: 1, duration: 4, fadeIn: 0.5, fadeOut: 1 })],
      "/o.wav",
    );
    const fc = args[args.indexOf("-filter_complex") + 1];
    expect(fc).toContain("atrim=0:4");
    expect(fc).toContain("afade=t=in:st=0:d=0.5");
    expect(fc).toContain("afade=t=out:st=3:d=1");
    expect(fc).toContain("adelay=1000|1000");
  });
});
