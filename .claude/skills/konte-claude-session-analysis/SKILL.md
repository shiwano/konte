---
name: konte-claude-session-analysis
description: Analyze a real Claude Code session transcript — where its context went, which guides actually loaded, and what that says about konte's CLI and skill design. Use to interpret /context output, validate a JOURNEY, or diagnose a routing miss.
user-invocable: true
argument-hint: "[workspace-path]"
---

**Done** when every number is attributed to a real consumer from the transcript, and each konte design signal names the command it implicates.

## 0. First rule — `/context` names sizes, not causes

- **`Read results N tokens (M%)` is carrying cost, never re-reads** — it sums `result tokens × requests it persists through`, so one early image read reports as millions. **Never** conclude "the agent re-read files" from it; prove re-reads in §4.
- **Treat every `/context` figure as a hypothesis** — confirm against the transcript before reporting it.

## 1. Locate the transcript

```sh
D="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/projects/$(echo "$WORKSPACE" | tr '/.' '--')"
ls -laS "$D"/*.jsonl   # newest/largest = the session; T=<pick one>
```

- **Analyze the workspace's session, not konte's own** — a `konte-checkin`→export session lives under the _user workspace_ path (`my-video`), even when the question is asked from the konte repo.

## 2. Transcript shape — the non-obvious parts

- **Thinking text is not stored** — `.thinking` is empty, only `.signature` survives. Thinking size is derivable **only** by subtraction (§5). Never report it as measured.
- **Images are stored twice** — in `message.content[]` _and_ `toolUseResult`. Count only `tool_result` blocks or you double every figure.
- **Byte size ≠ token size** — a 20MB transcript is mostly image base64; an image costs ~1.6k tokens regardless of its bytes.
- **Final context** = last assistant's `usage.cache_read_input_tokens + cache_creation_input_tokens`. Use it to confirm you picked the right session against `/context`.
- `tool_use` lives in `assistant.message.content[]`, `tool_result` in `user.message.content[]`, joined on `id` ↔ `tool_use_id`.

## 3. Measure tool cost

```sh
jq -r 'select(.type=="assistant") | .message.content[]? | select(.type=="tool_use")
  | [.id, .name, ((.input.file_path // .input.command // "") | tostring | gsub("\n";" "))] | @tsv' "$T" > /tmp/uses.tsv
jq -r 'select(.type=="user") | .message.content[]? | select(.type=="tool_result")
  | [.tool_use_id,
     (if (.content|type)=="array" then ([.content[]|select(.type=="text")|(.text|length)]|add // 0) else (.content|length) end),
     (if (.content|type)=="array" then ([.content[]|select(.type=="image")]|length) else 0 end)] | @tsv' "$T" > /tmp/res.tsv
awk -F'\t' 'NR==FNR{c[$1]=$2; i[$1]=$3; next}
  {t[$2] += c[$1]/4 + i[$1]*1600; n[$2]++}
  END{for (k in t) printf "%-12s %4d calls %8.1fk tok\n", k, n[k], t[k]/1000}' /tmp/res.tsv /tmp/uses.tsv | sort -k4 -rn
```

## 4. Prove or kill the re-read hypothesis

```sh
awk -F'\t' '$2=="Read"{print $3}' /tmp/uses.tsv | sort | uniq -c | sort -rn | awk '$1>1'
```

- **Empty output = no re-reads.** Say so plainly and retract §0's figure as a cause.
- **A re-read of a file the session edits is normal** — cross-check against `$2=="Edit"` paths before calling it waste. Only a re-read of an _unedited_ file is the signal.
- **Group images and text separately** — image reads dominate tokens, text reads dominate counts.

## 5. Attribute the whole context

- Sum the measurable — tool results (§3), `tool_use` inputs, assistant `text`, human prompts, `attachment` blocks.
- **Subtract from `/context`'s Messages — the remainder is thinking.** In a healthy long session it dominates (~2/3). Report it as an estimate.

## 6. konte design signals

- **Defensive truncation** — a Bash call piping konte through `head`/`tail`. High rate = the agent doesn't trust konte's output volume. Check whether the limit **actually bit** (result lines ≥ the limit); a limit that never bit is a habit, not a loss. Watch for compound `&&` commands inflating the line count.
- **Which command bit** — attribute every real truncation to its subcommand; a command whose length scales with content (human comments) is where truncation costs information.
- **Did a truncation hide a warning** — before concluding konte failed to say something, check what the `head`/`tail` cut: a result that keeps a footer or a suggested command but not the block it belonged to means the warning was printed and dropped.
- **Subcommand frequency** — `grep -oE '\bkonte [a-z-]+( [a-z-]+)?' /tmp/uses.tsv | sort | uniq -c | sort -rn` shows which loop dominated a real production session.

## 7. Validate the skill JOURNEY against what actually loaded

A `konte-checkin`→export session **is** the chain `scripts/check-journeys.ts` models as the `video` journey, so it is the only real test of that list.

```sh
jq -r 'select(.type=="assistant") | .message.content[]? | select(.type=="tool_use" and .name=="Skill") | .input.skill' "$T" | sort -u
jq -r 'select(.type=="user") | (.message.content|tostring)' "$T" | grep -oE '<command-name>/[a-z-]+' | sort -u   # slash-invoked; no Skill tool_use
jq -r 'select(.type=="assistant") | .message.content[]? | select(.type=="tool_use") | ((.input.file_path // .input.command // "")|tostring)' "$T" \
  | grep -oE '(\.claude|dot\.agents)/skills/[A-Za-z0-9./_-]+' | sed 's|.*/skills/||' | sort -u   # references, incl. nested per-model docs
```

- **Grep nested paths** — `references/video/wan-2-2.md` won't match a `references/[a-z-]+\.md` pattern. A too-narrow pattern invents "never loaded" findings.
- **Loaded but not in JOURNEY** = a real budget hole; its tokens escape the check. Add it, and expect the raise (log it as an accounting fix, not a new concept).
- **In JOURNEY but never loaded** = a routing miss, **not** a list error. Never trim the list to match observation — that blesses the miss and silently drops a guide from the chain.

## 8. Diagnose a routing miss

```sh
grep -c "staging-guide" "$T"                                                    # times the pointer sat in context
jq -r 'select(.type=="assistant")|.message.content[]?|select(.type=="text")|.text' "$T" | grep -c "staging-guide"   # times the agent wrote it
```

- **Seen ≫ 0, written 0 = confirmed miss** — the agent read the pointer and never followed it.
- **Don't blame the phrasing** — syntax is not the variable.
- **The variable is what the pointer hangs on** — pointers tied to an **artifact the agent must write** (DSL, adapter, prompt, JSX) fire; pointers tied to a **judgment it never notices making** (fixing intent, choosing a production method) don't. Fix by re-anchoring to the artifact, not by rewording.
- **A self-assessed gate never fires** — `Intent not yet fixed → read X` asks the agent to detect the very lapse the guide exists to prevent. Make it unconditional.

## Don't

- Don't propose an `AGENTS.md` line on token grounds — every figure here is <1% of a session. Argue from what the agent does or doesn't know.
- Don't A/B a prompt change on a synthetic read-only task — the behaviors worth measuring only appear in a real long session. Report the base rate and let the human dogfood it.
