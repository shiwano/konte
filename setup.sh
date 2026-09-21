#!/bin/sh
# Run from the workspace directory. KONTE_VERSION selects a release tag or latest.
set -eu
# An inherited CDPATH makes the cd's below print their destination and resolve it elsewhere.
CDPATH=

REPO="shiwano/konte"
VERSION="${KONTE_VERSION:-}"
if [ -z "$VERSION" ] && [ -f konte.version ]; then
	VERSION=$(tr -d '\r\n' <konte.version)
fi
VERSION="${VERSION:-latest}"
if [ "$VERSION" != latest ]; then
	VERSION="v${VERSION#v}"
fi
INSTALL_ROOT="$PWD/.konte"
BIN_DIR="$INSTALL_ROOT/bin"

err() {
	echo "konte: $1" >&2
	exit 1
}

os=$(uname -s)
case "$os" in
Linux) os=linux ;;
Darwin) os=darwin ;;
*) err "unsupported OS '$os' (use setup.ps1 on native Windows)" ;;
esac

arch=$(uname -m)
case "$arch" in
x86_64 | amd64) arch=x64 ;;
arm64 | aarch64) arch=arm64 ;;
*) err "unsupported architecture '$arch'" ;;
esac

asset="konte-$os-$arch"
if [ "$VERSION" = latest ]; then
	base="https://github.com/$REPO/releases/latest/download"
else
	base="https://github.com/$REPO/releases/download/$VERSION"
fi

mkdir -p "$BIN_DIR"
BIN_DIR=$(cd "$BIN_DIR" && pwd -P) || err "cannot enter $BIN_DIR"
tmp=$(mktemp -d)
# Staged inside the install directory, so the mv below is a rename within one
# filesystem rather than a copy that can truncate a working install.
staged="$BIN_DIR/.konte-$$.tmp"
trap 'rm -rf "$tmp" "$staged"' EXIT

echo "konte: downloading $asset ($VERSION)"
curl -fsSL "$base/$asset" -o "$staged" || err "download failed: $base/$asset"

curl -fsSL "$base/SHA256SUMS" -o "$tmp/SHA256SUMS" ||
	err "cannot fetch SHA256SUMS to verify $asset"
expected=$(awk -v a="$asset" '{ n = $2; sub(/^\*/, "", n); if (n == a) { print $1; exit } }' "$tmp/SHA256SUMS")
[ -n "$expected" ] || err "$asset not listed in SHA256SUMS"
if command -v sha256sum >/dev/null 2>&1; then
	actual=$(sha256sum "$staged" | cut -d' ' -f1)
else
	actual=$(shasum -a 256 "$staged" | cut -d' ' -f1)
fi
[ "$expected" = "$actual" ] || err "checksum mismatch for $asset"

chmod +x "$staged"
mv "$staged" "$BIN_DIR/konte"
echo "konte: installed to $BIN_DIR/konte"

if [ -f konte.config.json ]; then
	"$BIN_DIR/konte" workspace setup "$@"
else
	"$BIN_DIR/konte" workspace new "$@"
fi
[ -f konte.config.json ] || err "workspace creation was aborted"
echo "KONTE_BIN=$BIN_DIR/konte"
