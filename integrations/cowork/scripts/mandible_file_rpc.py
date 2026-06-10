#!/usr/bin/env python3
"""Minimal Mandible file-RPC client for sandboxed sessions.

Usage:
  mandible_file_rpc.py <spool_dir> <METHOD> <path> [body.json | -]

Writes {id, method, path, body?} as <id>.request.json, polls for
<id>.response.json, prints the response body JSON, and exits 0 on 2xx.
"""

from __future__ import annotations

import json
import os
import random
import sys
import time


def main() -> int:
    if len(sys.argv) < 4:
        print(__doc__, file=sys.stderr)
        return 2

    spool, method, request_path = sys.argv[1], sys.argv[2].upper(), sys.argv[3]
    body = None
    if len(sys.argv) > 4:
        raw = sys.stdin.read() if sys.argv[4] == "-" else open(sys.argv[4], encoding="utf8").read()
        body = json.loads(raw)

    os.makedirs(spool, exist_ok=True)
    request_id = f"cowork-{random.randrange(16**6):06x}-{os.getpid()}-{int(time.time())}"
    request = {"id": request_id, "method": method, "path": request_path}
    if body is not None:
        request["body"] = body

    temp_path = os.path.join(spool, f"{request_id}.request.json.tmp")
    request_file = os.path.join(spool, f"{request_id}.request.json")
    response_file = os.path.join(spool, f"{request_id}.response.json")
    with open(temp_path, "w", encoding="utf8") as handle:
        json.dump(request, handle)
    os.rename(temp_path, request_file)

    deadline = time.time() + float(os.environ.get("MANDIBLE_FILE_RPC_TIMEOUT", "15"))
    while time.time() <= deadline:
        if os.path.exists(response_file):
            time.sleep(0.05)
            with open(response_file, encoding="utf8") as handle:
                response = json.load(handle)
            status = int(response.get("status", 500))
            json.dump(response.get("body"), sys.stdout, indent=2)
            print()
            return 0 if 200 <= status < 300 else 1
        time.sleep(0.05)

    print('{"error":"file_rpc_timeout"}', file=sys.stderr)
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
