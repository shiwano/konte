# MiniMax H3 — Picture

What a decoded frame reads from the prompt.

## Frames

- **A picture used as a frame gets the frame phrasing** — `the shot begins from <Picture 1>`, `the shot's keyframe corresponds to <Picture 2>`, `the shot ends on <Picture 3>`, and `keyframe completion` in the task type. A panel that plans the shot rather than filling a frame says so instead: `<Picture 3> is an animatic reference for [Shot 1] and [Shot 2], defining their viewpoint, subject placement, and shot order.`
- **A passed frame fixes the camera as well as the content.** Its height and axis carry into the take, and prose rarely overrides them — writing "much closer, held level with his face" moves the distance and leaves the borrowed downward angle. Pass **the frame whose camera you want**: the wide a push-in cuts from hands over its own distance, so the push-in never lands.
- **A populated frame with no slot wins the frame** — a neighbouring panel passed as a bare `<Picture N>` brings its own framing and pose over the plate's. The frame anchor is the empty plate; a panel goes in only as a frame the description names by shot.
- **A plate passed `fully_preserved` locks its framing** — prose in any shot asking for a closer view or a narrower space is ignored. To take a frame the plate does not hold, mark it `attribute_transfer`: its setting, materials and light carried onto a new camera position, the framing new.

## Pose and Placement

- **A pose is read joint by joint, and only there** — "pitched forward with the momentum of his run" comes back standing still; "the thigh angled backward toward image-right, the knee sharply bent, and the heel kicked up high behind him" comes back mid-leap.
- **A state word renders nothing** — "she looks anxious" comes back neutral. Write what a camera would see: where the eyes go, what the hands close on, what the shoulders do, what stays still.
- **The parts run in one fixed order** — camera angle, torso, head, arms, legs, framing. One clause a limb: the upper arm's or thigh's direction, the elbow's or knee's bend, where the hand or foot ends up.
- **Angles are coarse words** — `nearly vertical`, `nearly horizontal`, `nearly straight`, `sharply bent`, `nearly level`, `angled downward toward image-left`.
- **A prop of several parts is read along its length** — what comes first from one end of the frame, what follows it, and which hand closes on which part: the scabbard in one fist at the lower right, the bare blade leaving its mouth, the guard, then the hilt in the other fist. "Drawing his sword" comes back with two swords.
- **An amount that does not show in silhouette is not rendered** — "drawn a hand's width" comes back sheathed or fully drawn. Ask for the state the frame reads at a glance.

## On-Screen Text

A banner, sign, label, subtitle or neon that is actually legible in frame goes in English double quotes, verbatim and untranslated: `A red neon sign reading "営業中" glows above the doorway.` Name its face and its place in frame: `condensed`, `all-caps`, `serif`, `tracked wide`; `centred`, `lower third`.

## Canvas

- **The trained size is a 768 short edge, ~1MP (768×1344)** — well above that, structure repeats.
