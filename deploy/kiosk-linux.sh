#!/bin/sh
# TV player (Raspberry Pi / Linux mini PC). Add to the desktop session's autostart.
# Usage: kiosk-linux.sh http://board-server:8080/board/main
URL="${1:?board URL required}"
xset s off; xset -dpms; xset s noblank 2>/dev/null
BROWSER=$(command -v chromium || command -v chromium-browser || command -v google-chrome)
exec "$BROWSER" --kiosk --noerrdialogs --disable-infobars --incognito \
  --disable-session-crashed-bubble --check-for-update-interval=31536000 "$URL"
