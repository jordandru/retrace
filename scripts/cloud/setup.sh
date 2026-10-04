#!/bin/sh
set -eu

# Claude Code cloud environment variables (non-secret dialog entries; this script does not set them):
# RETRACE_URL=https://retrace-api.slcwitit.workers.dev
# RETRACE_PROJECT=retrace
# RETRACE_AUTH=proxy
# RETRACE_ENV=claude-cloud
# RETRACE_DEVICE=claude-cloud

CLI_VERSION="0.3.0"
HOOKS_DIR="/usr/local/share/retrace/hooks"

print_sha256() {
  sha256sum "$0" | awk '{ print "setup_sha256=" $1 }'
}

if [ "${1:-}" = "--print-sha256" ]; then
  print_sha256
  exit 0
fi

case "$CLI_VERSION" in
  *__*) echo "setup stopped: B3 must replace the pinned @retrace-dev/cli version" >&2; exit 1 ;;
esac

npm install --global "@retrace-dev/cli@$CLI_VERSION"

tmp_repo="$(mktemp -d)"
trap 'rm -rf -- "$tmp_repo"' EXIT HUP INT TERM
git init -q "$tmp_repo"
retrace-git install --repo "$tmp_repo" --project retrace >/dev/null

install -d -m 0755 "$HOOKS_DIR"
install -m 0755 "$tmp_repo/.git/hooks/post-commit" "$HOOKS_DIR/post-commit"
install -m 0755 "$tmp_repo/.git/hooks/post-merge" "$HOOKS_DIR/post-merge"
git config --system core.hooksPath "$HOOKS_DIR"

print_sha256
