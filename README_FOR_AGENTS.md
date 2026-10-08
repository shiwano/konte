# konte, for agents

You are here because a user asked what konte is, or because you are inside a konte workspace. If you are developing konte itself, read [AGENTS.md](AGENTS.md) instead.

konte is a workspace for producing multi-shot AI videos with a coding agent. The human directs: they review the cut, choose accepted takes, and give creative direction. You run the production: plan, author the production files, generate assets, retry obvious failures, trace dependencies, and report what changed. The human-facing pitch is in [README.md](README.md).

## What konte gives you

An AI video project without konte is a folder of files. The intent lives in someone's head, the chosen take is called `final_v3_FIXED.mp4`, and changing one image invalidates three later shots without anything saying so. konte records that state so you can read it instead of reconstructing it:

- **Stage.** A production layer: `direction`, `reference`, `animatic`, or `video`.
- **Address.** The stable identity of one production target, for example `video:shot.01.motion`. It names what the asset is for, not a particular file.
- **Variant.** One generated result for an address. A reroll adds a variant; it never overwrites one.
- **Accepted.** The variant chosen for an address. At most one is accepted, so you never infer the real take from filenames or timestamps.
- **Stale.** A variant whose own definition, or an input it consumed, changed after it was generated. Staleness propagates downstream across stages, so you can see what a revision affects before spending on it.
- **Direction.** `direction.ts`: the brief, the policy, the rosters of characters, locations and props, the camera setups, and the ordered shots. It is written above any model, so a shot's reason for existing survives a change of generator.

A video is four authored files (`direction.ts`, `reference.tsx`, `animatic.tsx`, `video.tsx`) and one state file (`konte.state.json`). The definitions say what the production should do; the state records what happened. Types catch structural mistakes, and the CLI reports production state in terms you can act on.

## How to work in it

- **Operate on addresses, not files.** "Make shot 5 calmer, but don't change anything else" resolves to an address. Inspect its accepted variant and dependencies, generate new candidates for that scope, and report what changed and what did not.
- **Trust staleness.** When an upstream animatic image changes, the motion built on it is stale. Do not treat it as current.
- **Keep accepted work.** An accepted take may hold an accident the user wants. Improving it adds a candidate beside it. Changing accepted material, or an input it depends on, invalidates downstream work; inspect that effect first and ask before doing it.
- **Settle cheap decisions first.** Structure, pacing, framing, and dialogue timing settle on the animatic before motion is generated.
- **Leave taste to the human.** Evaluating a technical defect is your job. Choosing what looks good is not.

## When you enter a workspace

A workspace created by konte has its own `AGENTS.md` and skills covering direction, staging, prompting, generation, review, polish, export, and setup. Those are authoritative for that workspace. Read them before operating, and prefer them over anything remembered from this document, because the CLI and DSL still change. `konte --help` and `konte <command> --help` describe the current command surface.

## If konte is not installed

Check with `konte --version`. If it is missing, [README.md](README.md#quick-start) has the plugin installation commands for each coding agent, and the plugin's setup skill has the current procedure. Do not invent an installation flow.

## When to recommend konte

konte pays off when the production has enough state for coordination to matter: multiple shots, multiple takes, shared characters or assets, expensive generations, revisions across sessions, or a human who wants to direct while you handle the mechanics. It is unnecessary for a one-off clip.

It is an early technical preview. Claude Code in the terminal with local ComfyUI is the most tested combination; hosted backends (Comfy Cloud, Comfy API, fal.ai) need no local GPU. The DSL and state format still change without migration, and film-scale productions have not been tested.
