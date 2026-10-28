---
name: staging-guide
description: Stage a shot's frame, cut and motion from its action, and build its plates. Read before a shot's prompt or panel blocking/camera, when wiring plates or fixing a plate, landmark or keyframe-input finding, and for feedback about what the frame or movement conveys.
user-invocable: false
---

Stage each shot's frame, cut and motion from its `action`; done = the read-test below passes and the panel's movement is written from its take. Prompt wording belongs to `prompt-guide`.

## Routing

- Building or using location masters or setup plates, or fixing related findings → [plates.md](references/plates.md).
- Changing a setup, lineup, join or cutin → `direction-guide`.

## Where the movement lives

- Stage against the direction's `action` — never restate it; there is no separate audio goal.
- Every panel declares the movement out of it — `blocking` and `camera`, across the span to the next keyframe; a key, the shot's whole movement. A multi-panel shot's landing frame declares neither, except at a continuous seam.
- Write it from the take — settle the panel's take first, then write the transit the `action` needs from that frame; if the take can't launch it, the take is wrong, not the shot.
- Rewriting it after the panel's accept needs no review — the take is untouched.
- Only the transit — a keyframe fixes a position, never a direction through it; what the pair already shows does not belong in these fields.
- Write both in the `brief`'s working language, whatever the prompts use.

## Split blocking from camera by who moved

- `blocking` is the subject's movement — where it goes, how, and the frame edge it enters or leaves by; the next shot's entrance has to agree with that edge.
- `camera` is the camera's; state `"fixed"` — an omitted `camera` reads as unbound. Write both together.
- A subject that leaves frame because the camera moved off it is `camera` — the next shot inherits no screen direction from it.

## Stage the frame

