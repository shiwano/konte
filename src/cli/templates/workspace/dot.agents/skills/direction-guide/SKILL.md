---
name: direction-guide
description: Author direction.ts — brief, rosters, camera setups, role structure and pacing; resolve direction findings. Read before proposing or writing shots, or changing their order, duration or setup.
user-invocable: false
---

**Author** the video's direction in `direction.ts` before any stage shot is written. Done = `konte status` reports no unresolved direction finding; not the generated media's review.

## Routing

- **Declaring characters, props, locations or voices** → [rosters.md](references/rosters.md).
- **Declaring camera setups** → [camera.md](references/camera.md).
- **Declaring who is in frame, a join or a cutin** → [lineup.md](references/lineup.md).
- **A piece long enough for acts** (several minutes up) → [long-form.md](references/long-form.md).
- **A piece cut to a song** — `policy.song`, `lyrics`, spans in beats → [song.md](references/song.md).

## Authoring the direction

- **Write prose fields in the human's language** — brief, `action`, roster `name`/`description`; `promptDepiction` uses the model's language.

### The brief

- **Keep it short — only what stays true across the piece.** Pacing goes in as _intent_ (cut rhythm, where it builds), not a per-shot second count.
- **`hook` is the first two seconds as one sentence** — what the opening frame puts on screen that stops a scroll: the collision, the prop that will fire, a face wanting something. The first shot's `action` realizes it — a ground role establishes who and where, never calm before anything happens.
- **`look` names the medium first** — live action, anime, 3DCG, stop motion — then palette, framing, cut rhythm.
- **`tolerances` — a flaw the whole piece will carry** (a brand mark that wanders into frame, unreadable fine text), agreed like any other field. "This take is fine, move on" is an accept.

### Shape

- **A worked file with the common fields** — [skeleton.md](references/skeleton.md).
- **One `sequence` node — `lens`, `pleasure`, `shots[]`** — the shots in order; the stages mint shots from these ids.
- **Pick each shot's kind:**
  - a character in frame → narrative (default)
  - a screen, chart or motion graphic → `kind: "graphic"` — an arc shot with no camera; a character over it enters by `cutin`
  - not story (title card, eyecatch, OP/ED) → `kind: "aside"` — a span and a `label`; arc and pacing checks skip it, the animatic never boards it
- **`setup` is the frame the shot is taken from** — a `setups` roster id; its size and its place are read through it.
- **Author `format.size` as `{ megapixels, delivery: { width, height } }`** — delivery sets the aspect; konte derives a 32-grid canvas from the pixel budget (`0.9` at 16:9 → `1248×704`). Lower `megapixels` for cheaper iteration; a delivery well above the canvas needs `export.delivery.upscale`. Start with `fps: 24`; adapter grids govern generated frame counts.
- **`fonts` are Google Fonts families in fallback order** — text placement → `composition-guide`.
- **`speech` is `"none"`, `"no-dialogue"` or `"free"`** — no lines, narration only, or unrestricted speech.
- **`script` holds spoken lines; `telop` holds unspoken screen text; `lyrics` holds sung words** — a sung line shown on screen is in `lyrics` alone; a sign inside the world belongs in the image prompt. Stages receive `script` from the direction; notation for Japanese → [japanese-notation.md](references/japanese-notation.md).
- **A character line requires one `acting` sentence** — how it is said ("wheedling, drawn out, a shade too loud"), never a list of acoustic properties.

### The arc

- **The lens fixes the role order (its payoff role is the climax); `pleasure` names the feeling it aims for** — pick each from the catalogs in [lenses.md](references/lenses.md); `pleasure` is a closed vocabulary, a custom `defineLens` a last resort (rules there too).
- **A building role must actually repeat** — `rhythm` and `process` each need at least two consecutive, varied shots (a copy is not variation); `comedy`'s optional `escalation` escalates across shots rather than holding one.
- **Write the hinge roles as a change, and earn the climax** — on a **turn** (`disruption`/`violation`/`solution` — the **inciting incident** at this scale) and the **payoff**, the `action` must state a change of state: name the two concrete, visible states it moves between ("the calm sill; the ball rolls in").

