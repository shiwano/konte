---
name: konte-feedback
description: Turn one konte bug, rough edge or unanswered question hit this session into a post for the konte Discord support forum — with reproduction details when available, version and relevant logs, secrets and the piece's content stripped, tagged. Use when the user says "report this", "file a bug", "send feedback", "ask the maintainers", a konte command printed a stack trace, or konte itself misbehaved and they want it reported.
user-invocable: true
argument-hint: [what to report]
---

Done = one post, approved by the human, handed over as paste-ready text with its tags; not fixing konte, not a session-wide list of every friction.

## 1. Decide whether it earns a post

- **konte's fault, not the model's** — a crash or stack trace; an exit code that contradicts the output; two konte surfaces disagreeing (`status` vs `inspect`, the review UI vs the CLI); an error naming neither cause nor fix; a `Next steps` line that did not work; a guide or skill contradicting real behavior; a workaround you had to invent. Not a limit `HOUSE_RULES.md` or the direction chose.
- **One post per cause** — unrelated ones are posted one at a time.
- **Cosmetic, or a preference** — batch them into one `feature` post, and only when the human asks for it.
- **A "how do I"** — read the guide; what the guide did not answer is a `help` post.

## 2. Reproduce before you write

- **`konte doctor` first** — if an environment problem it identifies fully explains the failure, treat it as support rather than a konte bug.
- **Reproduce when safe** — rerun the exact CLI command and record its exit code (`konte …; echo "exit=$?"`), or repeat the review UI steps. Once only → still worth posting with the available evidence; mark it `seen once`.
- **Minimize** — the smallest command or UI steps, and the smallest edit to the definition, that still triggers it.
- **Don't rerun a paid generation to reproduce** — for a job, report from what already ran.

## 3. Collect the facts

- **Always**: `konte --version`, `uname -sr`, the coding agent driving (Claude Code / Codex), the steps taken and what happened.
- **CLI**: the exact command, its full output and exit code.
- **Review UI**: the exact actions and any visible error text.
- **A job**: `konte job show <id>`, then `konte job logs <id>` — the last 40 lines, plus the first error line.
- **State or staleness**: `konte inspect <address>` for the address in question; the matching section of `konte status -v`.
- **Definition-side**: the smallest excerpt of the stage file that triggers it, with the adapter name (`konte adapter show <adapter>` gives its backend).
- **Docs-side**: the file and line of the guide or skill, and the behavior it contradicted.
- **Quote command output**, not `jobs.db` or `konte.state.json`.

## 4. Strip before it leaves the workspace

- **Never a credential** — no value from `konte.credentials.json`, no env var value, no key or token inside a URL (fal signed URLs, ComfyUI tunnels); name the variable, redact the value as `<redacted>`.
- **The piece is the human's** — prompts, the brief, dialogue and generated media stay out unless the bug needs them; ask before quoting any, and prefer a placeholder (`"prompt": "<a 40-word scene prompt>"`).
- **Home paths** — replace `/home/<user>` and `/Users/<user>` with `~`.

## 5. Write it — in English

**Always English**, whatever language the session runs in.

**Tags** — pick one kind:

- `bug` — konte did the wrong thing (section 1's list).
- `feature` — konte worked, but the job took a workaround, extra steps, or something it lacks.
- `docs` — a guide or skill said one thing and konte did another.
- `help` — a question the guides did not answer.

**Add an area when useful**:

- `agent` — coding agent behavior around konte: a skill it did not load, a step it skipped, a command it mis-typed.
- `comfyui` — ComfyUI provisioning, workflows, or the queue.

**Title** — `<command>: <symptom>` for CLI or `review UI: <symptom>` for UI, under 70 characters, symptom not diagnosis (`generate animatic: exits 0 after a failed plate job`); a `help` post is the question in one line.

**Body**:

````md
## What I was trying to do

<one sentence>

## What happened

<one paragraph: what konte did>

## What I expected

<one sentence; for feature: what you did instead>

## Repro

1. <starting state — the smallest edit or accept that sets it up>
2. <exact CLI command or review UI actions>

reproduces: yes | seen once; exit=<code if CLI>

## Environment

- konte <version> · <OS> · <Claude Code | Codex>
- backend: <comfy | fal | local> · adapter: <name>

## Output

```text
<command output, visible UI error text, or relevant log excerpt>
```

## Notes

<workaround; suspected cause, labelled "guess">
````

- **`help`** — the first three sections and Environment; Repro and Output only when a command is involved.
- **A `feature` batch** — one line per item under `## What happened`, no Repro.

## 6. Hand it over

- **Show the whole post** with a summary in the human's language when that is not English, and name the tags.
- **The human posts** — after their yes, hand over the title, tags and body as shown, with the forum link: `https://discord.gg/2b7UwFE2Yy`, channel `#support`.
- **Done** = the post, its tags and the link handed over.

## Confirm before

- Quoting any prompt, brief text or generated media.
- Re-running a paid generation to reproduce.

## Don't

- **Fix konte** — no edits under `.konte/`, no patched binary; a workaround in the definition is fine and belongs in `## Notes`.
- **Pad** — a `bug` post without a concrete reproduction path is not ready; drop it or keep gathering.
- **Report a model's creative miss** — that is a reroll, a prompt edit, or feedback on the take.
- **Open a GitHub issue** — the maintainers open them from `#support` posts.
