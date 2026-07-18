# 五子棋 Goban

macOS 五子棋 — Native SDK WebView + Canvas。

## 下载

[Releases](https://github.com/hxddh/goban/releases) → **Goban-macOS-arm64.zip**（Apple Silicon）。

```bash
open ~/Applications/Goban.app   # 本地安装路径
```

## 怎么玩

| 操作 | 说明 |
|------|------|
| 点交叉点 | 落子 |
| 侧栏 | **Tab** 开关；本局 / 对局设置 / 外观 / 棋谱 |
| 人机设置 | 难度、执子（双人时隐藏） |
| 全屏 | **View → Enter Full Screen（⌘⌃F）**；绿键 Zoom |
| 棋谱 | 复制 / 导出 / **导入 SGF**（或拖入 `.sgf`） |
| 悔棋 / 新局 | **Z** / **N**（有棋时确认） |
| 说明 | **?** |

## 开发

```bash
cd ~/goban
# 一键：同步 frontend → 编译 → 打包 zip → 安装到 ~/Applications
./scripts/package.sh
```

源码布局（v1.9）：

```
src/web/
  index.html · styles.css
  js/core.js    # 规则（纯）
  js/sgf.js     # SGF
  js/ai.js      # AI
  js/host.js    # Native / localStorage 门面
  js/state.js   # 对局状态工厂 / 导入快照
  js/app.js     # UI 编排
src/main.zig
scripts/package.sh
scripts/test-game.mjs   # node 单测 core/sgf/state
```

`frontend/dist` 由脚本从 `src/web` 生成。测试：`node scripts/test-game.mjs`

## 许可

MIT
