#!/bin/sh
# Bypassable policy control: it prevents ordinary Claude Code Bash git pushes, not every possible GitHub write.
# GitHub operations such as `gh pr merge` are outside this git-push-only guard.
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

refuse_main() {
  echo "refused: a cloud session never pushes main (docs/design/cloud-seat.md §6)" >&2
  exit 2
}

targets_main() {
  refspec="$1"
  case "$refspec" in
    +*) refspec="${refspec#?}" ;;
  esac
  case "$refspec" in
    *:*) destination="${refspec#*:}" ;;
    *) destination="$refspec" ;;
  esac
  [ "$destination" = "main" ] || [ "$destination" = "refs/heads/main" ]
}

set -- $push_command
shift 2
remote=""
has_refspec=false
options=true
while [ "$#" -gt 0 ]; do
  argument="$1"
  shift
  if [ "$options" = true ]; then
    case "$argument" in
      --)
        options=false
        continue
        ;;
      --repo|--receive-pack|--exec|-o|--push-option)
        [ "$#" -gt 0 ] && shift
        continue
        ;;
      --repo=*|--receive-pack=*|--exec=*|--push-option=*|-*)
        continue
        ;;
    esac
  fi
  if [ -z "$remote" ]; then
    remote="$argument"
  else
    has_refspec=true
    targets_main "$argument" && refuse_main
  fi
done

if [ "$has_refspec" = false ]; then
  branch="$(git branch --show-current 2>/dev/null || true)"
  [ "$branch" = "main" ] && refuse_main

  if [ -z "$remote" ] && [ -n "$branch" ]; then
    remote="$(git config --get "branch.$branch.pushRemote" 2>/dev/null \
      || git config --get remote.pushDefault 2>/dev/null \
      || git config --get "branch.$branch.remote" 2>/dev/null \
      || true)"
  fi

  if [ -n "$remote" ]; then
    configured_refspecs="$(git config --get-all "remote.$remote.push" 2>/dev/null || true)"
    if [ -n "$configured_refspecs" ]; then
      while IFS= read -r refspec; do
        targets_main "$refspec" && refuse_main
      done <<EOF
$configured_refspecs
EOF
      exit 0
    fi
  fi

  push_ref="$(git rev-parse --abbrev-ref '@{push}' 2>/dev/null || true)"
  [ "$push_ref" = "main" ] && refuse_main
  [ -n "$remote" ] && [ "$push_ref" = "$remote/main" ] && refuse_main

  push_default="$(git config --get push.default 2>/dev/null || printf '%s\n' simple)"
  case "$push_default" in
    upstream|simple)
      merge_ref="$(git config --get "branch.$branch.merge" 2>/dev/null || true)"
      [ "$merge_ref" = "refs/heads/main" ] && refuse_main
      ;;
  esac
fi

exit 0
