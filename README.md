# Goban

macOS 五子棋（Gomoku），用 [Native SDK](https://github.com/vercel-labs/native) 编写。

- 15×15 棋盘，黑先，五子连珠
- 落子 / 悔棋 / 新局
- 逻辑在 `src/core.ts`（TypeScript app-core，编译为原生代码）
- 界面在 `src/app.native`

## 要求

- macOS
- [Node.js](https://nodejs.org/) 22.15+（构建期用；发布二进制不含 JS 运行时）
- Native SDK CLI：

```sh
npm install -g @native-sdk/cli
```

## 开发

```sh
native check    # 校验 core + markup + app.zon
native dev      # 打开原生窗口，支持 markup 热更
native build    # Release 二进制 → zig-out/bin/
```

逻辑快速试跑（无窗口）：

```sh
printf '%s\n' '{"kind":"place","index":112}' '{"kind":"undo"}' | native dev --core
```

## 结构

```text
app.zon           # 应用清单（窗口、平台）
src/core.ts       # Model / Msg / update
src/app.native    # 棋盘 UI
assets/icon.png   # 图标
```

## 许可

MIT
