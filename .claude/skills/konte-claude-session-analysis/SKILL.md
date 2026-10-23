---
name: konte-claude-session-analysis
description: Analyze a real Claude Code session transcript — where its context went, which guides actually loaded, where the CLI tripped the agent, and what the video's reviews say about its quality. Use to interpret /context output, validate a JOURNEY, diagnose a routing miss, or find what to improve in konte from a production session.
user-invocable: true
argument-hint: "[workspace-path]"
---

Done when every number is attributed to a real consumer from the transcript, each konte design signal and CLI failure names the command it implicates, and the video's quality findings are reported per `quality-analysis-guide`.

## 0. First rule — `/context` names sizes, not causes

- `Read results N tokens (M%)` is carrying cost — `result tokens × requests it persists through`, so one early image read reports as millions. Never conclude re-reads from it; prove them in §4.
- Every `/context` figure is a hypothesis until confirmed against the transcript.

## 1. Locate the transcript

```sh
D="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/projects/$(echo "$WORKSPACE" | tr '/.' '--')"
ls -laS "$D"/*.jsonl   # newest/largest = the session; T=<pick one>
```

- A `konte-checkin`→export session lives under the user workspace path (`my-video`), even when asked from the konte repo.

## 2. Transcript shape — the non-obvious parts

- `.thinking` is empty, but `usage.output_tokens_details.thinking_tokens` counts it. An assistant message spans several lines sharing one `message.id`, each repeating `usage` — count one per id.
- Images are stored twice — in `message.content[]` and `toolUseResult`. Count only `tool_result` blocks.
- Byte size ≠ token size — a 20MB transcript is mostly image base64; an image costs ~1.6k tokens regardless of bytes.
- Final context = last assistant's `usage.cache_read_input_tokens + cache_creation_input_tokens` — match it against `/context` to confirm the session.
- `tool_use` lives in `assistant.message.content[]`, `tool_result` in `user.message.content[]`, joined on `id` ↔ `tool_use_id`.

## 3. Measure tool cost

```sh
jq -r 'select(.type=="assistant") | .message.content[]? | select(.type=="tool_use")
  | [.id, .name, ((.input.file_path // .input.command // "") | tostring | gsub("[\n\t]";" "))] | @tsv' "$T" > /tmp/uses.tsv
bun "$SKILL_DIR/context-delta.mjs" "$T" > /tmp/per.tsv   # SKILL_DIR = this skill's base directory
awk -F'\t' '{t[$2]+=$1; n[$2]++} END{for (k in t) printf "%-12s %4d %8.1fk\n", k, n[k], t[k]/1000}' /tmp/per.tsv | sort -k3 -rn
```

