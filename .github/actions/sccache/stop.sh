#!/usr/bin/env bash

echo "=== sccache stats ==="
sccache --show-stats || true
sccache --stop-server 2>/dev/null || true
