#!/bin/sh
set -eu
exec "$(CDPATH= cd -- "$(dirname "$0")/.." && pwd -P)/bin/mandible" hook session-execution "$@"