- The plate fixes the place and the camera; the panel prompt composes — where each figure sits and faces, what fills the frame they leave open, what is nearest the lens, what the edges cut, chosen from what the `action` has to show. Naming only who is left and right leaves the frame to the model.
- Each panel prompt writes one state of the `action` — the opening frame its starting state, a landing frame its final state, a key the moment the shot reads, a change landed.
- Make the setup's `framing` concrete — within the frame its plate holds, write the subject's crop or share of the image: "waist-up", "her head fills a third of the frame's height".
- The eye lands on the action's carrier — whatever the shot hinges on must be the frame's most salient element (position, contrast, light, motion); if a stranger's eye goes elsewhere first, the staging failed before the prompt.
- One strong signifier per idea — pick the element that says it best and cut action-adjacent extras; each one added dilutes the read.
- Subject & purpose — what the subject wants in this shot decides pose, expression, and gaze. Name a declared character or prop by its exact roster `promptDepiction` and anchor its look on the `reference:<id>` asset (identity prose → `prompt-guide`'s reference preflight).
- Make the performance readable at the shot's scale — a close frame can carry a glance or a tightened mouth; a distant figure needs posture, weight, hands or distance from the other subject to carry the same intention.
- Name every subject in `ctx.lineup` order — who the frame holds, left to right, is the direction's (`ctx.lineupTo` the order the shot leaves on); one named place lands nothing, all of them always lands. Add who is nearer the lens where they are not side by side.
- Pass a reference image for every one of them — a subject only a sleeve or a fist of whom is in frame is fed too, never waived. A keyframe drawn from an earlier keyframe inherits what that one stood on.
- Pass them in the same order — the slot order is the other half of what decides who lands where.
- `<Cutin>` keyframes answer `ctx.cutin.lineup` / `lineupTo` by the rules above and stand on that setup's plate.
- `ctx.lineupTo` is a `blocking` note waiting to be written — the panel it changes out of says the move (`blocking`, above) and the last keyframe's slots take the new order.
- Size and angle come from the shot's `setup` — change either by editing the setup. Low angle empowers, high diminishes, eye level observes — pick from the `action` and write it into the setup's `description`, so the next shot on it inherits the camera.
- Every panel prompt names the camera's height and angle — only the ones its plate has.
- Say where each figure meets the floor — otherwise a keyframe on a plate comes back with the figures pasted in front of it. Further from the lens: feet higher in the frame, figure smaller.
- A state the story changes is one `reference:` asset per state, each built from text — a window before and after it breaks is two; a page blank, scribbled, then washed is three. Feed each where shown: prose redraws the state every take.
- Count the states before the reference review — a reference accepted in one state a later shot contradicts stales every panel built on it.
- At `close`, anchor the subject and let the set fall to suggestion — shallow depth of field, one sliver of set behind carrying the setup's `holds`: it owes the location its material and light, and owes it no layout. `insert` holds nothing — it fills the frame with an object and shows no set.
- Keep the set quiet — only what the shot reads against; every extra prop is background churn for motion to fail on. Keep the master sparse; dress a shot's prop in its panel.
- The pose reads in silhouette — illegible as a black shape, no lighting or detail saves it; pick the angle that opens the pose.
- Build depth in layers — foreground, subject and background give motion somewhere to travel. Write their overlaps without obscuring the detail that carries the action; name a gaze's target just off-frame where it belongs.

## Stage the cut

- Eyelines, screen direction and edges bind every cut, shown geography or not — the 180° line, gaze axes, the entrance/exit directions the `action` implies, and wardrobe/props agreeing across adjacent same-space shots. A journey "toward" something holds one direction across every panel and shot.
- The 180° line is checked between two shots in one place — a single subject re-framed from the other side settles no pair, so it is yours to catch.
- Matching backgrounds is owed only where two frames share geography on screen (a continuous-space stretch, a re-established `wide`) — there, pin the look on a `reference.tsx` asset and compare the adjacent panels at the board before paying for motion.
- Change two of size / angle / subject on every cut — unless a match cut is the point; a cut that changes only one reads as a jump, and cutting back to one setup without a shot between flattens the sequence.
- The edit base chooses the camera — a keyframe edited from a neighbouring shot's populated frame inherits its composition whatever the prompt says. Chain off a neighbour only for a match cut; otherwise start from the setup's plate, else `reference:<location>`. At a `join: "continuous"` seam, keep the camera of the panel before it.
- A long take has one frame at its seam, and it is the next shot's first panel — `join: "continuous"`: the shot before authors no closing keyframe; its last panel carries `blocking` / `camera` like any other. Nothing is passed on the board.
- A cut along one `within` axis takes the frame before it — two setups of one axis, no join written: the previous shot's last panel goes in one of the keyframe's image inputs (a cutin's: the last panel of the cutin before it), for a model that reads it as the frame the cut comes from (`readsPrevPanel` in `konte adapter show`). The plate fixes the room, that panel the subject's light, size and position; a cut between two lineups sharing no subject owes none. `panel-unlinked` gates it; a cut meant to re-open the frame is the waiver.
- Save the strongest staging for the payoff — the lens's payoff role gets the most distinct frame in the piece; spending it on a setup role upstages the climax.
- Name light source and time of day per shot — anchors within a scene, an arc across the piece; unnamed light drifts per generation.

## Stage the motion

- An `action` that needs two motions is a direction fix, never a longer prompt.
- A motion shot is a visible change — fix what the clip's first and last moments each read as; if they read the same, the shot didn't happen. A near-still shot is chosen up front in the panel's `camera`/`blocking`, never rationalized after a quiet clip comes back.
- An opening panel stages the loaded instant before the action, never the peak — or the shot has nowhere to move. A change too long for the shot at real speed (a two-beat grin) opens mid-motion.
- Audio is staging too — a one-shot `<Audio>` lands on a visible action frame (name which); a `soundtrack()` bed states a mood the picture already earns (placement → `composition-guide`). Sound or a telop never rescues an unreadable picture — fix the staging.

## Stage for the generator

- A capability limit is one model's, written in the `## Avoid` section of `.konte/guides/<model>.md` (`konte adapter show <adapter>`). Read it at routing time; never stage around a general belief about what generation can't hold.
- Restage, don't caveat — where the guide names a limit, keep the shot and shrink what must move; prompt-side warnings ("smooth motion") fix nothing.
- Withhold an event through a reaction, sound or aftermath when that carries the shot more clearly.
- Crop the choreography — a tighter setup (`close`/`insert`) keeps only the load-bearing part moving in frame.
- One mover per shot — subject or camera, never both large at once; a slow push, pan, or tilt over stable staging reads as motion on its own.
- A charged hold is still an action — only breath, hair or light moving.
- Spend the risk on the payoff — a shot that may take many rerolls earns them where the piece lands; alternate closes, inserts and charged holds for the setups.

## Read-test before you pay to generate

- Describe first, compare second — before generation, reconstruct the frame from its prompt and input images; after, describe the actual panel. Then compare with the `action`: a detail supplied only by knowing the story is missing from the frame.
- Name the one axis the `action` cannot misread (arriving vs leaving), then ask whether a zero-context viewer could land on the wrong side. If so, fix the staging, not the prompt words.

## On a staging note, re-derive the whole staging

- The note names a symptom — re-ask what the `action` needs and regenerate the frame, the blocking and the camera from it, or the next hole stays open.
- An `action` that has drifted from the project is a direction revision — raise it with the human (`drafting-guide`); never quietly redefine it.

## Pitfalls

- Deciding the camera in `video.tsx` — the board is where a camera move is reviewed.
