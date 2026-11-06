#!/usr/bin/env bash
# Package hygiene scan. Fails on content this repository must not ship:
# an em dash, a local home path, a LAN address, an email address, or a
# credential-shaped token.
#
# Usage: bash .github/scripts/hygiene-scan.sh [path ...]
# With no arguments it scans every tracked file plus every untracked file that
# is not ignored, skipping .hermes (a local work folder, never shipped).
set -u
cd "$(dirname "$0")/../.." || exit 1

if [ "$#" -gt 0 ]; then
  files=("$@")
else
  mapfile -t files < <(git ls-files --cached --others --exclude-standard | grep -v -E '^(\.hermes|\.git)/')
fi

if [ "${#files[@]}" -eq 0 ]; then
  echo "No files to scan."
  exit 0
fi

status=0
total=0

scan() {
  label=$1
  pattern=$2
  hits=$(printf '%s\0' "${files[@]}" | xargs -0 grep -n -I -E -e "$pattern" -- 2>/dev/null)
  if [ -n "$hits" ]; then
    count=$(printf '%s\n' "$hits" | wc -l)
    total=$((total + count))
    status=1
    printf '\n%s (%s hit(s)):\n%s\n' "$label" "$count" "$hits"
  fi
}

scan "em dash" $'\u2014'
scan "local home path" '/(home|Users)/[A-Za-z0-9._-]+'
scan "LAN address" '(^|[^0-9])(10\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}|192\.168\.[0-9]{1,3}\.[0-9]{1,3}|172\.(1[6-9]|2[0-9]|3[01])\.[0-9]{1,3}\.[0-9]{1,3})([^0-9]|$)'
scan "email address" '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}'
# Real provider tokens are far longer than 32 characters after the prefix. The
# shorter limit on the "sk-" family is deliberate: the test suite carries
# redaction fixtures such as "sk-live-" followed by 21 characters, and those
# must not fail the scan.
scan "credential-shaped token" '(sk-[A-Za-z0-9_-]{32,}|ghp_[A-Za-z0-9]{32,}|github_pat_[A-Za-z0-9_]{32,}|apikey_[A-Za-z0-9]{16,})'

if [ "$status" -ne 0 ]; then
  printf '\nHygiene scan failed: %s hit(s) across %s file(s).\n' "$total" "${#files[@]}"
  exit 1
fi

printf 'Hygiene scan clean: %s file(s).\n' "${#files[@]}"
