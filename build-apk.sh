#!/bin/bash
set -e

# Clean Windows PATH to avoid parentheses issues
export PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"

# Add Android SDK if available
if [ -d "$HOME/Android/Sdk" ]; then
  export ANDROID_HOME="$HOME/Android/Sdk"
  export PATH="$ANDROID_HOME/cmdline-tools/latest/bin:$ANDROID_HOME/platform-tools:$PATH"
fi

# Add node
export PATH="/usr/bin:$PATH"

cd /mnt/p/p01/apps/mobile

echo "=== Node: $(node --version) ==="
echo "=== NPM: $(npm --version) ==="
echo "=== Java: $(java -version 2>&1 | head -1) ==="
echo "=== ANDROID_HOME: $ANDROID_HOME ==="
echo "=== Starting EAS build ==="

npx eas build --platform android --profile preview --local --non-interactive 2>&1
