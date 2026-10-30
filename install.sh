#!/bin/sh
# Installs herdr-import: the CLI and the Herdr window's mod.
# One line, no git, no cloning, idempotent:
#   curl -fsSL https://raw.githubusercontent.com/arhen/herdr-import/main/install.sh | sh
set -eu

REPO="arhen/herdr-import"
BRANCH="main"
APP_HOME="${HERDR_APP_HOME:-$HOME/.config/herdr-app}"
MODS="$APP_HOME/mods"
BIN="$HOME/.local/bin"

say() { printf '%s\n' "$@"; }
die() {
  printf 'herdr-import: %s\n' "$*" >&2
  exit 1
}

[ -d "$APP_HOME" ] || die "no $APP_HOME: install Herdr first, then run this again."
command -v curl >/dev/null 2>&1 || die "curl is needed to fetch the files."

tmp=$(mktemp -d "${TMPDIR:-/tmp}/herdr-import.XXXXXX")
trap 'rm -rf "$tmp"' EXIT INT TERM

say "fetching $REPO…"
curl -fsSL "https://codeload.github.com/$REPO/tar.gz/refs/heads/$BRANCH" -o "$tmp/src.tgz" ||
  die "could not download $REPO ($BRANCH). Check the network or the repo name."
tar xzf "$tmp/src.tgz" -C "$tmp" || die "could not unpack what was downloaded."
src=$(find "$tmp" -maxdepth 2 -name mod -type d | head -1)
[ -n "$src" ] || die "that download has no mod folder: is $BRANCH the right branch?"

# The mod: one folder. An existing copy is kept aside, never overwritten silently.
mkdir -p "$MODS" "$BIN"
if [ -e "$MODS/herdr-import" ] && [ ! -L "$MODS/herdr-import" ]; then
  aside="$MODS/herdr-import.bak-$(date +%Y%m%d%H%M%S)"
  mv "$MODS/herdr-import" "$aside"
  say "kept the copy that was there as $aside"
fi
rm -f "$MODS/herdr-import"
cp -R "$src" "$MODS/herdr-import"
say "mod:  $MODS/herdr-import"

# The command it calls. Its own folder, so it survives the mods being replaced.
cp "$src/main.js" /dev/null 2>/dev/null || true
script=$(find "$tmp" -maxdepth 3 -path '*/bin/herdr-import.js' | head -1)
[ -n "$script" ] || die "that download has no bin/herdr-import.js"
cp "$script" "$BIN/herdr-import"
chmod +x "$BIN/herdr-import"
say "cli:  $BIN/herdr-import"

case ":$PATH:" in
  *":$BIN:"*) ;;
  *) say ""; say "$BIN is not on your PATH. The mod calls it by absolute path, so the" \
    "window still works; to use the command in a shell, add it:" \
    "  echo 'export PATH=\"\$HOME/.local/bin:\$PATH\"' >> ~/.zshrc" ;;
esac

say ""
say "done. In Herdr: Shift P → mod.open herdr-import → tick workspaces → Import."
say "herdr itself keeps running untouched; nothing is copied or forked."
