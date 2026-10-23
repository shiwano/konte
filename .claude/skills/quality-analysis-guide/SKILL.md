---
name: quality-analysis-guide
description: Read a video's review records as the measure of its quality — the shots that took rounds, the human comments naming a defect the agent or konte should have caught, and the guide or adapter each traces to. Read before opening a workspace video's review records in a session analysis.
user-invocable: false
---

Done when every finding cites comment, variant or record ids and names the guide, adapter or konte surface it implicates. The human's comments are the ground truth — never score a take yourself. Read only; never regenerate or change the video.

## Sources

Per video (`videos/<name>/`):

- `review/<stage>/feedback.json` — every comment of every stage, standing or stale, keyed by target address: `createdAt`, `text`, `displayedVariants`
- `konte review record list` / `review record show <file>` — one review each: `decisions`, `overallComment`, the `handoffNotes` it was shown with
- `konte.state.json` — `.assets[<address>].variants[<id>].status` (`accepted` / `dismissed` / `none`), `derivedFrom`, `patchHash`
- `konte inspect <variantId>` — the inputs a take was made from; diff two takes' to see what changed between rounds
- the stage file — which adapter an asset uses

```sh
jq -r '.feedback | to_entries[] | .key as $a | .value[] | [.createdAt, $a, .id, (.displayedVariants // {} | [.[]] | join(",")), (.text | gsub("[\n\t]"; " "))] | @tsv' review/*/feedback.json | sort > /tmp/comments.tsv
cut -f2 /tmp/comments.tsv | sort | uniq -c | sort -rn   # comments per target
jq -r '.assets | to_entries[] | [(.value.variants | length), ([.value.variants[] | select(.status == "dismissed")] | length), .key] | @tsv' konte.state.json | sort -rn   # takes, dismissed, address
```

## 1. Rounds per shot

- Chain a shot's comments across records in time order. Each chain ends accepted, re-commented, or accepted over a standing comment.
- Three or more rounds on one shot = a weak spot; read its chain whole.
- A comment pointing back to an earlier take by id = a regression. Diff the two takes' inputs.
- A comment withdrawing the human's own earlier ask is a changed mind.
- An accept over a standing comment is a compromise — list it as residual debt in the delivered piece.

## 2. Taste or defect

- Taste — framing preference, acting, the feel of timing, a changed mind.
- Defect — a take contradicting its own definition or the direction: a script line missing, a prop the setup `holds` absent, a wrong count, unwanted source audio, a continuity break with an adjacent shot, a broken generation.
- **Every defect the human caught is a finding** — `generation-loop-guide`'s self-review or a `konte-*-critic` should have stopped it. In the transcript, before that preview:
  - the agent never viewed the take nor spawned the critic → a procedure miss
  - it viewed and passed it → the check lacks that axis; name the axis
  - the defect was invisible to the agent (spoken words, motion between sampled frames) → a konte surface gap; name what konte would have to print or render

## 3. Trace each comment to its owner

- frame, blocking, motion, plates → `staging-guide`
- a prop or landmark missing, continuity across shots → `direction-guide` (setup `holds`, rosters)
- the prompt not followed, a model artifact → `prompt-guide` and the adapter's craft guide (`.konte/guides/<adapter>.md`)
- captions, layers, cutins, levels, beds → `composition-guide`
- generate vs compose, pinned frames, the adapter chosen → `production-guide`
- script and line content → `scenario-guide`

- **One class of comment across two or more shots is a guide gap**.
- A human naming a model's weakness ("a blink instruction breaks it") is craft knowledge — absent from the craft guide, propose the line.

## 4. Fix method against the comment

For each comment, what the agent did next — the transcript, the next handoff note, the `inspect` diff:

- a reroll on a structural comment (framing, a missing object) → the definition had to change
- prompt rewording repeated against a model limit → the method or adapter had to change (`production-guide`)
- a handoff note claiming a fix the next comment contradicts → the self-check did not verify against the comment

## 5. Yield per adapter

- Group takes and dismissals by adapter. A low yield → check whether its craft guide loaded before the prompt was written: not loaded is a routing miss; loaded points at the guide or the model choice.

## Report

Each finding: observation, evidence, consequence, the implicated guide, adapter or konte surface, and its class — konte surface gap, guide gap, routing miss, agent mistake, model limit or human taste. A single comment earns a guide line only when it names a defect class.
