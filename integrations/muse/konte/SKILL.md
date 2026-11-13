---
name: konte
description: Make, review, revise or export a video with konte, check in on one, or upgrade or repair a konte workspace under ~/konte-workspaces/. Use on /konte or /konte-checkin, whenever konte or a konte video comes up, and again after a conversation summary while konte work is in progress.
---

konte's rules and skills live in the workspace; this skill only opens them.

1. Workspace = a directory under `~/konte-workspaces/` holding `konte.config.json`: the one the user names, else the one this chat is working in, else the only one. Several → list them and ask. None → the `konte-setup` skill.
2. Read its `AGENTS.md` and follow it; run commands from the workspace.
3. A skill named by that file, by another skill or by konte's output (`konte-checkin`, `drafting-guide`, `konte-upgrade`, …) is the workspace's `.agents/skills/<name>/SKILL.md`. Read it before acting on it.
4. `/konte`, `/konte-checkin`, or no request beyond starting → `konte-checkin`.
5. After a conversation summary → reread `AGENTS.md` and the current step's skill before continuing.
