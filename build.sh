#!/usr/bin/env bash
# SDK-only build, including pinned Java WebSocket dependencies.
set -euo pipefail
cd "$(dirname "$0")"
if [ -n "${JAVA_HOME:-}" ]; then export PATH="$JAVA_HOME/bin:$PATH"; fi
exec python3 tools/build_android.py
