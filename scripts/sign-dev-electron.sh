#!/bin/sh
# Keep the dev-shell Electron signed with a stable identity so macOS TCC
# grants (mic, screen recording, Automation) survive rebuilds and npm
# reinstalls. Ad-hoc signatures change cdhash on every install, which makes
# TCC forget every grant. Requires the self-signed "Claudely Dev Local"
# certificate in the login keychain.
set -e
APP="$(dirname "$0")/../node_modules/electron/dist/Electron.app"
IDENTITY="Claudely Dev Local"

[ -d "$APP" ] || exit 0

if codesign -dv "$APP" 2>&1 | grep -q "Signature=adhoc"; then
  echo "[sign-dev-electron] re-signing dev Electron with '$IDENTITY'"
  codesign --force --deep --sign "$IDENTITY" "$APP"
else
  echo "[sign-dev-electron] dev Electron already stably signed"
fi
