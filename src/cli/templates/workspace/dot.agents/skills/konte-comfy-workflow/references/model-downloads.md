# Model downloads & node packs

## Model download URLs (step 2.3)

- **konte auto-installs enabled `models` entries before running** — models already present on the server are skipped.
- **HuggingFace files** — use the `/resolve/main/...` URL as-is (e.g. `https://huggingface.co/<repo>/resolve/main/<file>`).
- **Gated HuggingFace files** — same plain URL; never put credentials in it. Tell the user to set `HF_TOKEN` in `konte settings` and to accept the repo's licence on its HuggingFace page.
- **Civitai files** — `https://civitai.com/api/download/models/<id>?token=${CIVITAI_TOKEN}`; tell the user to set `CIVITAI_TOKEN` in `konte settings`.
- **Unsure of a URL** — leave the model entry out; konte surfaces a clear error if a missing model is referenced at run time.
- **Declare only what the workflow selects by `filename`** — drop a user-selectable preset, and anything the loader fetches itself (a `download_if_missing` flag, a `model_size` picker).
- **`savePath` places a weight outside its type's default folder** — one entry per file, so a model the node loads by directory is declared file by file, each with its own `savePath`. The same `filename` at two `savePath`s is two downloads.

## Node packs (step 2.3)

```ts
nodes: [
  { id: "ComfyUI-VideoHelperSuite" },
],
```

- **`id` is the registry (cnr) id** — a pack outside the registry is not auto-installed; give it the `custom_nodes` directory name it is installed under.
- **A newly installed pack needs a ComfyUI restart to load** — konte reboots once after install (`comfyui.autoRebootAfterNodeInstall`, default `true`); set it `false` on a shared server and konte asks you to restart and re-run instead.
