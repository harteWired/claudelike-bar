# Changelog

All notable changes to **Claudelike Bar** are documented here. Versions follow [semantic versioning](https://semver.org/); dates are ISO-8601.

## [0.20.2] — 2026-06-19

### Fixed
- **Broadcast no longer rate-limits Claude (#68).** Broadcasting to all tracked terminals previously submitted every session's turn in the same instant, tripping the API rate limit. Sends are now staggered by `broadcastStaggerMs` (default 1000ms; set to `0` for the old instant fan-out) and run under a progress notification. Per-terminal failures are still isolated and tallied; an all-failed broadcast now surfaces a clear warning.

## [0.20.1] — 2026-06-11

Shipped together as the first stable release since 0.18.2, folding in everything from the 0.19.x organizer line and the 0.20.0 broadcast feature.

### Added
- **Pin-persistence for always-on watch terminals.** Pinned terminals with `autoStart: true` now keep their pin when the terminal exits, so always-on "watch/stream" panes survive a VS Code restart. Manual ad-hoc pins still auto-clear on close. (#48)
- **Watch / stream terminal docs.** `docs/terminal-configuration.md` now documents the always-on pinned-pane pattern (`type: "shell"` + `command` + `autoStart` + `pinned`) for streaming a remote log into a tile at zero token cost.

## [0.20.0] — 2026-06-01

### Added
- **Broadcast command (#55).** A Command Palette action that fans a single string out to every tracked Claude Code terminal at once — pre-filled InputBox, results surfaced in an output channel.

## [0.19.1] — 2026-05-20

### Changed
- **Organizer target-state refactor (#46).** The organizer panel moved to a declarative target-state model, fixing a cluster of drag/visibility bugs:
  - Drag from "Closed but visible" → Auto-sort or Pinned now reopens the terminal. (#44)
  - Tile state matches terminal state after an organizer drag — no more "launched but bar shows offline until you interact". (#45)
  - Removed `isDropAllowed` rejections the target-state model legitimizes. (#47)
  - Pinned tile drops its pin when its terminal exits. (#48)

## [0.19.0] — 2026-05-10

### Added
- **Tile-organizer panel.** Drag tiles between visibility lanes (Pinned / Auto-sort / Closed-but-visible / Hidden) from a dedicated webview.
- **Ready-state UX** polish, alphabetical sort for registered (offline) tiles, and per-tile focus hotkeys.

### Fixed
- Hidden-lane filter, `onChange` sync, and drop-to-close behavior in the organizer (#38, #39, #40, #41).

## [0.18.2] — 2026-05-03

- Duplicate-install detection: warn when both the Marketplace and Open VSX builds are installed (#32).

---

[0.20.1]: https://github.com/harteWired/claudelike-bar/releases/tag/v0.20.1
[0.20.0]: https://github.com/harteWired/claudelike-bar/releases/tag/v0.20.0
[0.19.1]: https://github.com/harteWired/claudelike-bar/releases/tag/v0.19.1
[0.19.0]: https://github.com/harteWired/claudelike-bar/releases/tag/v0.19.0
[0.18.2]: https://github.com/harteWired/claudelike-bar/releases/tag/v0.18.2
