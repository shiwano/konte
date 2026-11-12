import type { DirectionErrorCode } from "../direction.js";
import { VIEWS } from "../view.js";

const ASSET_NAME = "a-z, A-Z, 0-9, -, _";
const VIEW_LIST = VIEWS.map((v) => `"${v}"`).join(", ");

export const DIRECTION_ERROR_REMEDY: Record<DirectionErrorCode, string> = {
  "direction-missing": "declare the video's direction (lens + shots) in `direction.ts`",
  "empty-direction": "declare at least one shot",
  "duplicate-id": "give every sequence and shot its own id",
  "unknown-lens": "name a built-in lens or one declared in `lenses`",
  "payoff-not-in-roles": "set the lens's `payoff` to one of its roles",
  "payoff-function-mismatch": "set the lens's `payoff` to a payoff-function role",
  "empty-roles": "declare at least one role on the lens",
  "invalid-share":
    "set `minShare` / `maxShare` to fractions in [0, 1], `minShare` no greater than `maxShare`",
  "character-invalid-id": `rename the character to a valid asset name (${ASSET_NAME})`,
  "character-empty-name": "give the character a non-empty `name`",
  "character-empty-description": "give the character a non-empty `description`",
  "character-empty-prompt-depiction":
    "declare a `promptDepiction`: a noun the model can draw them by (a role or a proper name " +
    "is one it has no look for)",
  "character-voice-invalid-id": `rename the voice to a valid asset name (${ASSET_NAME})`,
  "character-voice-empty-description":
    "say in the voice's `description` how it sounds (sex, age, timbre, pace), or drop the voice",
  "narrator-invalid-id": `rename the narrator's voice to a valid asset name (${ASSET_NAME})`,
  "narrator-empty-description":
    "say in the narrator's `description` how it sounds (sex, age, timbre, pace), or drop the " +
    "narrator",
  "prop-invalid-id": `rename the prop to a valid asset name (${ASSET_NAME})`,
  "prop-empty-name": "give the prop a non-empty `name`",
  "prop-empty-description": "give the prop a non-empty `description`",
  "prop-empty-prompt-depiction": "declare a `promptDepiction`: a noun the model can draw it by",
  "location-invalid-id": `rename the location to a valid asset name (${ASSET_NAME}) other than \`view\``,
  "location-empty-name": "give the location a non-empty `name`",
  "location-empty-description": "give the location a non-empty `description`",
  "location-empty": "declare at least one location",
  "landmarks-empty": "declare the location's `landmarks`: what only this place has",
  "landmark-invalid-id": `rename the landmark to a valid identifier (${ASSET_NAME})`,
  "landmark-empty-name": "give the landmark a non-empty `name`",
  "landmark-empty-description":
    "say in the landmark's `description` where it stands and what it looks like",
  "landmark-empty-prompt-depiction": "declare a `promptDepiction`: a noun the model can draw it by",
  "landmark-id-conflict":
    "give the landmark an id no character, prop, location or other place's landmark uses",
  "prompt-depiction-conflict": "give each a `promptDepiction` neither contains",
  "setup-invalid-id": `rename the setup to a valid asset name (${ASSET_NAME})`,
  "setup-empty-name": "give the setup a non-empty `name`",
  "setup-empty-description": "give the setup a non-empty `description`",
  "setup-empty": "declare at least one setup",
  "setup-unknown": "name a declared setup, or declare it in `setups`",
  "setup-unknown-location": "set the setup's `location` to a declared location",
  "holds-empty":
    "name in `holds` the landmarks of the setup's location the frame carries, left to right",
  "holds-unknown-id": "name in `holds` only landmarks of the setup's location",
  "within-undeclared":
    "the setup could be a step in from a wider frame of the same place holding what it holds. " +
    'Say which: `within: "<id>"` for the frame it steps in from, or `within: null` if it is ' +
    "the root of its own camera axis",
  "within-impossible":
    "point `within` at a declared, strictly wider frame of the same place (wide, then medium, " +
    "then close), or drop it; an insert is off the axis and takes no `within`",
  "within-cyclic": "end the `within` chain at a root (`within: null`)",
  "view-missing":
    "declare `view`, the way the camera faces in its location: one of " +
    `${VIEW_LIST} ("front" is the way reference.<locationId> faces)`,
  "view-on-window": "drop the `view` — a window faces the way the frame it is cut from does",
  "view-unknown": `set \`view\` to one of ${VIEW_LIST}`,
  "reference-id-conflict":
    "give each its own id — characters, props, locations and cast voices share `reference:<id>`",
  "script-empty-text":
    "write the line's words, or drop the line; say in an `acting` note how it is said, or drop " +
    "the note",
  "script-unknown-character": "attribute the line to a declared character",
  "telop-empty-text": "write the telop entry's text, or drop the entry",
  "aside-empty-label": "name in `label` what occupies the clock here",
  "lineup-missing":
    "state in `lineup` who the frame holds, left to right; write `[]` where it holds no one",
  "lineup-unknown-id":
    "line up only declared characters; a prop the frame shows goes in its `props`",
  "lineup-duplicate": "list each subject once",
  "passing-overlap":
    "drop the subject from `passing` or from the endpoint lineup — a passer is absent at both ends",
  "props-missing": "state in `props` the props the frame shows; write `[]` where it shows none",
  "props-unknown-id": "name only declared `props` ids",
  "props-duplicate": "list each prop once",
  "join-undeclared":
    'say in the `join` what the boundary is: "continuous" for one unbroken take, ' +
    '"jump-forward" for a jump cut or a gap in story time, "jump-back" into a flashback',
  "join-impossible":
    "`continuous` runs one take on from the frame before, on the same setup. Drop it, or " +
    "declare a jump; a hold that moves is written as two panels inside one shot",
  "coverage-overdeclared":
    "drop the field — a coverage shot declares only its opening `setup` and `lineup`",
  "shot-span-mismatch":
    "declare the shot's span in the policy's unit alone: `beats` with `policy.song`, " +
    "`duration` in seconds without",
  "lyrics-without-song": "declare the song in `policy.song`, or drop the `lyrics`",
  "lyrics-singer-unknown": "name a declared character as the singer",
  "lyrics-singer-empty": "name at least one singer, on the line or its section",
  "lyrics-empty-line": "write what is sung, or drop the line",
};
