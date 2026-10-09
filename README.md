# konte

[![Tag](https://img.shields.io/github/tag/shiwano/konte.svg)](https://github.com/shiwano/konte/releases)
[![Build Status](https://github.com/shiwano/konte/actions/workflows/ci.yml/badge.svg)](https://github.com/shiwano/konte/actions/workflows/ci.yml)
[![Discord](https://img.shields.io/badge/Discord-join-5865F2?logo=discord&logoColor=white)](https://discord.gg/2b7UwFE2Yy)

**Make multi-shot AI videos with a coding agent. You direct; your agent produces.**

konte treats the video as a software project, so Claude Code or Codex can run the production end to end. The agent plans the shots, drives generation, tracks every take, and carries your feedback into the next round. You discuss the idea, review the cut in your browser, and decide what changes.

https://github.com/user-attachments/assets/6e47740c-b12b-4a7e-aa88-8df246534436

<sup>Project files for this video: [konte-readme-hero-example](https://github.com/shiwano/konte-readme-hero-example).</sup>

> **Early technical preview.** Expect rough edges and breaking changes. See [Status](#status).
>
> **AI agents:** start with [README_FOR_AGENTS.md](README_FOR_AGENTS.md).

## Why

AI made a single clip easy. A video gets harder with every shot you add: the shots have to agree with each other, each one is generated many times, takes have to be picked, and one change ripples into its neighbors. A coding agent can do that work, but only if the project tells it which take won and what depends on what. konte keeps that record, so the agent can carry your idea to a finished video and you can direct.

## How you use it

After setup, start a session with one skill:

```
> /konte-checkin   # Codex: $konte-checkin
```

The agent helps you develop a new idea or reviews an existing project's progress, then proposes the next step.

1. **Plan.** Discuss your idea with the agent and approve the shot plan.
2. **Review assets.** Approve the shared characters, locations, and other references.
3. **Review the cut.** The agent builds a timed storyboard, then video, one sequence at a time.
4. **Revise.** Choose takes and leave comments; the agent makes the changes.
5. **Export.** When you approve the cut, the agent renders the MP4.

## What konte keeps

- **Compare takes.** Each generation adds a candidate and keeps earlier takes available.
- **Track changes.** konte flags outputs affected by changed inputs; the agent asks before replacing accepted work.
- **Reuse shared assets.** Character references, props, and music can serve multiple shots.
- **Resume later.** Production files, accepted takes, and feedback stay in the workspace.
- **Try other models.** The agent can switch models for selected assets, keeping the shot plan and review history.

## Quick start

Requires Claude Code or Codex and a [generation backend](#backends). Supports macOS, Linux, and Windows (including WSL). konte needs no Node.js or Python installation.

Create a workspace directory and open it in your agent. Install the plugin and run setup there (`$` = terminal, `>` = agent chat).

### Claude Code

Install from the **terminal**:

```
$ claude plugin marketplace add shiwano/konte@plugin
$ claude plugin install konte@konte
```

Or in the **desktop app**, open **Settings → Plugins → Add marketplace → Add from a repository**:

1. Enter `shiwano/konte@plugin` as **URL**.
2. Install **konte** and start a new chat in your workspace.

Then run setup:

```
> /konte:setup
```

Restart as setup instructs, then run `/konte-checkin`.

### Codex

Install from the **terminal**:

```
$ codex plugin marketplace add shiwano/konte@plugin
$ codex plugin add konte@konte
```

Or in the **desktop app**, open **Settings → Plugins → Add plugin marketplace**:

1. Enter `shiwano/konte` as **Source**, `origin/plugin` as **Git ref**, and leave **Sparse paths** empty.
2. Install **konte** and start a new chat in your workspace.

Then run setup:

```
> $konte:setup
```

Restart as setup instructs, then run `$konte-checkin`.

### Uninstall

Close agent sessions using konte, delete your workspace directories, then remove the **konte** plugin and its marketplace. konte writes nothing outside a workspace.

## Backends

You can mix backends in one project. The agent opens settings when needed and guides you through entering API keys or connection details.

| If you…                         | Backend                                                                          | Setup                                                                                                                                                                                                                                               |
| ------------------------------- | -------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| have a capable GPU, or rent one | [ComfyUI](https://comfy.org/download)                                            | Requires ComfyUI-Manager. konte installs models and nodes; plan on 16 GB of VRAM (24 GB is comfortable) and tens of gigabytes of first-run downloads. Run locally or on a GPU host such as [RunPod](https://docs.runpod.io/tutorials/pods/comfyui). |
| have no capable GPU             | [Comfy Cloud](https://cloud.comfy.org) / [Comfy API](https://platform.comfy.org) | Requires one Comfy API key. Comfy Cloud runs workflows whose nodes and models it already has, which konte checks; Comfy API runs any workflow on a deployment the agent prepares and guides you through creating.                                   |
| want a closed model             | [fal.ai](https://fal.ai/)                                                        | Requires an API key; paid per generation. Adds models no ComfyUI can host, such as MiniMax H3 Max, Seedance, and Nano Banana, alongside a ComfyUI backend rather than in place of one.                                                              |

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

`konte.state.json` records takes and approvals; review comments are kept under `review/`. Each asset has an address such as `video:shot.01.motion`; konte tracks changes to its definition and inputs.

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

- Not a generative model. It orchestrates the models you already use.
- Not a ComfyUI replacement. Your workflows stay yours, wrapped as reproducible parts of a project.
- Not a timeline editor. You direct through feedback and regeneration, not by moving clips on a timeline.
- Not a taste machine. It records what was tried, accepted, and invalidated. It never decides what looks good.
- Not for a one-off clip. konte pays off as shots, takes, and days of iteration accumulate.

## Status

konte is a pre-1.0 technical preview:

- Project definitions and state formats can change without migration support.
- Claude Code in the terminal with local ComfyUI is the most tested combination.
- The review UI is minimal, with playback, take comparison, approval, and pinned comments.
- Film-scale productions have not been tested.

Share feedback on [Discord](https://discord.gg/2b7UwFE2Yy) or [GitHub Discussions](https://github.com/shiwano/konte/discussions). The `konte-feedback` skill can draft a report.

## License

MIT. See [LICENSE](LICENSE).
