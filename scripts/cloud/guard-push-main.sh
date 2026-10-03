#!/bin/sh
# Bypassable policy control: it prevents ordinary Claude Code Bash pushes, not every possible GitHub write.
set -eu

[ "${CLAUDE_CODE_REMOTE:-}" = "true" ] || exit 0

command="$(
  node -e '
    let input = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", chunk => input += chunk);
    process.stdin.on("end", () => {
      try {
        const parsed = JSON.parse(input);
        process.stdout.write(typeof parsed?.tool_input?.command === "string" ? parsed.tool_input.command : "");
      } catch {
        process.exitCode = 1;
      }
    });
  '
)" || exit 0

push_command="$(printf '%s\n' "$command" | sed -nE 's/^[[:space:]]*(git[[:space:]]+push([[:space:]].*)?)[[:space:]]*$/\1/p')"
[ -n "$push_command" ] || exit 0

case " $push_command " in
  *" main "*|*" HEAD:main "*|*" refs/heads/main "*)
    echo "refused: a cloud session never pushes main (docs/design/cloud-seat.md §6)" >&2
    exit 2
    ;;
esac

if [ "$push_command" = "git push" ] && [ "$(git branch --show-current 2>/dev/null || true)" = "main" ]; then
  echo "refused: a cloud session never pushes main (docs/design/cloud-seat.md §6)" >&2
  exit 2
fi

exit 0
