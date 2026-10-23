#!/usr/bin/env bash
exec bun --no-install "$(dirname "${BASH_SOURCE[0]}")/session-execution.ts" "$@"
