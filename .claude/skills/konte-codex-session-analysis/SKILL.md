---
name: konte-codex-session-analysis
description: Analyze a real Codex video-production session — token usage, tool output, guide loading, compaction, review waits, and konte CLI friction. Use to investigate a workspace session or validate the skill JOURNEY against production logs.
---

Done when measurements name their accounting source and scope, and findings cite rollout lines and the implicated command or guide. Analyze existing logs only — never resume generation or change the video. Input: a workspace path or rollout JSONL path.

## Locate the production session

Search `${CODEX_HOME:-$HOME/.codex}/sessions`, then `archived_sessions`. Match `session_meta.payload.cwd` to the workspace, then confirm user prompts, timestamps and the produced video — the newest file can be this investigation or a critic. List candidates by metadata only; never dump base instructions or image data:

```python
import json, os
from pathlib import Path

root = Path(os.environ.get("CODEX_HOME", str(Path.home() / ".codex")))
workspace = Path("/absolute/path/to/my-video").resolve()
for folder in ("sessions", "archived_sessions"):
    for path in sorted((root / folder).rglob("*.jsonl")):
        with path.open() as stream:
            row = json.loads(next(stream))
        meta = row.get("payload", {})
        if row.get("type") == "session_meta" and Path(meta.get("cwd", "/")).resolve() == workspace:
            keys = ("id", "timestamp", "cwd", "cli_version", "parent_thread_id",
                    "forked_from_id", "forked_from_ordinal_exclusive", "agent_path")
            print(path, {key: meta[key] for key in keys if key in meta})
```

- Follow `forked_from_id` through ancestors — a fork may store only new rows. Preserve the fork cutoff for inherited history; report abandoned-branch work separately.
- Group critics by `parent_thread_id` or `source.subagent.thread_spawn`, with separate usage and read inventories. `session_id` can be shared across agents; `id` distinguishes files.
- Preserve physical line numbers alongside timestamps and ordinals. State the timezone, production interval, and whether post-export feedback is included.

## Decode once

Inspect the installed version's actual records before assuming a schema.

- `response_item` holds messages, `function_call` / `function_call_output`, and `custom_tool_call` / `custom_tool_call_output`. Join calls and results by `call_id`. Arguments may be JSON strings; custom inputs may be JavaScript.
- `event_msg` can mirror messages and completion events. Count canonical response items once. `compacted.payload.replacement_history` is replacement context, not new tool activity.
- Code-mode `exec` wraps several calls — an `exec` count is not a shell-command count; inspect its source and returned blocks. Commands in loops, stored strings or generated code need tracing; a regex match is a mention until execution is confirmed. Never execute logged code to decode it.
- Output is a string or text/image blocks; text can wrap a JSON shell result. Separate returned text length, image blocks and tool-reported pre-truncation size. Never print base64 or credential values.
- Assistant phase may be `phase: "final_answer"` / `"commentary"` or `channel`. User skill expansion blocks, developer instructions and `world_state` snapshots are not additional human requests.

## Account for usage

When present, sum `token_usage_record.payload.usage` once per `response_id` across the selected branch records; compare against `thread_token_usage`, allowing for inherited usage. Report discrepancies with `event_msg.token_count.info`; never add the two streams together. Compaction requests may appear in per-response records but not the event counter — reconcile against the records just before each `compacted`.

```sh
jq -s '[.[] | select(.type == "token_usage_record") | .payload]
  | unique_by(.response_id)
  | {responses: length, usage: (map(.usage) | reduce .[] as $u ({};
      reduce ($u | keys[]) as $k (. ; .[$k] = ((.[$k] // 0) + $u[$k]))))}' "$T"
```

- Check that response IDs exist before deduplicating; across files, deduplicate inherited records too. Never simply add parent/child final cumulative totals.
- Without per-response records, use the last non-null `token_count.info.total_token_usage` per independent thread, minus verified inherited baselines for forks. Inspect resets, rollback and compaction; label unresolved totals incomplete.
- `input_tokens` includes cached input; report cached input and the uncached difference separately. `reasoning_output_tokens` is a subset of output when the recorded totals establish that relationship.
- Cumulative input measures repeated requests over history — neither unique content read nor final context size. `last_token_usage.input_tokens` is one request; `model_context_window` is capacity.
- Reasoning text may be partial or encrypted. Use recorded reasoning usage; never infer hidden thinking by subtracting character estimates from input usage.
- Report tool text in characters and images in counts unless a tokenizer or measured image usage is available — neither base64 bytes nor a per-image constant establishes image cost. Dollar cost needs the actual billing tier and rates.

## Attribute context and repeated reads

Inventory calls, returned text size, image blocks, guide reads and compactions per agent. Separate production from feedback. Rank the largest outputs with their originating calls.

For each suspected re-read, inspect the returned content and surrounding edits:

- A path in a catalog, grep result or prompt is a pointer, not proof of a successful read. Record inline skill expansion, full read, partial/truncated read and pointer-only separately.
- Track ranges, aliases (`.agents` / `.claude`), edits, forks and compactions. Reloading after a cut-off result or compaction is recovery; re-inspecting an edited stage is verification.
- Code-mode has an outer output limit besides each nested tool's — several bounded results can overflow the wrapper. Attribute the truncation marker to its layer before recommending a larger shell limit.
- Check shell `head` / `tail` / `sed`, JavaScript filtering and tool output limits; establish what was lost before claiming a warning was absent. A large `original_token_count` is source output, not necessarily what reached the model.

## Test the production journey

Compare observed reads with `scripts/check-journeys.ts` and the workspace's installed guides, including nested references and model guides reached through `konte adapter show` — current repository text may differ from what the session received.

- Loaded outside JOURNEY: check whether it is a declared variable cost (model/backend guides) or post-production work before calling it a budget hole.
- Listed but unobserved: verify the branch's trigger and whether a containing result was truncated. Mark applicable missing reads as routing gaps; do not trim JOURNEY to fit observations.
- A pointer present in context does not prove the agent understood or ignored it. Cite the required artifact/action and what happened before diagnosing the routing mechanism.

Trace `preview` and `job wait` through process IDs, `write_stdin`, review submission and the next action. Distinguish human waiting, generation, short polling, lost process handles and an assistant ending its turn. After compaction, check whether the agent resumed the current objective or reactivated an old check-in. User status questions do not themselves cancel production.

For each finding, report observed behavior, evidence, consequence and a scoped improvement. Separate CLI defects, guide conflicts, agent mistakes and unresolved hypotheses. Verify earlier feedback against raw results — the agent's own retrospective is not independent proof. No product fixes unless requested.
