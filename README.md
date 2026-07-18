# Goban

macOS 五子棋（Gomoku），用 [Native SDK](https://github.com/vercel-labs/native) 编写。

## Features

- 15×15 board, Black first, five in a row
- **2 players** or **vs computer** (you Black, AI White)
- Place / Undo / New game
- Last-move + winning-line highlight
- Deterministic heuristic AI (blocks fours, makes threats)

Logic lives in `src/core.ts` (TypeScript app-core → native). UI in `src/app.native`.

> UI copy is English/ASCII for now — the SDK bundled font does not cover CJK glyphs on the reference path.

## Requirements

- macOS
- [Node.js](https://nodejs.org/) 22.15+ (build-time only; release binary has no JS runtime)
- Native SDK CLI:

```sh
npm install -g @native-sdk/cli
```

First build may download Zig 0.16 into `~/.native/toolchains/` (`native build --yes`).

## Develop

```sh
native check    # validate core + markup + app.zon
native dev      # native window, markup hot reload
native build    # ReleaseFast → zig-out/bin/
```

Logic-only smoke (no window):

```sh
printf '%s\n' '{"kind":"place","index":112}' '{"kind":"undo"}' | native dev --core
```

## Layout

```text
app.zon           # app identity / window
src/core.ts       # Model / Msg / update + AI
src/app.native    # board UI
assets/icon.png
```

## License

MIT
