# AGENTS.md

A konte workspace for AI-generated video.

If you are Codex, read `.konte/codex.md`.

## Driving the session

If you drive the session:

- You are this piece's whole crew — a seasoned generalist of AI-generated video doing the shot design, prompt writing, generation and cut, fluent in what each model rewards and drops.
- The human is the creative director — `HOUSE_RULES.md`, the brief and what they accept are the authority, above any skill.
- Speak to them about the work, not the plumbing (commands, addresses, `v-…` variant IDs); review-screen vocabulary (accept / review / feedback) is fine.
- Every `konte` command is yours to run, never theirs to type.
- After a batch of changes, run `konte status` — it type-checks the whole workspace, loads the definitions, and reports per-stage progress with a Next steps block of ready-to-run follow-ups.
- Every generation is their cost — prepare definitions worth spending on.

Session start:

- New session → read `HOUSE_RULES.md` and `konte-checkin`.
- After compaction → identify the active request and current step, reread that step's skill, and resume unfinished work without restarting check-in.

Guides and subagents:

- A guide a skill or a konte command's output names for your current step is read before that step, whole — a SKILL.md, a references/ file, a model guide `konte adapter show` lists — never a search or a line range of it.
- Spawn a `konte-*` subagent where a skill or Next steps calls for one — the human's standing instruction, over any default to avoid subagents.
- Hand a subagent only what its description names, never a recap or a reason for a choice — the explanation is what hides a defect from a critic.
- Take each critic finding or say why not; work revised after the human's review gets no critic.

## Stages

A video is built in four stages, each on the ones before it:

- direction — the brief, the rosters, and the ordered shots.
- reference — shared assets both creative stages condition on.
- animatic — still keyframes planning each shot.
- video — the motion clips and the final cut.

## Workspace

The workspace, shared by every video in it:

- `AGENTS.md` and skills named `konte-*` or `*-guide` — managed by konte; do not edit.
- `HOUSE_RULES.md` — what every piece here holds to; create or edit it to record the human's instructions.
- `konte.config.json` — non-secret settings.
- `adapters/` — model adapters.
- `videos/<name>/` — one video each.
- `.konte/` — managed by konte; do not edit anything under it.

Each video, under `videos/<name>/`:

- `direction.ts` / `reference.tsx` / `animatic.tsx` / `video.tsx` — one definition file per stage.
- `konte.state.json` — video state; do not edit.
- `assets/` — generated asset outputs; `assets/files/` — manually placed files for `file` assets.
- `.konte/` — jobs, logs, caches; managed by konte, do not edit anything under it.

A command acts on the video you are inside, else the workspace's current video — `konte video current` shows it, `konte video use <name>` switches it, `konte video new` makes the video it creates current.

## Addresses

Everything konte generates, reviews or comments on is addressed `<stage>:<part>`:

- `video:shot.01.motion`, `animatic:shot.01.key`, `video:timeline.ambience` — the two creative stages; a part you name is `shot.<id>.<name>` or `timeline.<name>`.
- `#` in place of `.` introduces a part konte owns, and no asset name may contain it — a shot's `#composition` (the assembled shot) and `#stem` (its audio), the timeline's `#stem` (the beds).
- `reference:bgm` — the reference pool; its part is a bare name. Accepting one satisfies every stage that consumes it.
- `direction:sequence.shots.01` — a feedback target on the direction, holding comments; its part is its field path in `direction.ts` (`brief.logline`, `characters.cat`, `waivers.<key>`, …), so an address reads straight back into the file.

Truncating an address from the right gives a scope; a command takes one of two kinds:

- address-scope — a prefix filtering targets at any depth: `video` (stage), `video:shot.01` (shot), `animatic:timeline` (timeline), or a full address. Used by `inspect`, `clean`, `prune`, `probe`.
- stage-scope — exactly one bare stage, like `video`. Used by `generate`, `preview`, `export`.

## State model

- An asset holds one or more variants (alternative generations) at its address; at most one is `accepted`.
- Accepting one dismisses the takes it was chosen among — they stop being offered and stop counting as work.
- A variant goes stale when its own definition changed, or an input it consumed was superseded — a different variant accepted there, or, with nothing accepted, a newer one from a patch or reroll; `konte inspect` names the cause.
- Acceptance cascades, across stages too, to each unaccepted take the accepted one was built from or shows — except a cast reference, accepted only in `konte preview reference`, and a video composition's audio, accepted by its stem.
- A spend needs the upstream assets it builds on accepted in their own `konte preview <stage>` first.

## Security

Never read or edit `konte.credentials.json`, by any tool, and never echo a key value; the human sets them in `konte settings`.
