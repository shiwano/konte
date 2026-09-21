# konte

[![Tag](https://img.shields.io/github/tag/shiwano/konte.svg)](https://github.com/shiwano/konte/releases)
[![Build Status](https://github.com/shiwano/konte/actions/workflows/ci.yml/badge.svg)](https://github.com/shiwano/konte/actions/workflows/ci.yml)
[![Discord](https://img.shields.io/badge/Discord-join-5865F2?logo=discord&logoColor=white)](https://discord.gg/2b7UwFE2Yy)

https://github.com/user-attachments/assets/6e47740c-b12b-4a7e-aa88-8df246534436

<sup>The workspace that produced this video is public: [konte-readme-hero-example](https://github.com/shiwano/konte-readme-hero-example).</sup>

konte treats a multi-shot AI video as a software project so a coding agent (Claude Code, Codex) can run the production end to end: planning shots, driving generation, tracking every take, and carrying your feedback into the next iteration. You keep the one job that can't be delegated: watching the cut and deciding what changes.

> **Status: early technical preview.** Expect rough edges and breaking changes. See [Status](#status).
>
> **AI agents:** start with [README_FOR_AGENTS.md](README_FOR_AGENTS.md).

## Why

AI made generating a clip easy. The video in your head is another matter. First the idea has to take shape (beats, shots, images), and then it has to be produced: dozens of shots, each generated many times, takes to pick, breakage to fix. Today, all of that is on you.

An agent should be able to take over both halves. But it can't, because an AI video project is just a folder of files: no structure for developing the idea, no record of which take won or what depends on what. konte gives it both, so the agent can carry your idea all the way to a finished video, and you can direct.

## You direct. Your agent produces.

- **Check in.** Run the `konte-checkin` skill. The agent reports where the piece stands and proposes the next move.
- **Decide.** Start a new piece, continue the current one, or revise what's already there. The agent drafts the plan for your sign-off and asks before touching accepted material.
- **Step away.** The agent does the production work: writes the prompts, runs generation, checks the output against the plan, and retries obvious failures.
- **Review.** A review window opens on the cut. Compare takes, accept winners, pin a comment to a frame: "too busy. Calm it down, keep the character."
- **Repeat.** Your comments are the next round of direction; the agent goes back to work.
- **Export.** When the cut is the one you meant, the agent renders the MP4.

## Quick start

Supports macOS, Linux and Windows (including WSL). No Node.js or Python required. Requires a reachable ComfyUI instance.

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

Close agent sessions using konte, delete your workspace directories, then remove the **konte** plugin and its marketplace from your agent. Models and custom nodes added to ComfyUI by konte remain installed.

## Production as typed code

You don't write the production files; your agent does. They stay in code because code can be diffed, reviewed, and type-checked before money is spent. A project is a handful of TypeScript files plus one state file (`konte.state.json`), all tracked in Git:

- `direction.ts` is the spine. It holds the ordered beats (role, action, duration), the piece-wide policy, the character, location, and prop rosters that everything else anchors to, plus the camera setups available to each shot.
- `reference.tsx` holds assets shared across the piece (characters, music), generated once and reused everywhere.
- `animatic.tsx` plans each shot with keyframe stills and timed dialogue, at a fraction of the cost of motion.
- `video.tsx` is the final stage: per-shot compositions in JSX (clips, subtitles, HTML overlays, soundtrack).

What the type system enforces:

- **Shots are minted from the spine.** A `shot("01", ...)` whose ID is not declared in `direction.ts` is a type error. The beat's duration, camera setup, and spoken lines are injected, so a shot cannot drift from the plan.
- **Cross-stage wiring is compile-checked.** Animatic references carry their types into the video stage: `animatic.shot("01").image("first")`.
- **`konte status` covers what types can't.** Story-arc holes, characters drifting out of their shots, stale or missing assets. Findings block generation until fixed or waived with a reason.

A shot in `video.tsx` puts those rules to work:

```tsx
shot("01", ({ duration }) => {
  const motion = asset("motion", videoMinimaxH3R2v, {
    image1: animatic.shot("01").image("first"), // typed cross-stage reference
    startImage: animatic.shot("01").image("first"), // pins the first frame
    prompt: {
      // the model's sections as typed fields; the adapter assembles the string
      summary: { tasks: ["keyframe completion"], text: "The girl of <Picture 1> adds a stroke..." },
      detailedDescription: { style: "2D-animated.", shots: ["She lifts her gaze, smiling..."] },
      // ...subjectDefinitions, retentionAnalysis, overallSoundscape, nonDiegeticMusic
    },
  });
  return (
    <Composition>
      <Video src={motion} />
      <div id="title" className="absolute top-8 w-full text-center text-5xl text-white">
        Sketchbook
      </div>
      <Animate script={({ timeline }) => timeline.from("#title", { opacity: 0, duration: 1 })} />
      <Subtitle entries={[{ start: 1, end: duration - 0.5, text: "Animatic it." }]} />
    </Composition>
  );
});
```

## Why "regenerate only what changed" holds

Build-system semantics, applied to non-deterministic outputs:

- **Addresses.** `video:shot.01.motion` is shot 01's motion clip, always. This is the stable interface between human language and machine operations.
- **Variants.** Every generation is a candidate filed under its address, and at most one is accepted. Rerolls append, never overwrite. Acceptance is an explicit, recorded state change.
- **Staleness.** Change what an accepted output was built from, and everything downstream (across stages) is flagged dirty. Nothing auto-regenerates, nothing auto-accepts.
- **Shared assets.** An asset declared in the `reference` stage is generated once and consumed by both stages, so one accepted character or music asset serves the whole piece, with a single accept and one staleness signal.
- **Cheap stage first.** Structure, pacing and continuity settle on the animatic. Motion is generated only from accepted keyframes.

## Your production survives model changes

Models change quickly. Your production decisions shouldn't have to.

konte keeps creative intent and generation-specific details in different layers:

- **Direction stays above the model.** `direction.ts` records the beats, characters, pacing, and camera setups the piece is built around, not the prompt syntax of a particular generator.
- **Accepted work stays useful.** Framing decisions, animatic timing, selected takes, and review notes remain part of the project even when you change how an asset is generated.
- **Models are replaceable at the edge.** Try a new video model by changing an adapter or regenerating selected assets. You don't need to reconstruct the production around it.

A better model can improve the render. It doesn't have to erase the decisions that got you there.

## Bring your own ComfyUI workflow

Hand your agent a workflow you already use, and it becomes a model the whole piece can call:

```
> /konte-comfy-workflow ~/Downloads/my-workflow.json   # Codex: $konte-comfy-workflow
```

- **As ComfyUI saves it.** No API-format export needed.
- **Typed inputs.** Auto-numbered node fields become named, typed inputs (`prompt`, `startImage`, `seed`), checked like every other asset.
- **Reproducible dependencies.** The models and custom nodes it needs are declared with download sources, and konte installs them on whichever ComfyUI you point it at.
- **A prompt guide.** The agent writes a craft guide for the model, so later sessions prompt it the way it expects.

The result is a file under `adapters/comfy/`, used exactly like a shipped adapter:

```tsx
const motion = asset("motion", myWorkflow, {
  startImage: animatic.shot("01").image("first"),
  prompt: "...",
});
```

## Backends

Each asset declares the model that produces it. Mixing backends in one project is normal.

- **[ComfyUI](https://comfy.org/download).** Required: every piece needs it, since the fal adapters alone do not cover a full production. It can run locally or on a remote GPU host such as [RunPod](https://docs.runpod.io/tutorials/pods/comfyui); konte only needs a reachable ComfyUI instance with ComfyUI-Manager, which the desktop install includes. For local use, plan on a GPU with 16 GB of VRAM (24 GB is comfortable) and tens of gigabytes of first-run downloads for weights and custom nodes. konte provisions those.
- **[fal.ai](https://fal.ai/).** Hosted models (MiniMax H3 Max, Seedance, Nano Banana) behind an API key; no GPU. Paid per generation; the agent reports the cost before generation starts.
- **Local ffmpeg and your own files.** Resizes, trims, blank frames, and bring-your-own media, tracked and addressed like everything else. No setup required.

## What konte is not

- Not a generative model. It orchestrates the models you already use.
- Not a ComfyUI replacement. Your workflows stay yours, wrapped as reproducible parts of a project.
- Not a timeline editor. You direct the production through feedback and regeneration, not by manipulating clips on a timeline.
- Not a taste machine. It records what was tried, accepted, and invalidated. It never decides what looks good.
- Not for a one-off clip. A single generation needs no state management; konte pays off as shots, takes, and days of iteration accumulate.

## Status

Pre-1.0 technical preview:

- The DSL and state format change without migration paths.
- Claude Code (terminal) and local ComfyUI are the most battle-tested.
- The review UI covers the core loop (playback, comparison, accept, pinned feedback) and is still minimal.
- We haven't yet dogfooded konte on film-scale productions, and we expect the current workflow to become challenging at that scale.

Field reports from real projects are the most useful contribution right now. Share them on [Discord](https://discord.gg/2b7UwFE2Yy); in a workspace, `konte-feedback` skill drafts the post for you.

## License

MIT. See [LICENSE](LICENSE).
