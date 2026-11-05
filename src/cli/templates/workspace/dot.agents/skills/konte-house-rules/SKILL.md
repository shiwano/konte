---
name: konte-house-rules
description: Propose house rules from the human's review comments on the current video, for them to pick. Use after a video is finished, or when the user wants to carry what they kept asking for into the next piece.
user-invocable: true
---

Done = the rules the human picked written into `HOUSE_RULES.md`; nothing written they did not pick.

## 1. Gather

- `konte review feedback list --all --verbose` — every comment on this video, stale and signed-off ones included; a comment a fix answered is still what the human asked for.
- `HOUSE_RULES.md` — the rules already standing.

## 2. Pick candidates

A candidate is a preference the next piece should start from:

- the same kind of note on two or more shots or stages (shot 03 and shot 07 both "faces too dark")
- a note worded for every piece ("always", "never", "from now on")
- a standing rule the comments say was missed — a rewording

Not a candidate:

- one shot's fix — a hand position, one line's timing
- what the brief or direction chose — it holds for this piece only
- a defect konte could count — a figure too many, an empty frame → `konte-feedback`

## 3. Propose, then write

- In the human's language, one item per candidate: the rule as one line, then the comments it rests on (shot + a short quote); flag one that overlaps or contradicts a standing rule.
- No candidate → say so; write nothing.
- **Write only what the human picks**, worded as they approved it, one line per rule after the standing ones. Never edit or drop a standing rule unless they ask.
