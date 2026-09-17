#!/bin/sh
# Run explicitly as root on the production Mac after reviewing the source files.
set -eu

repo=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
anchor_name=com.apple/bio.mll.mandible-loopback443
anchor=/etc/pf.anchors/bio.mll.mandible-loopback443
helper=/usr/local/libexec/bio.mll.mandible-loopback443
plist=/Library/LaunchDaemons/bio.mll.mandible.loopback443.plist
token_file=/var/run/bio.mll.mandible-loopback443-token
label=bio.mll.mandible.loopback443

[ "$(id -u)" = 0 ] || { echo 'Run as root on the production Mac.' >&2; exit 1; }
/usr/bin/grep -Eq '^rdr-anchor "com\.apple/\*"' /etc/pf.conf || {
  echo 'The existing PF ruleset does not load the Apple child anchor; stop for review.' >&2; exit 1;
}

same_or_absent() {
  [ ! -e "$2" ] || cmp -s "$1" "$2" || {
    echo "Existing $2 differs; preserving it for review." >&2; exit 1;
  }
}

case "${1-}" in
  install)
    /sbin/pfctl -nf "$repo/config/loopback-443.pf"
    same_or_absent "$repo/config/loopback-443.pf" "$anchor"
    same_or_absent "$repo/scripts/loopback-443-activate.sh" "$helper"
    same_or_absent "$repo/config/bio.mll.mandible-loopback443.plist" "$plist"
    install -d -o root -g wheel -m 755 /usr/local/libexec /etc/pf.anchors
    install -o root -g wheel -m 644 "$repo/config/loopback-443.pf" "$anchor"
    install -o root -g wheel -m 755 "$repo/scripts/loopback-443-activate.sh" "$helper"
    install -o root -g wheel -m 644 "$repo/config/bio.mll.mandible-loopback443.plist" "$plist"
    if ! launchctl print "system/$label" >/dev/null 2>&1; then
      launchctl bootstrap system "$plist"
    else
      "$helper"
    fi
    # launchctl bootstrap queues RunAtLoad; it does not wait for the rule load.
    loaded=false
    attempt=0
    while [ "$attempt" -lt 40 ]; do
      rules=$(/sbin/pfctl -a "$anchor_name" -sn 2>/dev/null) || rules=
      count=$(printf '%s\n' "$rules" | /usr/bin/grep -c '^rdr pass on lo0 ' || true)
      if [ "$count" = 2 ] && printf '%s\n' "$rules" | /usr/bin/grep -Eq '^rdr pass on lo0 inet .*127\.0\.0\.1.*443.*127\.0\.0\.1.*19420' \
        && printf '%s\n' "$rules" | /usr/bin/grep -Eq '^rdr pass on lo0 inet6 .*::1.*443.*::1.*19420'; then
        loaded=true
        break
      fi
      attempt=$((attempt + 1))
      sleep 0.25
    done
    [ "$loaded" = true ] || { echo 'Mandible PF redirect did not become active; inspect the LaunchDaemon log.' >&2; exit 1; }
    printf '%s\n' "$rules"
    ;;
  remove)
    [ -f "$anchor" ] && [ -f "$helper" ] && [ -f "$plist" ] || {
      echo 'Mandible-owned PF files are incomplete; stop for review.' >&2; exit 1;
    }
    same_or_absent "$repo/config/loopback-443.pf" "$anchor"
    same_or_absent "$repo/scripts/loopback-443-activate.sh" "$helper"
    same_or_absent "$repo/config/bio.mll.mandible-loopback443.plist" "$plist"
    if launchctl print "system/$label" >/dev/null 2>&1; then
      launchctl bootout "system/$label"
    fi
    /sbin/pfctl -a "$anchor_name" -F nat
    if [ -f "$token_file" ]; then
      token=$(cat "$token_file")
      case "$token" in *[!0-9]*|'') echo 'Invalid PF enable token; stop for review.' >&2; exit 1;; esac
      /sbin/pfctl -X "$token"
      rm "$token_file"
    fi
    rm -f "$anchor" "$helper" "$plist"
    ;;
  *) echo 'Usage: loopback-443-operator.sh install|remove' >&2; exit 2;;
esac