### Writing the shots

- **Write an action's relied-on landmark or prop with its exact roster `name`.**

- **One action per shot — one sentence, one mover, one motion** — a second sentence, a second mover, or a then-pivot is the next shot's `action`. Test: **if it splits into two sentences that each still stage something, it's two shots**. A role is a phase, not a shot count — expect the shot list to outnumber the lens's roles.
- **A gag or turn is a shot chain, never one shot** — trigger → reaction (→ collateral): the thing that moves (the rolling tureen) gets its own shot before the subject responds, and the reaction shot is often the stronger one. Expand the chain as you draft, never as a later split of one row.
- **A key action is a chain too — never one take** — anticipation, the motion elided in the cut, the result landed; this and the other idioms are [cut-idioms.md](references/cut-idioms.md).
- **Keep one ledger of the world's state** — where each character is, what they hold, what broke: damage never resets. A state may change in the cut — the next shot's opening just has to make it read (an aftermath `insert`, a sound, the prop now in hand); only a continuous-space stretch owes each transit a shot of its own.
- **Constructive space is the default** — build the space in the viewer's head from fragments (`medium`/`close`/`insert` glued by eyelines, screen direction, and recurring anchors): geography never shown whole is never asked to match, the grammar generation holds best.
- **Continuity is the marked spend** — one connected space, cause and effect crossing frames, every transit on screen; choose it only when the physical path _is_ the content (a chase, the tureen rolling for the rail), since it binds backgrounds and direction across every cut it spans.
- **A montage** (`escalation`, `rhythm`, `pressure`) juxtaposes parallel instances of one idea — the Kuleshov effect supplies the link (three unconnected shots of havoc read as "chaos grows"); an invented physical link is contrived and the hardest thing to stage. It still varies and ascends to the peak, and the ledger holds through it.
- **The direction check covers structure, not the frame** — on-screen legibility is yours: a _visible_ `pressure` (a queue, a timer), a payoff you read at a glance, a shot's movement legible on its own.

## Clearing direction findings

- **Run `konte status`** — each finding carries a cause and a waiver key in `[brackets]`. Roster and setup findings are deferred until direction acceptance.
- **Role, pacing, or roster declaration finding** → fix the named field; an unused roster entry must be used or removed.
- **Missing reference asset** → `authoring-guide`; expose the named roster id in `reference.tsx`.
- **Plate, landmark, keyframe input or prompt finding** → `staging-guide`; fix the named animatic asset; `passer-unconsumed` / `passer-unnamed` name a video take.
- **Deliberate structural exception** → copy the bracketed key into the direction's top-level `waivers` with a reason. Never waive a fixable defect; remove stale waivers reported by status.

## Pacing — rhythm, not uniform length

- **A shot's span is the window the render cuts the take to** — use the adapter's supported length and let the window cut it.
- **A cut's pleasure lives in the _contrast_ between shot lengths** — equal-length cuts read as a metronome: choose each length against its neighbors — staccato shots build pressure, a held frame releases; accelerate into a peak, ease after.
- **`wide` is a spend — establish once per act, when the space itself is content.**
- **Vary the framing size against its neighbors** — hold `medium`, push to `close`/`insert` before a payoff. A gag/turn's trigger is often an `insert`/`close`, its reaction a `close`.
- **A one-step size change inside one `location` invites background matching** — adjacent `wide`→`medium` (or `medium`→`close`) keeps most of the set in both frames, a match generation can't hold: jump two sizes (`wide`→`close`/`insert`), break the pair with an `insert` or a reaction shot, or, when the match _is_ the cut (an axial punch-in), declare the pair on one camera axis with `within`.
- **A held, low-change frame holds attention ~3s; earn a longer hold with change** — motion, an `<Animate>` move, or an overlay reveal buys seconds, and what dulls tempo is a frame held past its content. A comedy `button` cuts on the laugh, never past it.
- **Each shot advances the feeling, never restates it** — a long fight or a montage that repeats one shot is one motif stretched thin.
