# konte

[![Tag](https://img.shields.io/github/tag/shiwano/konte.svg)](https://github.com/shiwano/konte/releases)
[![Build Status](https://github.com/shiwano/konte/actions/workflows/ci.yml/badge.svg)](https://github.com/shiwano/konte/actions/workflows/ci.yml)

**You direct. Your agent produces.**

konte treats the video as a software project, so Claude Code or Codex can run the production end to end. The agent plans the shots, drives generation, tracks every take, and carries your feedback into the next round. You discuss the idea, review the cut in your browser, and decide what changes.

https://github.com/user-attachments/assets/6e47740c-b12b-4a7e-aa88-8df246534436

<sup>Project files for this video: [konte-demo-video](https://github.com/shiwano/konte-demo-video/tree/main/videos/readme-hero).</sup>

> **Early technical preview.** Expect rough edges and breaking changes. See [Status](#status).

## Why

AI made a single clip easy. A video gets harder with every shot you add: the shots have to agree with each other, each one is generated many times, takes have to be picked, and one change ripples into its neighbors. Those are production management problems, the kind software engineering already knows how to solve.

So konte structures the video as a software project: the direction, the shots, every take, which one won, what depends on what, and your feedback. A coding agent already works in that shape, so it can carry your idea to a finished video while you direct.

The longer argument is in [Vision](docs/VISION.md).

## How you use it

After setup, start a session with one skill:

```
> /konte-checkin   # Codex: $konte-checkin, Muse: /konte
```

The agent helps you develop a new idea or picks up an existing project where you left off, then proposes the next step.

1. **Plan.** Discuss your idea with the agent and accept the shot plan.
2. **Review shared assets.** Accept the characters, locations, and other references.
3. **Review the cut.** The agent builds a timed storyboard, then video, one sequence at a time.
4. **Revise.** Choose takes and leave comments; the agent makes the changes.
5. **Export.** When you accept the cut, the agent renders the MP4.

https://github.com/user-attachments/assets/465819b3-bd07-4ca8-901e-bb942a0d5cd1

<sup>Project files for this video: [konte-demo-video](https://github.com/shiwano/konte-demo-video/tree/main/videos/how-you-use-it).</sup>

## Quick start

**Requirements:** Claude Code, Codex or Muse, plus a [generation backend](#backends) for AI generation. Supports macOS, Linux, and Windows (including WSL). konte needs no Node.js, Python, or other runtime installation.

Create a workspace directory, then install the plugin, run setup in a chat opened there, and check in (`$` = terminal, `>` = agent chat).

### Claude Code

**1. Install** from the terminal:

```
$ claude plugin marketplace add shiwano/konte@plugin
$ claude plugin install konte@konte
```

Or in the desktop app, open **Settings → Plugins → Add marketplace → Add from a repository**, enter `shiwano/konte@plugin` as **URL**, and install **konte**.

**2. Set up** in a new chat in your workspace, then start a new chat as setup instructs:

```
> /konte:setup
```

**3. Check in** in that new chat:

```
> /konte-checkin
```

https://github.com/user-attachments/assets/18882070-7814-4f83-9862-200e86a9eb84

<sup>Project files for this video: [konte-demo-video](https://github.com/shiwano/konte-demo-video/tree/main/videos/claude-code-desktop-setup).</sup>

### Codex

**1. Install** from the terminal:

```
$ codex plugin marketplace add shiwano/konte@plugin
$ codex plugin add konte@konte
```

Or in the desktop app, open **Settings → Plugins → Add plugin marketplace**, then:

- **Source**: `shiwano/konte`
- **Git ref**: `origin/plugin`
- **Sparse paths**: leave empty

Install **konte** from the added marketplace.

**2. Set up** in a new chat in your workspace, then start a new chat as setup instructs:

```
> $konte:setup
```

**3. Check in** in that new chat:

```
> $konte-checkin
```

https://github.com/user-attachments/assets/8c183e5c-3878-4497-ab82-fcb3466faae1

<sup>Project files for this video: [konte-demo-video](https://github.com/shiwano/konte-demo-video/tree/main/videos/codex-desktop-setup).</sup>

### Muse (experimental)

**1. Install the skills** in your main chat:

```
> Save these as skills in ~/workspace/custom-skills/:
  https://raw.githubusercontent.com/shiwano/konte/main/integrations/muse/konte/SKILL.md
  https://raw.githubusercontent.com/shiwano/konte/main/integrations/muse/konte-setup/SKILL.md
```

**2. Set up** a workspace, `~/konte-workspaces/main` (`/konte-setup <name>` for another):

```
> /konte-setup
```

**3. Check in** in the same chat:

```
> /konte
```

### Uninstall

Close agent sessions using konte, delete your workspace directories, then remove the **konte** plugin and its marketplace (on Muse, the `konte` and `konte-setup` skills in `~/workspace/custom-skills/`). konte writes nothing outside a workspace.

## Backends

You can mix backends in one project. The agent opens settings when needed and guides you through entering API keys or connection details.

| If you…                         | Backend                                 | Setup                                                                                                                                                                                                                                               |
| ------------------------------- | --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| have a capable GPU, or rent one | [ComfyUI](https://comfy.org/download)   | Requires ComfyUI-Manager. konte installs models and nodes; plan on 16 GB of VRAM (24 GB is comfortable) and tens of gigabytes of first-run downloads. Run locally or on a GPU host such as [RunPod](https://docs.runpod.io/tutorials/pods/comfyui). |
| have no capable GPU             | [Comfy API](https://platform.comfy.org) | Requires an API key; paid per generation. Comfy Cloud, the managed deployment, runs workflows whose nodes and models it already has, which konte checks. For any other workflow, the agent guides you through creating your own deployment.         |
| want a closed model             | [fal.ai](https://fal.ai/)               | Requires an API key; paid per generation. Adds models no ComfyUI can host, such as MiniMax H3 Max, Seedance, and Nano Banana.                                                                                                                       |

Want a backend or model konte doesn't support yet? [Let us know](https://github.com/shiwano/konte/issues/new?template=support.yml).

### Bring your own ComfyUI workflow

Give your agent a workflow saved from ComfyUI:

```
> /konte-comfy-workflow ~/Downloads/my-workflow.json   # Codex: $konte-comfy-workflow
```

The agent creates an adapter with typed inputs, dependencies, and a prompting guide. No API-format export is needed.

## Features

### Agent tooling

- **Checks before spending.** konte runs more than 150 [checks](docs/FINDINGS.md) on the shot plan, prompts, and takes. It holds generation or review until each finding is fixed or signed off.
- **Independent critics.** Separate subagents review the shot plan, staging, prompts, storyboard, and video, each against its own [checklist](docs/CRITICS.md).
- **Self-inspection.** The agent checks its own work as contact sheets, filmstrips, waveforms, and an audio timeline.
- **Export verification.** konte confirms the MP4's resolution, duration, frame rate, and audio.
- **Model craft guides.** Bundled model adapters come with a prompting guide the agent reads before writing a prompt.

### Audio

- **Auto-ducking.** konte lowers the music under each spoken line and brings it back after. It follows the voice, not the silence around it.
- **Loudness leveling.** konte sets voices, narration, ambience, music, and sound effects each to their own level.
- **Tight sound effects.** konte skips the silence at the start of a sound effect, so it plays exactly on its cue.
- **Retiming.** konte fits a voice take to its shot without changing its pitch.
- **Speed changes.** A clip played faster or slower keeps the pitch of its audio.

### Music

- **Beat detection.** konte finds the song's beats with [Beat This!](https://github.com/CPJKU/beat_this).
- **Cutting to the beat.** The agent times shots in beats, and konte lines them up with the song.
- **Lyric alignment.** konte separates the vocals with [Spleeter](https://github.com/deezer/spleeter) and finds where each lyric line is sung.
- **Songs in parts.** konte joins a song generated in sections into one track.

### Dialogue and subtitles

- **Line checks.** konte transcribes each voice take with [SenseVoice](https://github.com/FunAudioLLM/SenseVoice) or [Parakeet](https://huggingface.co/nvidia/parakeet-tdt-0.6b-v3) and flags words that are missing, changed, or cut off.
- **Auto-timed subtitles.** The agent names a script line, and konte shows it where the line is spoken.
- **Japanese readings.** konte compares Japanese lines by how they are read, so kanji and kana spellings match.
- **Respelling.** A speech model gets the spelling it needs, and subtitles keep the script's wording.

### Compositing

- **Chroma key.** konte removes a green or other solid backdrop and places the subject over what is behind it.
- **Screen inserts.** konte puts content on an angled surface such as a monitor, a phone, or a sign.
- **Cut-ins.** A second camera angle plays in a corner of the shot.
- **Motion graphics.** The agent animates text and layers with GSAP, down to each character, and styles them with Tailwind.
- **Graphic shots.** The agent writes title cards and graphics in JSX, and konte renders them as images or video.
- **Overlay and thumbnail.** An overlay spans the whole video. The thumbnail is a frame of the cut, with optional graphics on top.

### Image and video operations

- **New camera angles.** konte estimates a location's depth with [MoGe-2](https://github.com/microsoft/MoGe) and renders a rough view from another angle for an image model to paint over.
- **Long takes.** The agent continues a take from its last frame to run past a model's maximum duration.
- **Delivery upscaling.** Export upscales each video layer, or the finished frame, to the delivery resolution.
- **Crop, resize, and trim.** These run locally with ffmpeg and need no generation backend.
- **Patches.** The agent fixes a single take with a script instead of regenerating it.

### Adaptation and reference

- **Adapting a source.** Give your agent a novel (.txt, .md, .epub), a comic (page images, .cbz, .pdf, .zip), or a film to adapt.
- **Studying a reference.** Give your agent a video file or URL to match. konte reads its cuts, look, music tempo, and voice.

## What the agent writes

The agent writes four TypeScript files per video. They stay in code so they can be diffed, reviewed, and checked before money is spent. konte checks types, the shot plan, and dependencies before generation.

| File            | What it describes                                                |
| --------------- | ---------------------------------------------------------------- |
| `direction.ts`  | The shot plan, timing, characters, locations, and camera setups. |
| `reference.tsx` | Shared assets such as character references and music.            |
| `animatic.tsx`  | The timed storyboard, including still images and dialogue.       |
| `video.tsx`     | The final shots, sound, subtitles, and overlays.                 |

`konte.state.json` records takes and which ones you accepted; review comments are kept under `review/`. Each asset has an address such as `video:shot.01.motion`; konte tracks changes to its definition and inputs. The agent asks before replacing a take you accepted.

A shot in `video.tsx` references the animatic's keyframes and fills the model's prompt sections, all as typed fields:

```tsx
shot("01", ({ duration }) => {
  const motion = asset("motion", videoMinimaxH3R2v, {
    image1: animatic.shot("01").image("first"),
    prompt: {
      summary: { tasks: ["keyframe completion"], text: "The girl of <Picture 1> adds a stroke..." },
      detailedDescription: { style: "2D-animated.", shots: ["She lifts her gaze, smiling..."] },
    },
  });
  return (
    <Composition>
      <Video src={motion} />
      <Subtitle entries={[{ start: 1, end: duration - 0.5, text: "Animatic it." }]} />
    </Composition>
  );
});
```

Adapters define model inputs and prompting rules separately from the shot plan. The [kitchen-sink example](src/cli/templates/workspace/videos/kitchen-sink) is maintained and type-checked with konte.

## What konte is not

- **Not a generative model.** It orchestrates the models you already use.
- **Not a ComfyUI replacement.** Your workflows stay yours, wrapped as reproducible parts of a project.
- **Not a timeline editor.** You direct through feedback and regeneration, not by moving clips on a timeline.
- **Not a taste machine.** It records what was tried, accepted, and invalidated. It never decides what looks good.
- **Not for a one-off clip.** konte pays off as shots, takes, and days of iteration accumulate.

## Status

konte is a pre-1.0 technical preview:

- Project definitions and state formats can change without migration support.
- Claude Code in the terminal with local ComfyUI is the most tested combination.
- The review UI is minimal, with playback, take comparison, acceptance, and pinned comments.
- Film-scale productions have not been tested.

Share feedback on [GitHub Issues](https://github.com/shiwano/konte/issues/new?template=support.yml). The `konte-feedback` skill can draft a report.

## License

MIT. See [LICENSE](LICENSE).
