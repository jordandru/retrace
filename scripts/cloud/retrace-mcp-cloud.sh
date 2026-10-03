#!/bin/sh
set -eu

[ "${CLAUDE_CODE_REMOTE:-}" = "true" ] || exit 0
: "${RETRACE_URL:?RETRACE_URL is required in a cloud session}"

for name in $(env | sed -n 's/^\(RETRACE_[A-Za-z0-9_]*\(KEY\|TOKEN\|SECRET\)[A-Za-z0-9_]*\)=.*/\1/p'); do
  unset "$name"
done
unset RETRACE_CREDENTIALS RETRACE_CREDENTIALS_EXTRA RETRACE_CREDENTIALS_FILE
exec retrace-mcp
