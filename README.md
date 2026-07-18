# Goban

macOS 五子棋（Gomoku）— personal daily driver, built with [Native SDK](https://github.com/vercel-labs/native).

## Features

- 15×15 board, Black first, five in a row
- **2 players** or **vs computer** (you Black, AI White)
- Place / Undo / New game
- Last-move + winning-line highlight
- Heuristic AI with fork detection (blocks fours, open threes, double threats)
- Menu bar + keyboard shortcuts
- Packaged `.app` (adhoc signed)

> UI copy is English/ASCII — the SDK bundled font does not cover CJK on the reference path.

## Personal use (fast path)

```sh
cd ~/goban
native build
native package --target macos --signing adhoc --output dist/Goban.app
open dist/Goban.app
```

Or from a previous package:

```sh
open ~/goban/dist/Goban.app
```

Optional: drag `dist/Goban.app` into `/Applications` (or keep it in `~/goban/dist`).

### Shortcuts

| Action | Shortcut |
|--------|----------|
| New game | **⌘N** |
| Undo | **⌘Z** |
| 2 players | **⌘1** |
| vs computer | **⌘2** |

Also under menu **Game** / **Mode**.

In vs-computer mode, **⌘Z** undoes your last move *and* the AI reply.

## Develop

Requirements: macOS, Node 22.15+, `npm i -g @native-sdk/cli`.

```sh
native check    # core + markup + app.zon
native dev      # window + markup hot reload
native build    # zig-out/bin/goban
```

First build may download Zig 0.16 (`native build --yes`).

Logic-only smoke:

```sh
printf '%s\n' '{"kind":"place","index":112}' '{"kind":"undo"}' | native dev --core
```

## Layout

```text
app.zon           # identity, menus, shortcuts, window
src/core.ts       # Model / Msg / update / AI / commandMsg
src/app.native    # board UI
assets/icon.png
dist/Goban.app    # package output (gitignored)
```

## License

MIT
