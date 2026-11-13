---
name: konte-setup
description: Create a konte workspace under ~/konte-workspaces/, or set up one there again. Use on /konte-setup, when starting with konte, when adding a workspace, or when a workspace's konte.config.json is missing.
---

Done = the setup script succeeds in the workspace and the user receives the hand-off step.

## 1. Choose the directory

- `~/konte-workspaces/<name>` — the name the user gives, else `main`. Create it if needed, then enter it.
- It holds files but no `konte.config.json` → ask before setting up there.

## 2. Download and run

```sh
konte_setup_script=$(mktemp)
curl -fsSL https://raw.githubusercontent.com/shiwano/konte/main/setup.sh -o "$konte_setup_script"
sh "$konte_setup_script"
```

- Continue only after a successful download and script exit.
- Version: `KONTE_VERSION` override → committed `konte.version` → latest. For a requested version, set `KONTE_VERSION` for the script invocation.
- Nonempty destination approved by the user → pass `--yes`.
- Checksum or download failure → retry once; still failing → report and stop.

## 3. Hand off

Skip the script's Next steps; tell the user to send `/konte` in this chat.

End here — video creation belongs to the workspace's skills.
