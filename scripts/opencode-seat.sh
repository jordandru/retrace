#!/usr/bin/env bash
# Launch OpenCode as the `opencode` Retrace seat.
#
# This is the only supported way to start OpenCode in this repository. It makes the seat's own
# instruction file the session's sole instruction source, which is what lets the seat join at all
# (docs/agent-rules.md rule 7, docs/design/opencode-seat.md). A session started any other way is
# refused by the guard plugin — except `opencode --pure`, which loads no plugins and is refused here.
set -euo pipefail

# Versions whose instruction-loading behaviour has actually been checked (Gate 0). The flag this
# script relies on is undocumented upstream, so a new version re-opens Gate 0 rather than being
# trusted by default.
VERIFIED_VERSIONS="1.18.29"

die() { printf 'opencode-seat: %s\n' "$1" >&2; exit 1; }

root=$(git rev-parse --show-toplevel 2>/dev/null) || die "not inside a git worktree"
[ -f "$root/.retrace.json" ] && [ -f "$root/docs/agent-rules.md" ] \
  || die "$root is not a Retrace worktree (.retrace.json and docs/agent-rules.md expected)"

config="$root/opencode.retrace.json"
[ -f "$config" ] || die "missing $config"
[ -f "$root/docs/agents/OPENCODE.md" ] || die "missing the seat instruction file docs/agents/OPENCODE.md"
[ -f "$root/packages/opencode-plugin/dist/index.js" ] \
  || die "guard plugin is not built — run: npm ci && npm run build (agent-ops 4)"
[ -f "$HOME/.retrace/opencode.env" ] \
  || die "missing ~/.retrace/opencode.env — the seat's credential is minted by Jordan (agent-rules 13, 14)"

for arg in "$@"; do
  case "$arg" in
    --pure) die "--pure disables plugins, which disables the identity guard; refusing" ;;
  esac
done

command -v opencode >/dev/null 2>&1 || die "opencode is not on PATH"
version=$(opencode --version 2>/dev/null | tr -d '[:space:]')
case " $VERIFIED_VERSIONS " in
  *" $version "*) ;;
  *) die "opencode $version has not been through Gate 0 (verified: $VERIFIED_VERSIONS). \
Re-run the instruction-loading probe in docs/design/opencode-seat.md before using this version." ;;
esac

# Orca points OPENCODE_CONFIG_DIR at a per-worktree overlay, and that overlay loads AFTER this
# seat config. It is harmless while it only adds a status plugin; it must never set instructions.
if [ -n "${OPENCODE_CONFIG_DIR:-}" ]; then
  for overlay in "$OPENCODE_CONFIG_DIR/opencode.json" "$OPENCODE_CONFIG_DIR/opencode.jsonc"; do
    [ -f "$overlay" ] || continue
    if grep -q '"instructions"' "$overlay"; then
      die "the config overlay $overlay sets \"instructions\", which would override this seat's identity file"
    fi
  done
fi

# OpenCode resolves `instructions` against its own config directory once project config is
# disabled, and a plugin spec that is not an existing absolute file:// URL stalls startup
# (Gate 0, docs/design/opencode-seat.md). So the committed template is rendered to absolute
# paths here, next to the git dir, and that rendered copy is what runs.
rendered_dir=$(git rev-parse --git-path retrace-opencode)
mkdir -p "$rendered_dir"
rendered="$rendered_dir/config.json"
RETRACE_ROOT="$root" node -e '
  const { readFileSync, writeFileSync } = require("node:fs");
  const root = process.env.RETRACE_ROOT;
  const cfg = JSON.parse(readFileSync(process.argv[1], "utf8"));
  cfg.instructions = (cfg.instructions ?? []).map((p) => (p.startsWith("/") ? p : `${root}/${p}`));
  cfg.plugin = (cfg.plugin ?? []).map((p) =>
    p.startsWith("file://") ? `file://${root}/${p.slice("file://".length).replace(/^\.\//, "")}` : p,
  );
  writeFileSync(process.argv[2], JSON.stringify(cfg, null, 2));
' "$config" "$rendered"

export OPENCODE_DISABLE_PROJECT_CONFIG=1
export OPENCODE_DISABLE_CLAUDE_CODE=1
export OPENCODE_CONFIG="$rendered"
cd "$root"
exec opencode "$@"
