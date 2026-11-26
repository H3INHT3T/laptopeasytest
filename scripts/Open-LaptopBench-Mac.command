#!/bin/bash
# LaptopBench QC - macOS First-Launch Gatekeeper Helper
# Created by Hein Htet Zaw (Telegram: @ich8g92)
# Removes macOS browser download quarantine flag from LaptopBench QC.app and launches it.

APP_PATH="/Applications/LaptopBench QC.app"
if [ ! -d "$APP_PATH" ]; then
  SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
  if [ -d "$SCRIPT_DIR/LaptopBench QC.app" ]; then
    APP_PATH="$SCRIPT_DIR/LaptopBench QC.app"
  elif [ -d "$HOME/Applications/LaptopBench QC.app" ]; then
    APP_PATH="$HOME/Applications/LaptopBench QC.app"
  fi
fi

if [ ! -d "$APP_PATH" ]; then
  echo "============================================================"
  echo " LaptopBench QC.app was not found in /Applications."
  echo " 1. Open LaptopBench.QC_universal.dmg"
  echo " 2. Drag 'LaptopBench QC' into Applications"
  echo " 3. Double-click this file again."
  echo "============================================================"
  read -r -p "Press Enter to close..."
  exit 1
fi

echo "Clearing macOS quarantine flag on: $APP_PATH"
xattr -cr "$APP_PATH" 2>/dev/null || sudo xattr -cr "$APP_PATH"
echo "Launching LaptopBench QC..."
open "$APP_PATH"
