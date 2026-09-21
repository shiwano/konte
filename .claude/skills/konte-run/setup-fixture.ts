#!/usr/bin/env bun
// Builds a konte workspace + video that exercises the review UI's "a fresh reroll sits beside
// the accepted variant" flow — WITHOUT a real backend (generation needs fal/comfy;
// offline we hand-craft state + dummy media instead).
//
// Crafts state for all four previewable stages:
//   - direction     : the fixture video's direction.ts, left UN-accepted so the direction review
//                     exercises the accept gate; a handoff seeds per-part notes.
//   - video         : shot.01.motion with an accepted take (v-old, navy) AND a newer non-accepted
//                     take (v-new, crimson); shots 02/03 each get a single accepted take so the
//                     render plan resolves (video needs every shot ready).
//   - animatic    : each shot's first/last panel gets one accepted image variant so the panels
//                     render (animatic is tolerant — no render plan).
//   - reference     : character.png / reference-clip.mp4 / bgm.mp3 are `file` assets auto-registered
//                     by the file-sync in step 3, so the reference stage previews image + video +
//                     audio. All are ffmpeg-generated in step 2c — the fixture video's
//                     character.png/bgm.mp3 are overwritten so no template media reaches state.
//
// Usage:  bun .claude/skills/konte-run/setup-fixture.ts [workspace-dir] [video-name]
//         (defaults: /tmp/konte-run-fixture/ws, video "main")
// Prints the VIDEO dir — pass it to `konte --cwd <dir> preview …`.
import { $ } from "bun";
import * as path from "node:path";
import * as fs from "node:fs";
import { writeFixtureVideo } from "../../../src/cli/__tests__/fixture-video.js";

const repoRoot = path.resolve(import.meta.dir, "../../..");
const cli = path.join(repoRoot, "src/cli/index.ts");
const workspace = path.resolve(process.argv[2] ?? "/tmp/konte-run-fixture/ws");
const videoName = process.argv[3] ?? "main";
const dest = path.join(workspace, "videos", videoName);

fs.rmSync(workspace, { recursive: true, force: true });

// 1. Scaffold the workspace (config + adapters + tsconfig) and a blank video in it, then write the
//    CLI suite's fixture video over it (direction.ts + animatic.tsx + video.tsx + reference.tsx).
fs.mkdirSync(workspace, { recursive: true });
await $`bun run ${cli} --cwd ${workspace} workspace new`
  .env({
    ...process.env,
    KONTE_FFMPEG_PATH: process.env.KONTE_FFMPEG_PATH ?? "ffmpeg",
    KONTE_FFPROBE_PATH: process.env.KONTE_FFPROBE_PATH ?? "ffprobe",
    KONTE_TSC_PATH: process.env.KONTE_TSC_PATH ?? path.join(repoRoot, "node_modules/.bin/tsc"),
    KONTE_CHROMIUM_PATH: process.env.KONTE_CHROMIUM_PATH ?? "chrome-headless-shell",
    KONTE_CLOUDFLARED_PATH: process.env.KONTE_CLOUDFLARED_PATH ?? "cloudflared",
  })
  .quiet();
await $`bun run ${cli} --cwd ${workspace} video new ${videoName} --template blank`.quiet();
await writeFixtureVideo(dest);

