# Changelog

Notable changes to the Provider Usage plugin. Versions follow the tags in this
repository; the date is the release date.

## Unreleased

- Keep the last reading when the Hermes usage helper refuses, instead of
  dropping the provider for one refresh (#20).

## 0.3.1 (2026-10-23)

- MiniMax: read M Plan subscription keys and the percentage meter.
- Z.AI: read quota limits from the data envelope (#17).

## 0.3.0 (2026-10-21)

- Show Nous credit balances as money rows (#15).
- Honor a provider 429 `retry-after` and keep the last reading while held (#14).

## 0.2.1 (2026-10-15)

- Read `.env` and credential files as UTF-8 explicitly (#7).
- Carry the profile context into the provider fetcher threads (#10).
- Add the catalog banner and the README hero image.

## 0.2.0 (2026-10-02)

- OpenCode: reject a 403 key, guard non-JSON bodies, add the Kimi region
  fallback and the Anthropic fallback (#3).
- Add issue and pull request label automation (#4).

## 0.1.0 (2026-09-22)

- First package: agent manifest, dashboard backend, desktop status bar item
  and popover.
