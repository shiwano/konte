---
name: staging-guide
description: Stage a shot's frame, cut and motion from its action, and build its plates. Read before a shot's prompt or panel blocking/camera, when wiring plates or fixing a plate, landmark or keyframe-input finding, and for feedback about what the frame or movement conveys.
user-invocable: false
---

Stage each shot's frame, cut and motion from its `action`; done = the read-test below passes and the panel's movement is written from its take. Prompt wording belongs to `prompt-guide`.

## Routing

- **Building or using location masters or setup plates, or fixing related findings** → [plates.md](references/plates.md).
- **Changing a setup, lineup, join or cutin** → `direction-guide`.

## Where the movement lives

- **The shot's goal is the direction's `action`, stated once in `direction.ts`** — stage against it, never restate it. There is no separate audio goal.
- **Every panel declares the movement out of it** — `blocking` and `camera`, across the span to the next keyframe, or, on a shot's only panel, to the shot's end. A multi-panel shot's landing frame declares neither, except at a continuous seam.
- **Write it from the take, before the board goes to review** — settle the panel's take first, then write the transit the `action` needs from that frame; if the take can't launch it, the take is wrong, not the shot. It gates the review, never the generation.
- **Rewriting it after the panel was accepted asks for no review of its own** — the take is untouched.
- **Only the transit** — a keyframe fixes a position, never a direction through it; what the pair already shows does not belong in these fields.
- **Write both in the `brief`'s working language**, whatever the prompts use.

## Split blocking from camera by who moved

- **`blocking` is the subject's movement** — where it goes, how, and whether it crosses the frame edge (and which edge). Name the edge whenever the subject enters or leaves: the next shot's entrance has to agree with it.
- **`camera` is the camera's, and `"fixed"` is a value you state** — an omitted `camera` reads as unbound, not as a locked-off one; both halves land together.
- **A subject that leaves frame because the camera moved off it is `camera`** — the next shot inherits no screen direction from it.

## Stage the frame

