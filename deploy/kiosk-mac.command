#!/bin/sh
# TV player (Mac). Add as a Login Item, or push as a LaunchAgent via Mosyle.
# Usage: kiosk-mac.command http://board-server:8080/board/main
URL="${1:?board URL required}"
caffeinate -dis &
open -a "Google Chrome" --args --kiosk --noerrdialogs --disable-session-crashed-bubble "$URL"
