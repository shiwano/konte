export type KonteErrorCode =
  | "INVALID_ADDRESS"
  | "ADDRESS_NOT_FOUND"
  | "LOAD_FAILED"
  | "VALIDATION_FAILED"
  | "CYCLE_DETECTED"
  | "INVALID_REFERENCE"
  | "INVALID_REFERENCE_DEPENDENCY"
  | "DOWNLOAD_FAILED"
  // A downloaded managed-tool artifact does not match its pinned SHA-256.
  | "CHECKSUM_MISMATCH"
  // A managed-tool URL with no entry in the checksum manifest — a bumped pin or a new platform.
  | "CHECKSUM_UNKNOWN"
  | "STATE_NOT_FOUND"
  | "STATE_ALREADY_EXISTS"
  | "STATE_WRITE_FAILED"
  | "STATE_READ_FAILED"
  | "VARIANT_NOT_FOUND"
  // An absent variant: in state, but its media is not in this checkout (git never tracked it).
  | "VARIANT_ABSENT"
  | "VARIANT_NOT_ACCEPTED"
  // `konte dismiss` was pointed at the accepted take.
  | "VARIANT_ACCEPTED"
  // `konte dismiss --off` was pointed at a take carrying no dismissal to lift.
  | "VARIANT_NOT_DISMISSED"
  // A take handed to a command that only takes review candidates (see variant-lineage).
  | "VARIANT_NOT_REVIEWABLE"
  | "VARIANT_AMBIGUOUS"
  // Several targets handed to one command that cannot be decided together — two takes of one
  // address, or a target decided only on its own.
  | "TARGETS_CONFLICT"
  | "ASSET_NOT_FOUND"
  | "ADAPTER_NOT_FOUND"
  | "GENERATION_FAILED"
  | "SUBMISSION_UNCONFIRMED"
  | "JOB_NOT_FOUND"
  | "COMFYUI_ERROR"
  | "COMFYUI_JOB_GONE"
  | "COMFYUI_JOB_ORPHANED"
  | "COMFYUI_UNAVAILABLE"
  | "COMFYUI_UNAUTHORIZED"
  | "COMFYUI_WS_UNAVAILABLE"
  | "COMFYUI_MANAGER_UNAVAILABLE"
  | "COMFY_NODE_RESTART_REQUIRED"
  | "MISSING_TOKEN"
  | "WORKFLOW_NOT_FOUND"
  | "WORKFLOW_INVALID"
  | "INVALID_ASSET_TYPE"
  | "MISSING_REQUIRED_INPUT"
  // A set of inputs each individually well-typed that the adapter rejects together — a constraint
  // only the model knows, checked by the adapter's own `validators`. MISSING_REQUIRED_INPUT's
  // counterpart for what konte's schema cannot express.
  | "INVALID_ADAPTER_INPUT"
  // An adapter that names the sites it may be declared in (`allowedIn`) was called from another
  // one — an edit model in a shot, which has no take for it to work on.
  | "ADAPTER_OUT_OF_SCOPE"
  | "DELIVERY_NOT_REROLLABLE"
  // A reroll was pointed at a deterministic asset: the same inputs give the same output, so there
  // is no alternative to pick. `generate` is what re-bakes one.
  | "DETERMINISTIC_NOT_REROLLABLE"
  // A `dismiss` was pointed at a deterministic asset: it has one outcome, so there is no other take
  // to decide for. The correction is an edit to its definition.
  | "DETERMINISTIC_NOT_DISMISSABLE"
  | "PATCH_NOT_FOUND"
  | "PATCH_ALREADY_EXISTS"
  | "PATCH_ALREADY_APPLYING"
  | "PATCH_SOURCE_MISSING"
  // A patch's source is an absent variant (see VARIANT_ABSENT).
  | "PATCH_SOURCE_ABSENT"
  | "PATCH_SOURCE_NOT_READY"
  | "PATCH_INVALID"
  | "PATCH_TARGET_INVALID"
  | "DEPENDENCY_NOT_RESOLVED"
  | "DEPENDENCY_DEAD"
  | "JOB_NOT_CANCELLABLE"
  | "LOG_NOT_FOUND"
  | "RENDER_PLAN_FAILED"
  | "FFMPEG_ERROR"
  | "FFMPEG_NOT_FOUND"
  | "SHOT_NOT_FOUND"
  | "NO_RENDERABLE_ASSET"
  | "NO_EXPORT_FOUND"
  | "UNACCEPTED_ASSETS"
  | "PENDING_SHOTS"
  | "CHARACTER_ACCEPTANCE_REQUIRED"
  | "VOICE_ACCEPTANCE_REQUIRED"
  | "INVALID_TIMECODE"
  | "HYPERFRAMES_NOT_FOUND"
  | "HYPERFRAMES_ERROR"
  | "SRT_PARSE_ERROR"
  | "CHROMIUM_SETUP_FAILED"
  | "TSC_SETUP_FAILED"
  | "TYPE_CHECK_FAILED"
  | "DIRECTION_LANG_INVALID"
  | "DIRECTION_CHECK_FAILED"
  // A `"prompt"` input about to be spent on still names an exclusion (or the stage waives a finding
  // that no longer exists). The direction gate's twin one layer down: text, checked before spend.
  | "PROMPT_CHECK_FAILED"
  // A `pin` input about to be spent on is wired to something that is not a frame of the picture —
  // a reference sheet, a plate. The prompt check's twin over wiring rather than text.
  | "PIN_CHECK_FAILED"
  | "DIRECTION_ACCEPTANCE_REQUIRED"
  // `konte accept --off` was pointed at a direction part carrying no sign-off to clear. The variant
  // path's VARIANT_NOT_ACCEPTED, for the stage that has no variants.
  | "DIRECTION_PART_NOT_ACCEPTED"
  // A developed animatic shot whose composition declares no `<Panel>`. A board shot IS its
  // keyframes; a plain `<Image>` is a layer.
  | "PANEL_REQUIRED"
  // A shot over a shot whose direction declares a `cutin`, rendering no `<Cutin>` — and its twin, a
  // `<Cutin>` (or a second one) on a shot that declares none. The wipe's frame is what the staging
  // checks read, so a composition and its direction must agree on whether there is one.
  | "CUTIN_REQUIRED"
  | "CUTIN_UNDECLARED"
  // An `animatic.tsx` `plates` block that does not file its plates by roster id — a key naming no
  // declared setup, or an asset declared there and not returned as one.
  | "INVALID_PLATE"
  // A `respell()` that names no line the direction wrote, or that hands over a blank spelling.
  | "INVALID_RESPELL"
  // A shot the direction gives spoken lines to whose animatic shot plays no audio. Without a voice
  // take the piece comes out silent, with no failure until it is watched.
  | "DUCK_INVALID"
  | "SCRIPT_UNVOICED"
  // A board shot with a narration line no readable take carries, and a recording konte reads no
  // words from beside it: that recording may be the narration or a sound in the frame, and the two
  // go to different stems. Or one take saying both a narration and another line.
  | "NARRATION_UNATTRIBUTED"
  // A board shot's `#narrationStem` that no developed `video.tsx` shot places with `<Audio>`.
  | "NARRATION_UNPLACED"
  // An `animatic` that is not one: a `<Video>` inside it (a surface to draw motion on would route
  // around the gate), a top level that is not a `<Composition>`, a name it and the `build` both
  // declare, a `.stem` / `.narrationStem` reference when there is none, a `.narrationStem` placed
  // anywhere but an `<Audio>`, or `animatic.shot()` called outside a build.
  | "ANIMATIC_INVALID"
  // An `<Animate script>` whose source cannot be embedded. It is serialized and wrapped as
  // `(<source>)(…)`, so a form that is not a standalone expression leaves the whole <script>
  // unparseable — nothing in it runs, the timeline registration included.
  | "ANIMATE_SCRIPT_INVALID"
  // An animatic cue that ends past the shot it sounds over. The stem is clamped to the shot, so the
  // tail is cut — a line lost mid-word, with nothing to show for it until the mix is heard. Read
  // from the declared clip length, so it is refused before the take is paid for.
  | "CUE_OVERRUNS_SHOT"
  // An animatic cue whose clip konte sized from the words and had to narrow to under half of what
  // the words take to say, lead-in aside, to fit the window after its start. The take comes back
  // rushed or clipped.
  | "CUE_WINDOW_TOO_SHORT"
  // A `volume` outside 0–MAX_AUDIO_GAIN on an <Audio>, <Video> or soundtrack().
  // The preview would clamp it and the mux would not, so it is refused before either sees it.
  | "AUDIO_GAIN_INVALID"
  // An `audioRetime` whose target `duration` moves the take further than a voice carries unheard,
  // with no `waiver` declared.
  | "RETIME_RATE_EXCEEDED"
  | "FONT_FAMILY_INVALID"
  // A spend builds on an `animatic:` address no human has accepted — the board is reviewed before
  // motion is spent on it. Also reroll's counterpart to the per-asset skip `generate` reports.
  | "ANIMATIC_ACCEPTANCE_REQUIRED"
  // A video shot that generates something and builds it on nothing from the board it develops. The
  // gate above only reaches what a spend consumes, so such a shot would route around it entirely.
  | "ANIMATIC_UNCONSUMED"
  // The same gate one stage up: a spend consumes a `reference:` asset no human has accepted. A
  // sheet is what every downstream take derives its identity from, so it is settled before anything
  // is built on it — never implicitly, by whatever consumed it first.
  | "REFERENCE_ACCEPTANCE_REQUIRED"
  | "REVIEW_PREREQUISITE_MISSING"
  | "BACKEND_NOT_CONFIGURED"
  | "DELIVERY_UPSCALE_REQUIRED"
  | "NOT_A_KONTE_WORKSPACE"
  | "WORKSPACE_ALREADY_EXISTS"
  | "INVALID_AGENT_SETTINGS"
  | "VIDEO_NOT_SELECTED"
  | "VIDEO_NOT_FOUND"
  | "VIDEO_ALREADY_EXISTS"
  | "INVALID_VIDEO_NAME"
  | "WORKFLOW_IMPORT_FAILED"
  | "FAL_ERROR"
  | "FAL_UNAVAILABLE"
  | "FAL_AUTH_MISSING"
  | "FAL_UPLOAD_FAILED"
  | "GIT_ERROR"
  | "LOCK_TIMEOUT"
  | "COMPOSITION_BUILD_FAILED"
  // Rendered markup carries a class Tailwind generates nothing for, or one setting a font family.
  | "COMPOSITION_CLASS_INVALID"
  | "FRAME_CAPTURE_FAILED"
  | "FFMPEG_SETUP_FAILED"
  | "FFPROBE_NOT_FOUND"
  | "FFPROBE_ERROR"
  | "FFPROBE_SETUP_FAILED"
  | "ANIMATIC_NOT_FOUND"
  | "REFERENCE_NOT_FOUND"
  | "ANIMATIC_LOAD_FAILED"
  | "CROSS_STAGE_REFERENCE_ERROR"
  | "FEEDBACK_NOT_FOUND"
  | "FEEDBACK_WRITE_FAILED"
  | "REVIEW_NOT_FOUND"
  | "EXPORT_FAILED"
  | "INVALID_CWD"
  | "INVALID_OPTION"
  | "PORT_IN_USE"
  | "CLOUDFLARED_SETUP_FAILED"
  | "TUNNEL_FAILED"
  | "CREDENTIALS_UNREADABLE"
  | "CONFIRMATION_REQUIRED"
  | "INVALID_TEMPLATE"
  | "TEMPLATE_REQUIRED";

export class KonteError extends Error {
  readonly code: KonteErrorCode;
  constructor(code: KonteErrorCode, message: string) {
    super(message);
    this.name = "KonteError";
    this.code = code;
  }
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
