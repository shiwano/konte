# konte

[![Tag](https://img.shields.io/github/tag/shiwano/konte.svg)](https://github.com/shiwano/konte/releases)
[![Build Status](https://github.com/shiwano/konte/actions/workflows/ci.yml/badge.svg)](https://github.com/shiwano/konte/actions/workflows/ci.yml)
[![Discord](https://img.shields.io/badge/Discord-join-5865F2?logo=discord&logoColor=white)](https://discord.gg/2b7UwFE2Yy)

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
> /konte-checkin   # Codex: $konte-checkin
```

The agent helps you develop a new idea or picks up an existing project where you left off, then proposes the next step.

1. **Plan.** Discuss your idea with the agent and accept the shot plan.
2. **Review shared assets.** Accept the characters, locations, and other references.
3. **Review the cut.** The agent builds a timed storyboard, then video, one sequence at a time.
4. **Revise.** Choose takes and leave comments; the agent makes the changes.
5. **Export.** When you accept the cut, the agent renders the MP4.

https://github.com/user-attachments/assets/752ed713-a210-44b8-ba14-74973285ecb7

<sup>Project files for this video: [konte-demo-video](https://github.com/shiwano/konte-demo-video/tree/main/videos/how-you-use-it).</sup>

## Quick start

**Requirements:** Claude Code or Codex and a [generation backend](#backends). Supports macOS, Linux, and Windows (including WSL). konte needs no Node.js, Python, or other runtime installation.

Create a workspace directory, then install the plugin, run setup in a chat opened there, and check in (`$` = terminal, `>` = agent chat).

### Claude Code

**1. Install** from the terminal:

```
$ claude plugin marketplace add shiwano/konte@plugin
$ claude plugin install konte@konte
```

Or in the desktop app, open **Settings → Plugins → Add marketplace → Add from a repository**, enter `shiwano/konte@plugin` as **URL**, and install **konte**.

**2. Set up** in a new chat in your workspace, then restart as setup instructs:

```
> /konte:setup
```

**3. Check in** after the restart:

```
> /konte-checkin
```

https://github.com/user-attachments/assets/c10629d3-e1eb-4708-95da-c3720bac878f

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

**2. Set up** in a new chat in your workspace, then restart as setup instructs:

```
> $konte:setup
```

**3. Check in** after the restart:

```
> $konte-checkin
```

https://github.com/user-attachments/assets/ac615568-6e7f-434a-aa34-e17c6381d57c

<sup>Project files for this video: [konte-demo-video](https://github.com/shiwano/konte-demo-video/tree/main/videos/codex-desktop-setup).</sup>

### Uninstall

Close agent sessions using konte, delete your workspace directories, then remove the **konte** plugin and its marketplace. konte writes nothing outside a workspace.

## Backends

You can mix backends in one project. The agent opens settings when needed and guides you through entering API keys or connection details.

| If you…                         | Backend                                 | Setup                                                                                                                                                                                                                                               |
| ------------------------------- | --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| have a capable GPU, or rent one | [ComfyUI](https://comfy.org/download)   | Requires ComfyUI-Manager. konte installs models and nodes; plan on 16 GB of VRAM (24 GB is comfortable) and tens of gigabytes of first-run downloads. Run locally or on a GPU host such as [RunPod](https://docs.runpod.io/tutorials/pods/comfyui). |
| have no capable GPU             | [Comfy API](https://platform.comfy.org) | Requires an API key; paid per generation. Comfy Cloud, the managed deployment, runs workflows whose nodes and models it already has, which konte checks. For any other workflow, the agent guides you through creating your own deployment.         |
| want a closed model             | [fal.ai](https://fal.ai/)               | Requires an API key; paid per generation. Adds models no ComfyUI can host, such as MiniMax H3 Max, Seedance, and Nano Banana. Closed models alone cannot run konte's whole workflow.                                                                |

Your own images, video, and audio work too. konte manages the local tools for resizing, trimming, and assembly.

### Bring your own ComfyUI workflow

Give your agent a workflow saved from ComfyUI:

```
> /konte-comfy-workflow ~/Downloads/my-workflow.json   # Codex: $konte-comfy-workflow
```

The agent creates an adapter with typed inputs, dependencies, and a prompting guide. No API-format export is needed.

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

Share feedback on [GitHub Discussions](https://github.com/shiwano/konte/discussions/new?category=support) or [Discord](https://discord.gg/2b7UwFE2Yy). The `konte-feedback` skill can draft a report.

## License

MIT. See [LICENSE](LICENSE).
