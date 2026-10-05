import { describe, expect, it } from "vitest";
import {
  checkDirection,
  directionWaiverKey,
  type SongTakeState,
  validateDirectionStructure,
} from "../direction.js";
import { directionPartHashes } from "../direction-hash.js";
import { directionPartContents } from "../direction-parts.js";
import type { Direction, LyricLine, NarrativeShot } from "../dsl/direction.js";
import { placeDirectionLyrics } from "../dsl/direction.js";
import { setSongFirstBeat, setSongLine, setSongLines } from "../song-take.js";
import { steadySong } from "./helpers/song.js";
import { directionDefaults } from "./helpers/direction.js";
import { suggestForStatus } from "../suggested-actions.js";

const beatShot = (id: string, role: string, beats: number): NarrativeShot => ({
  id,
  role,
  action: "a",
  setup: "front",
  beats,
  lineup: [],
});

function clocked(shots: NarrativeShot[], waivers?: Record<string, string>): Direction {
  return {
    ...directionDefaults,
    policy: { ...directionDefaults.policy, song: "song" },
    sequence: {
      lens: "mini-drama",
      pleasure: "cute",
      shots,
      ...(waivers ? { waivers } : {}),
    },
  } as Direction;
}

const arc = (disruptionBeats = 8) => [
  beatShot("01", "ordinary", 8),
  beatShot("02", "disruption", disruptionBeats),
  beatShot("03", "pressure", 8),
  beatShot("04", "hero", 8),
];

const codes = (direction: Direction, referenceAssetNames?: readonly string[]) =>
  checkDirection(
    direction,
    referenceAssetNames ? { referenceAssetNames, songTake: { take: null, durationSec: null } } : {},
  ).active.map((f) => f.code);

describe("the song", () => {
  it("flags a song no reference asset holds", () => {
    expect(codes(clocked(arc()), [])).toContain("song-unreferenced");
    expect(codes(clocked(arc()), ["song"])).not.toContain("song-unreferenced");
  });

  it("flags a span that is not a positive whole number of beats", () => {
    const result = checkDirection(clocked(arc(1.5)));
    expect(result.active.find((f) => f.code === "off-grid-duration")?.subject).toBe("02");
    expect(codes(clocked(arc(0)))).toContain("off-grid-duration");
  });

  it("lets a half-beat cut through with a waiver", () => {
    const result = checkDirection(clocked(arc(1.5), { "off-grid-duration_02": "a pickup" }));
    expect(result.waived.map(directionWaiverKey)).toContain("off-grid-duration_02");
  });

  it("refuses a shot whose span is not the one the policy counts in", () => {
    const withDuration = clocked([
      beatShot("01", "ordinary", 8),
      { ...beatShot("02", "hero", 8), beats: undefined, duration: 4 } as NarrativeShot,
    ]);
    expect(
      validateDirectionStructure(withDuration)
        .filter((e) => e.code === "shot-span-mismatch")
        .map((e) => e.subject),
    ).toEqual(["02"]);

    const beatsWithoutClock = {
      ...clocked(arc()),
      policy: directionDefaults.policy,
    } as Direction;
    expect(validateDirectionStructure(beatsWithoutClock).map((e) => e.code)).toContain(
      "shot-span-mismatch",
    );
  });

  it("weighs the arc in beats", () => {
    const weighted = (ordinaryBeats: number) =>
      clocked([
        beatShot("01", "ordinary", ordinaryBeats),
        beatShot("02", "disruption", 8),
        beatShot("03", "pressure", 8),
        beatShot("04", "hero", 8),
      ]);
    // The opening holds 64 of 88 beats — past the 40% a mini-drama gives it.
    expect(codes(weighted(64))).toContain("role-overweight");
    expect(codes(weighted(8))).not.toContain("role-overweight");
  });

  it("reports only the empty direction while the shots are unwritten", () => {
    const empty = clocked([]);
    expect(validateDirectionStructure(empty).map((e) => e.code)).toContain("empty-direction");
    expect(checkDirection(empty).active.filter((f) => f.path !== undefined)).toEqual([]);
  });

  it("is a policy part of its own, present only when declared", () => {
    const hashes = directionPartHashes(clocked(arc()));
    expect(hashes.has("direction:policy.song")).toBe(true);
    expect(
      directionPartHashes({ ...clocked(arc()), policy: directionDefaults.policy }).has(
        "direction:policy.song",
      ),
    ).toBe(false);

    const renamed = directionPartHashes({
      ...clocked(arc()),
      policy: { ...directionDefaults.policy, song: "tune" },
    } as Direction);
    expect(renamed.get("direction:policy.song")).not.toBe(hashes.get("direction:policy.song"));
    expect(renamed.get("direction:sequence.shots.01")).toBe(
      hashes.get("direction:sequence.shots.01"),
    );
  });

  it("shows a shot's beats, and no seconds while no take of the song is read", () => {
    expect(directionPartContents(clocked(arc())).get("direction:sequence.shots.02")).toMatchObject({
      duration: null,
      beats: 8,
    });
  });
});