- Measure from `usage` — the context added between two requests, minus the first one's output, is what the results between them cost. Characters ÷ 4 undercounts Japanese and box-drawing output.
- Group `/tmp/per.tsv` by consumer — a path or command pattern (a sibling video's files, `.konte/guides/`, `skills/*/references`, one konte subcommand). Parallel calls share their request's delta evenly.

## 4. Prove or kill the re-read hypothesis

```sh
awk -F'\t' '$2=="Read"{print $3}' /tmp/uses.tsv | sort | uniq -c | sort -rn | awk '$1>1'
```

- Empty output = no re-reads. Say so plainly and retract §0's figure as a cause.
- Only a re-read of an unedited file is the signal — cross-check against `$2=="Edit"` paths.
- Group images and text separately — image reads dominate tokens, text reads dominate counts.

## 5. Attribute the whole context

- Final context = first request's context + every added input (§3) + every output (the `out` per request, thinking included). Check the sum against the final context before reporting.
- Split the outputs into thinking (`thinking_tokens`) and the rest — `tool_use` inputs (edits, heredocs, preview `--summary`/`--note`) and assistant text.

## 6. konte design signals

- Defensive truncation — a Bash call piping konte through `head`/`tail`; a high rate = the agent doesn't trust konte's output volume. It counts as a loss only if the limit bit (result lines ≥ the limit); compound `&&` commands inflate the line count.
- Which command bit — attribute every real truncation to its subcommand; one whose length scales with content (human comments) is where truncation costs information.
- Did a truncation hide a warning — before concluding konte failed to say something, check what was cut: a kept footer or suggested command without its block means the warning was printed and dropped.
- Subcommand frequency — `grep -oE '\bkonte [a-z-]+( [a-z-]+)?' /tmp/uses.tsv | sort | uniq -c | sort -rn` shows which loop dominated a real production session.

## 7. Validate the skill JOURNEY against what actually loaded

A `konte-checkin`→export session is the chain `scripts/check-journeys.ts` models as the `video` journey — the only real test of that list.

```sh
jq -r 'select(.type=="assistant") | .message.content[]? | select(.type=="tool_use" and .name=="Skill") | .input.skill' "$T" | sort -u
jq -r 'select(.type=="user") | (.message.content|tostring)' "$T" | grep -oE '<command-name>/[a-z-]+' | sort -u   # slash-invoked; no Skill tool_use
jq -r 'select(.type=="assistant") | .message.content[]? | select(.type=="tool_use") | ((.input.file_path // .input.command // "")|tostring)' "$T" \
  | grep -oE '(\.claude|dot\.agents)/skills/[A-Za-z0-9./_-]+' | sed 's|.*/skills/||' | sort -u   # references, incl. nested per-model docs
```

- Grep nested paths — `references/video/wan-2-2.md` won't match `references/[a-z-]+\.md`; a too-narrow pattern invents "never loaded" findings.
- Grep bare filenames after a `cd` — `cd .../direction-guide/references && cat skeleton.md rosters.md` names no `skills/` path; run `grep -oE '[a-z-]+\.md'` over Bash commands that `cd` into a `references` dir.
- Loaded but not in JOURNEY = a budget hole its tokens escape. Add it and expect the raise, logged as an accounting fix.
- In JOURNEY but never loaded = a routing miss. Never trim the list to match observation — that blesses the miss and drops a guide from the chain.

## 8. Diagnose a routing miss

```sh
grep -c "staging-guide" "$T"                                                    # times the pointer sat in context
jq -r 'select(.type=="assistant")|.message.content[]?|select(.type=="text")|.text' "$T" | grep -c "staging-guide"   # times the agent wrote it
```

- Seen ≫ 0, written 0 = confirmed miss — the agent read the pointer and never followed it.
- The variable is what the pointer hangs on, not its phrasing — pointers tied to an artifact the agent must write (DSL, adapter, prompt, JSX) fire; pointers tied to a judgment it never notices making (fixing intent, choosing a production method) don't. Fix by re-anchoring to the artifact, not by rewording.
- A self-assessed gate never fires — `Intent not yet fixed → read X` asks the agent to detect the very lapse the guide exists to prevent. Make it unconditional.

## 9. CLI friction

```sh
jq -r 'select(.type=="user") | .message.content[]? | select(.type=="tool_result" and .is_error==true)
  | [.tool_use_id, ((.content | tostring)[0:200] | gsub("[\n\t]";" "))] | @tsv' "$T" > /tmp/errors.tsv   # join to /tmp/uses.tsv on id
```

- A rejected tool use is the human's veto, not konte's; an `Exit code` from a compound command may belong to a non-konte part.
- Classify each konte failure: a `KonteErrorCode` refusal, a usage error (wrong flag, address or scope), a crash (stack trace — a konte bug).
- A usage error, or the same subcommand retried with varied arguments → the agent guessed the surface; name what the help text or the refusal should have said.
- A refusal followed at once by the right action is a working gate; one followed by a waiver or a detour → test it against `AGENTS.md`'s three questions.
- The next konte command differs from the previous output's `Next steps` with no stated reason → that line did not fit the state.

## 10. Video quality

Read `quality-analysis-guide`, then run it over the session's video — §3's `/tmp/uses.tsv` is the transcript side of its checks.

## Don't

- Don't propose an `AGENTS.md` line on token grounds — every figure here is <1% of a session. Argue from what the agent does or doesn't know.
- Don't A/B a prompt change on a synthetic read-only task — the behaviors worth measuring only appear in a real long session. Report the base rate and let the human dogfood it.
