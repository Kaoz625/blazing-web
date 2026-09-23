#!/bin/bash
# Build "Blazing Games.app" and install it to /Applications.
#
# Everything here is repeatable from the two files next to it, so the .app
# itself is NOT committed — a 130KB binary blob in git that nobody can diff is
# how a stale build ships. `bash mac/build-app.sh` rebuilds it in a second.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
APP="/Applications/Blazing Games.app"
BUILD="$HERE/build/Blazing Games.app"

python3 "$HERE/make-icon.py"

rm -rf "$HERE/build"
mkdir -p "$HERE/build"
osacompile -o "$BUILD" "$HERE/BlazingGames.applescript"

# osacompile writes its own generic applet icon. Overwrite it under the name
# the generated Info.plist already points at (applet.icns) rather than adding
# a second icon key — a bundle with two icon sources picks the one you did not
# mean and the Dock caches it for hours.
cp "$HERE/BlazingGames.icns" "$BUILD/Contents/Resources/applet.icns"

/usr/libexec/PlistBuddy -c "Set :CFBundleName 'Blazing Games'" "$BUILD/Contents/Info.plist"
/usr/libexec/PlistBuddy -c "Add :CFBundleDisplayName string 'Blazing Games'" "$BUILD/Contents/Info.plist" 2>/dev/null \
  || /usr/libexec/PlistBuddy -c "Set :CFBundleDisplayName 'Blazing Games'" "$BUILD/Contents/Info.plist"
/usr/libexec/PlistBuddy -c "Add :CFBundleIdentifier string com.lyreosai.blazing.games" "$BUILD/Contents/Info.plist" 2>/dev/null \
  || /usr/libexec/PlistBuddy -c "Set :CFBundleIdentifier com.lyreosai.blazing.games" "$BUILD/Contents/Info.plist"
/usr/libexec/PlistBuddy -c "Add :CFBundleShortVersionString string 1.0.0" "$BUILD/Contents/Info.plist" 2>/dev/null \
  || /usr/libexec/PlistBuddy -c "Set :CFBundleShortVersionString 1.0.0" "$BUILD/Contents/Info.plist"

rm -rf "$APP"
cp -R "$BUILD" "$APP"
# A bundle whose mtime has not moved keeps the OLD icon in the Dock and in
# Finder for as long as the icon cache holds it, which reads as "the build did
# not work".
touch "$APP"

echo "installed: $APP"
/usr/libexec/PlistBuddy -c "Print :CFBundleIdentifier" "$APP/Contents/Info.plist"
