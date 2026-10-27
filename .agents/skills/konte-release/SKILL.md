---
name: konte-release
description: Cut a konte release — the version commit, its tag, and the GitHub release that release.yml builds from the tag. Use when asked to release, cut, or tag a version.
user-invocable: true
argument-hint: "<version>"
---

A release is one commit that moves `package.json`'s `version`, tagged `v<version>` and pushed; `release.yml` builds the binaries off the tag and publishes the GitHub release. Done = `gh release view v<version>` shows a published release with the five `konte-*` binaries and `SHA256SUMS`.

## Procedure

1. Start on a green `main` — clean tree, even with `origin/main`, and the latest `ci` run on `main` succeeded (`gh run list --branch main --workflow ci.yml --limit 1`).
2. The version is the human's — `$ARGUMENTS`, else ask. The plugin's `version` under `plugin/` is the plugin's own.
3. Bring `comfyVersion` in `src/cli/templates/workspace/konte.config.json` up to ComfyUI's latest tag (`gh release view -R Comfy-Org/ComfyUI --json tagName -q .tagName`), in its own commit `Seed ComfyUI <tag> in a new workspace's Comfy API deployment`.
4. Set `version` in `package.json`. That is the whole diff.
5. Commit with the subject `🎬 Cut v<version>` and no body. The commit-msg hook refuses any other subject on a commit that moves the version.
6. Tag and push together — `git tag v<version> && git push origin main v<version>`. The workflow refuses a tag that disagrees with `package.json`.
7. Wait for `release.yml` — `gh run watch` on the run `gh run list --workflow release.yml --limit 1` names. The release is created as a draft and flipped to published only after every asset is up.
8. Report the release URL.

## Don't

- Don't tag a commit that is not the version commit, and don't tag before the push of `main` — the tag's commit has to be on `main` when the workflow runs.
- Don't write release notes — `release.yml` builds them from the subjects of the commits since the previous tag that touch what ships (`src/` outside its tests, `plugin/`, the setup scripts, the dependencies).
- Don't re-tag. A wrong release is a new version.
