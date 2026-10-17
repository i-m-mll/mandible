#!/usr/bin/env bash

set -o pipefail
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"

api_send PATCH "/api/sessions/$(urlencode "$session_id")/end" '{"status":"ended"}' >/dev/null || exit 1