describe("Next steps before the song", () => {
  const state = { assets: {} } as Parameters<typeof suggestForStatus>[0]["state"];

  it("makes the song, then writes the shots in beats", () => {
    const actions = suggestForStatus({
      state,
      directionReviewNeeded: true,
      directionEmpty: true,
      songPending: { address: "reference:song", hasTake: false, directionReviewNeeded: false },
    });
    expect(actions[0]).toMatchObject({ command: "konte generate reference" });
    expect(actions[1]!.details?.[0]).toMatch(/counted in beats, once reference:song is accepted/);
  });

  it("reviews the brief, policy and lyrics before the song is made", () => {
    const actions = suggestForStatus({
      state,
      directionReviewNeeded: true,
      directionEmpty: true,
      songPending: { address: "reference:song", hasTake: false, directionReviewNeeded: true },
    });
    expect(actions[0]).toMatchObject({ command: "konte preview direction" });
  });

  it("sends a song already taken to its review", () => {
    const actions = suggestForStatus({
      state,
      directionReviewNeeded: true,
      directionEmpty: true,
      songPending: { address: "reference:song", hasTake: true, directionReviewNeeded: false },
    });
    expect(actions[0]).toMatchObject({ command: "konte preview reference" });
  });

  it("reads a take no job is reading before its review", () => {
    const actions = suggestForStatus({
      state,
      directionReviewNeeded: true,
      directionEmpty: true,
      songPending: { address: "reference:song", hasTake: true, directionReviewNeeded: false },
      songUnread: true,
    });
    expect(actions.map((a) => a.command).slice(0, 2)).toEqual([
      "konte song analyze",
      "konte preview reference",
    ]);
  });
});

describe("the song take", () => {
  const take = (bpm: number, phrases: [number, number][] | null = []): SongTakeState => ({
    take: {
      address: "reference:song",
      variantId: "v-song",
      analysis: steadySong({
        bpm,
        beat0Sec: 0.5,
        phrases: phrases?.map(([startSec, endSec]) => ({ startSec, endSec })) ?? null,
      }),
    },
    durationSec: null,
  });
  const check = (direction: Direction, song: SongTakeState) =>
    checkDirection(direction, { referenceAssetNames: ["song"], songTake: song }).active;

  it("flags a timeline that runs past the end of the take, on a stage pass", () => {
    // 32 beats at 120 BPM after a 0.5s lead end the timeline at 16.5s.
    const overrun = (durationSec: number) =>
      checkDirection(clocked(arc()), {
        realizedIds: ["01", "02", "03", "04"],
        referenceAssetNames: ["song"],
        songTake: { ...take(120), durationSec },
      }).active.map((f) => f.code);
    expect(overrun(16.5)).not.toContain("song-overrun");
    expect(overrun(16)).toContain("song-overrun");
    expect(
      check(clocked(arc()), { ...take(120), durationSec: 16 }).map((f) => f.code),
    ).not.toContain("song-overrun");
  });

  const singers = {
    konte: { name: "Konte", promptDepiction: "girl", description: "the singer" },
    mika: { name: "Mika", promptDepiction: "woman", description: "the second singer" },
  };
  const withLyrics = (lines: LyricLine[]): Direction =>
    ({
      ...clocked(arc()),
      characters: singers,
      lyrics: [{ label: "chorus", singer: "konte", lines }],
    }) as Direction;
  const withSet = (
    base: SongTakeState,
    lines: Record<string, { text: string; startSec: number; endSec: number }>,
  ): SongTakeState => ({
    take: {
      ...base.take!,
      analysis: {
        ...base.take!.analysis,
        lines,
      },
    },
    durationSec: base.durationSec,
  });

  it("flags a line no reading of the take places, by its place in the sections", () => {
    const findings = check(withLyrics(["Hit the light", "Watch me move"]), take(120, null));
    expect(findings.filter((f) => f.code === "lyric-unplaced").map(directionWaiverKey)).toEqual([
      "lyric-unplaced_1.1",
      "lyric-unplaced_1.2",
    ]);
  });

  it("takes a line a person placed on the take as placed, while its words stand", () => {
    const direction = withLyrics(["Hit the light", "Watch me move"]);
    const placed = withSet(take(120, null), {
      "1.1": { text: "Hit the light", startSec: 0.5, endSec: 2 },
      "1.2": { text: "Watch me groove", startSec: 2.5, endSec: 4 },
    });
    expect(
      check(direction, placed)
        .filter((f) => f.code === "lyric-unplaced")
        .map(directionWaiverKey),
    ).toEqual(["lyric-unplaced_1.2"]);
    const [line] = placeDirectionLyrics(direction, placed.take);
    expect(line).toMatchObject({ start: 0.5, end: 2, set: true });
  });

  it("gives each line the singers of its section, or its own", () => {
    const direction = {
      ...withLyrics([]),
      lyrics: [
        { label: "verse", singer: "konte", lines: ["a", { text: "b", singer: "mika" }] },
        { label: "chorus", singer: ["konte", "mika"], lines: ["c"] },
      ],
    } as Direction;
    const placed = withSet(take(120, null), {
      "1.1": { text: "a", startSec: 0.5, endSec: 1 },
      "1.2": { text: "b", startSec: 1.5, endSec: 2 },
      "2.1": { text: "c", startSec: 2.5, endSec: 3 },
    });
    expect(placeDirectionLyrics(direction, placed.take).map((l) => l.singer)).toEqual([
      ["konte"],
      ["mika"],
      ["konte", "mika"],
    ]);
  });

  it("refuses lyrics nobody declared can sing, sung by nobody, or with no song", () => {
    const codes = (direction: Direction) =>
      validateDirectionStructure(direction).map((e) => e.code);
    expect(codes(withLyrics([{ text: "a", singer: "nobody" }]))).toContain("lyrics-singer-unknown");
    expect(
      codes({
        ...withLyrics([]),
        lyrics: [{ label: "verse", singer: [], lines: ["a"] }],
      } as unknown as Direction),
    ).toContain("lyrics-singer-empty");
    expect(
      codes({ ...withLyrics(["a"]), policy: directionDefaults.policy } as Direction),
    ).toContain("lyrics-without-song");
    expect(codes(withLyrics([" "]))).toContain("lyrics-empty-line");
  });

  it("is one part of its own, which every singer counts as using a character", () => {
    const direction = withLyrics(["Hit the light", { text: "Watch me move", singer: "mika" }]);
    expect(directionPartHashes(direction).has("direction:lyrics")).toBe(true);
    expect(
      checkDirection(direction, {
        referenceAssetNames: ["song", "konte", "mika"],
        songTake: take(120),
      }).active.map((f) => f.code),
    ).not.toContain("unused-character");
  });
});

