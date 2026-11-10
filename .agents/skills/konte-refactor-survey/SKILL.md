---
name: konte-refactor-survey
description: Survey konte's source for refactoring candidates across parallel read-only subagents, verify the high-stakes ones, and write them as a prioritized task list. Use when asked to find, survey or list what to refactor in konte, or on /konte-refactor-survey.
user-invocable: true
argument-hint: "<output path> [src subdirectory]"
---

Done = a task file whose every task names `file:line`, the defect, and the proposed change, ranked by priority; nothing in `src/` edited, nothing committed.

## Scope

- Default: all of `src/` except tests, `src/core/generated/` and `src/cli/templates/`. `$ARGUMENTS` narrows to one subdirectory.
- Output: the `.md` path `$ARGUMENTS` names; with none, ask the user for one before step 6.

## 1. Measure

- `fd -e ts -e tsx . <dir> -E '*test*' -E templates | xargs cat | wc -l` per subsystem, and the largest files with `xargs wc -l | sort -n | tail -40`.

## 2. Split

- Groups of ~10–30k lines along subsystem lines: `src/core`, `src/cli`, `src/pages` (+ `src/cli/commands/preview`, `src/cli/page-host`), `src/backends` + `src/comfyui` + `src/comfy-api` + `src/fal` + `src/local` + `src/worker`.
- Each brief names its group's largest files.

## 3. Brief

Every subagent is general-purpose and is told:

- Read `AGENTS.md` first; judge against its design policy and conventions.
- Look for: logic reimplemented across files; one file or function carrying unrelated responsibilities; domain logic in the wrong layer (cli ↔ core, core ↔ backend); types duplicating a Zod schema or another layer's type; bare `Error`; exports with no caller; one convention applied inconsistently; an ordering or invariant a comment states and another path breaks.
- Verify every claim by reading the code and `rg`-ing its callers; mark one inferred without running it.
- Edit no file.
- Report the top 8–12 findings ranked by value: `file:line`, what is wrong, the proposed refactor, value / effort / risk, and a suggested order.

## 4. Fan out

- All subagents in one message. Wait for every report.

## 5. Verify

- Read the code behind each finding that claims real harm — a leaked secret, a wrong value, a broken invariant — and every dead-code claim before it becomes a task. Mark what you confirmed `✔`.
- Merge findings that two reports share.

## 6. Write

- If the output file exists, read it first: keep checked tasks, drop open tasks the code no longer has, number new tasks after the last.
- Header: date of the survey; `✔` = confirmed in step 5.
- Priority sections: P0 real harm, P1 structural with wide effect, P2 medium cleanups, P3 behavior-preserving splits of large files and functions, P4 small cleanups.
- One `### Tn.` per task: checkbox per concrete defect with `file:line`, then `- 案:` with the proposed change. A decision only the human can make is marked `**要判断**`.
- End with `## 着手順`: task IDs in order, dependencies first.

## 7. Report

- The P0 tasks, the ones marked `**要判断**`, and the output path.
