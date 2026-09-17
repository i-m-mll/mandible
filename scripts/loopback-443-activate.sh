#!/bin/sh
set -eu

anchor=/etc/pf.anchors/bio.mll.mandible-loopback443
token_file=/var/run/bio.mll.mandible-loopback443-token

if [ ! -f "$token_file" ]; then
  output=$(/sbin/pfctl -E 2>&1)
  token=$(printf '%s\n' "$output" | sed -n 's/.*Token : \([0-9][0-9]*\).*/\1/p')
  if [ -z "$token" ]; then
    printf 'Could not retain Mandible PF enable token: %s\n' "$output" >&2
    exit 1
  fi
  (umask 077; printf '%s\n' "$token" > "$token_file")
fi

/sbin/pfctl -a com.apple/bio.mll.mandible-loopback443 -f "$anchor"
