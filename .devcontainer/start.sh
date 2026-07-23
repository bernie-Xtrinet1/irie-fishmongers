#!/usr/bin/env bash
# postAttachCommand: delegate to the hardened demo start script, which derives
# public URLs from the Codespaces environment, writes frontend .env.local
# files, clears stale Next caches on URL change, starts the stack once, and
# verifies real HTTP health before declaring success.
exec bash "$(dirname "$0")/../scripts/start-codespaces-demo.sh"
