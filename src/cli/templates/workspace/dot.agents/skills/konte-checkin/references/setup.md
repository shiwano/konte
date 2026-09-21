# konte not found

The binary is not installed in this workspace. Stop and hand the human these steps, only for the runtime you are running in:

1. **Install the konte plugin**, if not installed:
   - Claude Code CLI: `/plugin marketplace add shiwano/konte@plugin`, then `/plugin install konte@konte`.
   - Claude Code desktop app: **Settings → Plugins → Add marketplace → Add from a repository**, URL `shiwano/konte@plugin`, install **konte**, then start a new chat in the workspace.
   - Codex terminal: `codex plugin marketplace add shiwano/konte@plugin`, then `codex plugin add konte@konte`.
   - Codex desktop app: **Settings → Plugins → Add plugin marketplace**, Source `shiwano/konte`, Git ref `origin/plugin`, Sparse paths empty, install **konte**, then start a new chat in the workspace.
2. **Run setup** in the workspace: `/konte:setup` (Claude Code) / `$konte:setup` (Codex).
3. **Restart the agent** as setup instructs — a GUI app must be fully quit and relaunched; a new chat is not enough.
4. **Run the check-in again**: `/konte-checkin` (Claude Code) / `$konte-checkin` (Codex).