// 2. Enrich the scaffold so the review timeline shows more than a bare motion track:
//    - a per-shot background IMAGE layer (the character art) — an image asset in the video track,
//      stacked above the motion clip;
//    - per-shot narration + sfx audio (each shot owns its own asset), so accepting/un-accepting a
//      shot toggles exactly that shot's audio, mirroring the video track.
const videoPath = path.join(dest, "video.tsx");
fs.writeFileSync(
  videoPath,
  fs
    .readFileSync(videoPath, "utf8")
    // `Audio`/`Image` place a cue/layer; `adapters` provides the file adapters.
    .replace(
      'asset, upscale } from "konte";',
      'asset, upscale, Audio, Image, adapters } from "konte";',
    )
    // Declare the extra assets just above each shot's `return (<Composition>` and layer them in.
    .replace(
      /^( *)return \(\n( *)<Composition>/gm,
      (_m, outer: string, inner: string) =>
        `${outer}const bg = asset("bg", adapters.imageFile, {
${outer}  path: "assets/files/character.png",
${outer}});
${outer}const narration = asset("narration", adapters.audioFile, {
${outer}  path: "assets/files/narration.mp3",
${outer}});
${outer}const sfx = asset("sfx", adapters.audioFile, {
${outer}  path: "assets/files/sfx.mp3",
${outer}});
${outer}return (
${inner}<Composition>
${inner}  <Image
${inner}    src={bg}
${inner}    style={{ position: "absolute", top: "6%", right: "4%", width: "20%", height: "auto" }}
${inner}  />
${inner}  <Audio src={narration} start={0.2} duration={2} volume={0.9} />
${inner}  <Audio src={sfx} start={0.6} duration={0.4} volume={0.7} />`,
    ),
);

// 2b. Add a video reference asset (test material) so the reference review exercises the video card
//     + its click-to-open modal, alongside the image (character) and audio (bgm).
const referencePath = path.join(dest, "reference.tsx");
fs.writeFileSync(
  referencePath,
  fs
    .readFileSync(referencePath, "utf8")
    .replace(
      '  const bgm = asset("bgm", adapters.audioFile, {',
      `  const clip = asset("clip", adapters.videoFile, {
    path: "assets/files/reference-clip.mp4",
  });

  const bgm = asset("bgm", adapters.audioFile, {`,
    )
    .replace("return { character,", "return { character, clip,"),
);

// 2c. Dummy media sources, all ffmpeg-generated so the fixture never relies on the fixture video's
//     media — we OVERWRITE its character.png/bgm.mp3 with synthetic stand-ins
//     and add the per-shot audio + a reference video clip. Generated before step 3 so file-sync
//     registers them.
const files = path.join(dest, "assets/files");
fs.mkdirSync(files, { recursive: true });
const tone = (freq: number, dur: number, out: string) =>
  $`ffmpeg -y -f lavfi -i sine=frequency=${freq}:duration=${dur} -c:a libmp3lame ${path.join(files, out)}`.quiet();
const stillImage = (color: string, out: string) =>
  $`ffmpeg -y -f lavfi -i color=c=${color}:s=512x512:d=1 -frames:v 1 ${path.join(files, out)}`.quiet();
await stillImage("darkslateblue", "character.png"); // reference.character + per-shot bg layer
await tone(220, 4, "bgm.mp3"); // reference bed
await tone(330, 2.5, "narration.mp3");
await tone(880, 0.6, "sfx.mp3");
await $`ffmpeg -y -f lavfi -i color=c=teal:s=320x180:d=2 -pix_fmt yuv420p ${path.join(files, "reference-clip.mp4")}`.quiet();

// 3. Let konte auto-register the `file` assets (character/clip/bgm + the per-shot bg/narration/sfx)
//    into state via file-sync — running any read command does it.
await $`bun run ${cli} --cwd ${dest} status video`.quiet().nothrow();

// 4. Two distinct dummy clips so "which take is shown" is visible at a glance.
fs.mkdirSync(path.join(dest, "media"), { recursive: true });
const lavfi = (color: string, out: string) =>
  $`ffmpeg -y -f lavfi -i color=c=${color}:s=320x180:d=1 -pix_fmt yuv420p ${path.join(dest, "media", out)}`.quiet();
await lavfi("navy", "old.mp4"); // the accepted take
await lavfi("crimson", "new.mp4"); // the fresh reroll

// 5. Splice the generated (comfy) assets into the konte-registered state. Crafted variants are kept
//    non-stale by `definitionHash: null` + empty `inputFingerprints` (staleness only triggers on a
//    non-null recipe hash mismatch or a changed input fingerprint).
const statePath = path.join(dest, "konte.state.json");
const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
const variant = (file: string, status: string, created: string, decided: string | null) => ({
  status,
  file,
  definitionHash: null,
  outputHash: `hash-${file}`,
  createdAt: created,
  readyAt: created,
  decidedAt: decided,
  inputFingerprints: {},
  metadata: {},
});
state.assets["video:shot.01.motion"] = {
  variants: {
    // accepted on 06-20; the reroll is undecided -> surfaces as "new".
    "v-old0001": variant(
      "media/old.mp4",
      "accepted",
      "2026-06-20T00:00:00.000Z",
      "2026-06-20T00:00:00.000Z",
    ),
    "v-new0002": variant("media/new.mp4", "none", "2026-06-25T00:00:00.000Z", null),
  },
};
for (const id of ["02", "03"]) {
  state.assets[`video:shot.${id}.motion`] = {
    variants: {
      [`v-s${id}acc01`]: variant(
        "media/old.mp4",
        "accepted",
        "2026-06-20T00:00:00.000Z",
        "2026-06-20T00:00:00.000Z",
      ),
    },
  };
}

// 5b. Animatic panels: each shot's `first`/`last` panel gets one accepted image variant (a
//     flat-color PNG at the animatic size) so `animatic` previews render. The
//     `latent` timeline asset is not a panel, so it needs none.
const png = (color: string, out: string) =>
  $`ffmpeg -y -f lavfi -i color=c=${color}:s=640x360:d=1 -frames:v 1 ${path.join(dest, "media", out)}`.quiet();
for (const id of ["01", "02", "03"]) {
  for (const name of ["first", "last"] as const) {
    const file = `media/sb-${id}-${name}.png`;
    await png(name === "first" ? "mediumpurple" : "blueviolet", path.basename(file));
    state.assets[`animatic:shot.${id}.${name}`] = {
      variants: {
        [`v-sb${id}${name[0]}`]: variant(
          file,
          "accepted",
          "2026-06-20T00:00:00.000Z",
          "2026-06-20T00:00:00.000Z",
        ),
      },
    };
  }
}

// 5c. file-sync registers every `file` asset undecided. Accept all but the audio (the per-shot
//     narration/sfx and the bgm bed) so the audio track begins needing review — a shot accept then
//     visibly greens only that shot's audio. The bg image layer is accepted.
const AUDIO_RE = /^(video:shot\.\d+\.(narration|sfx)|reference:bgm)$/;
for (const [address, asset] of Object.entries(
  state.assets as Record<string, { variants?: Record<string, VariantLike> }>,
)) {
  if (AUDIO_RE.test(address)) continue;
  for (const v of Object.values(asset.variants ?? {})) {
    if (!v.file?.startsWith("assets/files/")) continue;
    v.status = "accepted";
    v.decidedAt = "2026-06-20T00:00:00.000Z";
  }
}
interface VariantLike {
  file?: string | null;
  status: string;
  decidedAt: string | null;
}

fs.writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`);

// 6. Feedback (human -> AI): lives in the review stream file, NOT in konte.state.json — one
//    `review/<stage>/feedback.json` per stage, keyed by full address.
//    Annotation coords are normalized to the frame (0-1), never pixels.
const writeFeedback = (stage: string, feedback: Record<string, unknown[]>): void => {
  const dir = path.join(dest, "review", stage);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "feedback.json"),
    `${JSON.stringify({ schemaVersion: 1, feedback }, null, 2)}\n`,
  );
};

// Notes on shot 01 (a feedback-only target): one plain timed comment and one pinned one, so both
// the scrub-bar markers and the on-player pin are exercised.
writeFeedback("video", {
  "video:shot.01": [
    {
      id: "fb-demo1",
      text: "Ease the push-in a touch slower here",
      time: 1.2,
      shotTime: 1.2,
      annotation: null,
      displayedVariants: {},
      createdAt: "2026-06-26T00:00:00.000Z",
      createdBy: "local",
    },
    {
      id: "fb-demo2",
      text: "Brighten her expression",
      time: 2.2,
      shotTime: 2.2,
      annotation: { kind: "pin", x: 0.5, y: 0.42 },
      displayedVariants: {},
      createdAt: "2026-06-26T00:00:01.000Z",
      createdBy: "local",
    },
  ],
});

// 7. Handoff (AI -> reviewer guidance): a summary + per-asset notes, loaded from the newest file
//    under review/<stage>/handoffs/. Shown inline per shot/panel/part in the review UI.
//    `address` is the asset path; a direction note addresses a direction part by its
//    field path in direction.ts.
const writeHandoff = (
  stage: string,
  summary: string,
  notes: Array<{ address: string; text: string }>,
): void => {
  const dir = path.join(dest, "review", stage, "handoffs");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "20260626T000000000.json"),
    `${JSON.stringify({ stage, summary, notes }, null, 2)}\n`,
  );
};

writeHandoff(
  "video",
  "Reviewed the latest renders — shots 01 and 02 need a look, audio still pending.",
  [
    {
      address: "video:shot.01.motion",
      text: "Push-in feels fast — a slower reroll may read calmer.",
    },
    {
      address: "video:shot.02.motion",
      text: "Grade runs warm; check it against the character reference.",
    },
    {
      address: "video:shot.03.narration",
      text: "Narration lands a beat late against the motion.",
    },
  ],
);

writeHandoff(
  "animatic",
  "Opening beat is landing; shot 01 framing and shot 02's end pose still need a pass.",
  [
    {
      address: "animatic:shot.01.first",
      text: "Establish her eyeline earlier — she should already be glancing up.",
    },
    {
      address: "animatic:shot.01.last",
      text: "The brighter smile reads well; keep this as the accepted take.",
    },
    {
      address: "animatic:shot.02.first",
      text: "Crop is tight on the desk — leave headroom for the telop later.",
    },
    {
      address: "animatic:shot.03.last",
      text: "End pose is ambiguous; clarify the hand position toward the page.",
    },
  ],
);

writeHandoff(
  "direction",
  "Three shots, ten seconds — please sign off the direction before we spend on animatic.",
  [
    {
      address: "direction:brief.logline",
      text: "Tightened the logline to one promise: idea to finished video.",
    },
    {
      address: "direction:sequence.shots.03",
      text: "The payoff beat: is 3s enough for the reveal to land?",
    },
  ],
);

console.log(dest);