describe("a lyric line placed on a take by hand", () => {
  const record = { reading: "r1", lang: "en" };
  const lines = [
    { key: "1.1", text: "a" },
    { key: "1.2", text: "b" },
    { key: "1.3", text: "c" },
  ];

  it("judges lines placed together on the order they leave together", () => {
    let set = setSongLine(record, lines, "1.1", { startSec: 1, endSec: 2 }, 30);
    set = setSongLine(set, lines, "1.2", { startSec: 4, endSec: 5 }, 30);
    const moved = setSongLines(
      set,
      lines,
      [
        { key: "1.1", span: { startSec: 6, endSec: 7 } },
        { key: "1.2", span: { startSec: 9, endSec: 10 } },
      ],
      30,
    );
    expect(moved.lines?.["1.1"]?.startSec).toBe(6);
    expect(moved.lines?.["1.2"]?.startSec).toBe(9);
  });

  it("keeps the words it was placed as, and is left to the reading again when unset", () => {
    const set = setSongLine(record, lines, "1.2", { startSec: 4, endSec: 6 }, 30);
    expect(set.lines?.["1.2"]).toMatchObject({ text: "b", startSec: 4, endSec: 6 });
    expect(setSongLine(set, lines, "1.2", null, 30)).not.toHaveProperty("lines");
  });

  it("opens in the order the lines are sung, inside the take", () => {
    const set = setSongLine(record, lines, "1.2", { startSec: 4, endSec: 6 }, 30);
    expect(() => setSongLine(set, lines, "1.1", { startSec: 5, endSec: 7 }, 30)).toThrow(
      /before line 1\.2|after line 1\.2/,
    );
    expect(() => setSongLine(set, lines, "1.3", { startSec: 3, endSec: 5 }, 30)).toThrow(
      /line 1\.2/,
    );
    // A call-and-response line may open before the line it answers has ended.
    expect(
      setSongLine(set, lines, "1.3", { startSec: 5, endSec: 8 }, 30).lines?.["1.3"],
    ).toBeTruthy();
    expect(() => setSongLine(record, lines, "1.1", { startSec: 2, endSec: 31 }, 30)).toThrow();
    expect(() => setSongLine(record, lines, "9.9", { startSec: 2, endSec: 3 }, 30)).toThrow(
      /line 9\.9: direction\.ts declares no such lyric line/,
    );
  });
});

describe("beat 0 set on a take by hand", () => {
  const record = { reading: "r1", lang: "en" };
  const reading = { beats: [0.5, 1, 1.5, 2], firstBeat: 0, beatsPerBar: 4 };

  it("is the read beat nearest the second a person sets", () => {
    expect(setSongFirstBeat(record, reading, 1.6)).toEqual({ ...record, firstBeatSet: 1.5 });
  });

  it("is left to the reading again when unset", () => {
    expect(setSongFirstBeat(setSongFirstBeat(record, reading, 1), reading, null)).toEqual(record);
  });
});