- **The eye lands on the action's carrier** — whatever the shot hinges on must be the frame's most salient element (position, contrast, light, motion); if a stranger's eye goes elsewhere first, the staging failed before the prompt.
- **One strong signifier per idea** — pick the element that says it best and cut action-adjacent extras; each one added dilutes the read.
- **Subject & purpose** — what the subject wants in this shot decides pose, expression, and gaze. Name a declared character by its exact roster `promptDepiction` and anchor its look on the `reference:<id>` asset (identity prose → `prompt-guide`'s reference preflight). A subject the frame holds that no prompt behind the keyframe names is `subject-unnamed`: name one and the model decides the rest for itself.
- **Name every subject in `ctx.lineup` order** — who the frame holds, left to right, is the direction's (`ctx.lineupTo` the order the shot leaves on); one named place lands nothing, all of them always lands. Add who is nearer the lens where they are not side by side.
- **Pass a reference image for every one of them** — a subject the frame holds and the keyframe took no `reference:<id>` of is `character-unconsumed`: the look is then whatever the prompt happens to say, take by take. A subject only a sleeve or a fist of whom is in frame is fed too, never waived. A keyframe drawn from an earlier keyframe inherits what that one stood on.
- **Pass them in the same order** — the slot order is the other half of what decides who lands where (`slot-order-mismatch`), so a take that came back with the wrong person on the wrong side is a slot fix and never a waiver.
- **`<Cutin>` keyframes answer `ctx.cutin.lineup` / `lineupTo`** by the rules above and stand on that setup's plate.
- **`ctx.lineupTo` is a `blocking` note waiting to be written** — the panel it changes out of says the move (`blocking`, above) and the last keyframe's slots take the new order.
- **Size and angle both come from the shot's `setup`** — stage to its `framing` (`wide` → the concrete long shot, `insert` → the object filling frame), and change either by editing the setup. Low angle empowers, high diminishes, eye level observes — pick from the `action` and write it into the setup's `description` so the next shot on it inherits the camera.
- **Say where each figure meets the floor** — a keyframe built on a plate otherwise comes back with the figures pasted in front of it. Let distance read as height on the visible floor: further from the lens, feet higher in the frame and the figure smaller.
- **A state the story changes is one `reference:` asset per state, each built from text** — a window before and after it breaks is two; a page blank, scribbled, then washed is three. Feed each where shown: prose redraws the state every take. Count the states before the reference review — a reference accepted in one state a later shot contradicts stales every panel built on it.
- **At `close`, anchor the subject and let the set fall to suggestion** — shallow depth of field, one sliver of set behind carrying the setup's `holds`: it owes the location its material and light, and owes it no layout. `insert` holds nothing — it fills the frame with an object and shows no set.
- **Keep the set quiet** — the frame holds only what the shot reads against; every extra prop hands motion background churn to fail on. Keep the master sparse; dress a shot's prop in its panel.
- **The pose reads in silhouette** — if the action wouldn't be legible as a black shape, no lighting or detail will save it; pick the angle that opens the pose.
- **Build depth in layers** — a foreground, a subject plane and a background give motion somewhere to travel, and naming what sits just off-frame gives gaze somewhere to go; a single-plane frame reads as a flat still.

## Stage the cut

- **Eyelines, screen direction and edges bind every cut, shown geography or not** — the 180° line, gaze axes, the entrance/exit directions the `action` implies, and wardrobe/props agreeing across adjacent same-space shots. A journey "toward" something holds one direction across every panel and shot.
- **The 180° line is checked between two shots in one place** — a pair both frames hold that swaps sides is `lineup-flipped`: move the camera, or declare the move with `lineupTo` in the shot it happens in. A single subject re-framed from the other side settles no pair, so it is yours to catch.
- **Matching backgrounds is a chosen spend** — owed only where two frames share geography on screen (a continuous-space stretch, a re-established `wide`); there, pin the look on a `reference.tsx` asset and compare the adjacent panels at the board, before paying for motion.
- **Change two of size / angle / subject on every cut** — unless a match cut is the point; a cut that changes only one reads as a jump, and cutting back to one setup without a shot between flattens the sequence.
- **The edit base chooses the camera** — a keyframe built by editing a neighbouring shot's populated frame inherits its composition whatever the prompt says. Chain off a neighbour only when a match cut is the point. Otherwise start from the plate whenever the shot is on a declared setup. At a `join: "continuous"` seam, keep the camera of the panel before it.
- **A long take has one frame at its seam, and it is the next shot's first panel** — `join: "continuous"`: the shot before authors no closing keyframe; its last panel carries `blocking` / `camera` like any other. Nothing is passed on the board.
- **A cut along one `within` axis takes the frame before it** — two setups of one axis, no join written: the previous shot's last panel goes in one of the keyframe's image inputs (a cutin's: the last panel of the cutin before it), for a model that reads it as the frame the cut comes from (`readsPrevPanel` in `konte adapter show`). The plate fixes the room, that panel the subject's light, size and position; a cut between two lineups sharing no subject owes none. `panel-unlinked` gates it; a cut meant to re-open the frame is the waiver.
- **Save the strongest staging for the payoff** — the lens's payoff beat gets the most distinct frame in the piece; spending it on a setup beat upstages the climax.
- **Name light and time per shot, and let them progress** — a light source and time of day are continuity anchors within a scene and an arc across the piece; unnamed light drifts per generation.

## Stage the motion

- **An `action` that needs two motions is a direction fix**, never a longer prompt.
- **A motion shot is a visible change — fix state A and state B** — what the clip's first and last moments must each read as; if they read the same, the shot didn't happen. A near-still shot is chosen up front, in the panel's `camera`/`blocking`, never rationalized after a quiet clip comes back.
- **A shot's `first` panel stages where its motion begins, not where it lands** — the loaded instant before the action: charged, never the peak, or the shot has nowhere to move. Opening on the tail is a choice, never a default.
- **Audio is staging too** — a one-shot `<Audio>` lands on a visible action frame (name which); a `soundtrack()` bed states a mood the picture already earns (placement → `composition-guide`). Sound or a telop never rescues an unreadable picture — fix the staging.

## Stage for the generator

- **A capability limit belongs to one model, and it is written down** — the `## Avoid` section of `.konte/guides/<model>.md` (`konte adapter show <adapter>`). Read it at routing time; never stage around a general belief about what generation can't hold.
- **Restage, don't caveat** — where the guide names a real limit, substitute a staging that keeps the shot while shrinking what must move; prompt-side warnings ("smooth motion") fix nothing.
- **Withhold an event through a reaction, sound or aftermath when that carries the shot more clearly.**
- **Crop the choreography** — a tighter setup (`close`/`insert`) keeps only the load-bearing part moving in frame; what is outside the frame can't fail.
- **One mover per shot** — subject or camera, never both large at once; a slow push, pan, or tilt over stable staging reads as motion on its own.
- **A charged hold is a beat** — only breath, hair or light moving.
- **Spend the risk on the payoff** — a shot that may take many rerolls earns them where the piece lands; alternate closes, inserts and charged holds for the setups.

## Read-test before you pay to generate

- **Describe first, compare second** — state what the panel shows before rereading the `action` and its `blocking`/`camera`; checking with them in mind only ever confirms them.
- **Name the reading that must be unambiguous, then try its opposite** — derive from the `action` the one axis that cannot misread (arriving vs leaving) and ask whether a zero-context viewer could land on the wrong side. If it misreads, fix the staging, not the prompt words.

## On a staging note, re-derive the whole staging

- **A staging note is a prompt to re-derive the shot's whole staging, not a line to apply word-for-word** — the note names a symptom; re-ask what the direction's `action` needs and let that regenerate the frame, the blocking and the camera, or the next hole stays open.
- **If re-deriving reveals the `action` itself has drifted from the project, that's a direction revision** — raise it with the human (`drafting-guide`), don't quietly redefine it.

## Pitfalls

- **Deciding the camera in `video.tsx`** — the board is where a camera move is reviewed.
