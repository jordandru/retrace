#!/bin/sh
set -eu

[ "${CLAUDE_CODE_REMOTE:-}" = "true" ] || exit 0
: "${RETRACE_URL:?RETRACE_URL is required in a cloud session}"

unset RETRACE_TOKEN RETRACE_HOOK_TOKEN RETRACE_PRODUCER_KEY_FILE RETRACE_CREDENTIALS_FILE
exec retrace-mcp
