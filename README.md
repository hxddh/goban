# 五子棋 Goban

macOS 五子棋 — 木色棋盘、网格线、圆子、星位、中文界面。

窗口用 [Native SDK](https://github.com/vercel-labs/native) + 系统 WebView，棋盘用 Canvas 绘制；UI 从 `frontend/dist` 资源加载。

## 下载

见 [Releases](https://github.com/hxddh/goban/releases) 中的 **Goban-macOS-arm64.zip**（Apple Silicon）。

```bash
# 解压后拖到「应用程序」，或：
unzip Goban-macOS-arm64.zip
open Goban.app
```

> adhoc 签名，本机使用即可。若 Gatekeeper 拦截：右键 → 打开。

## 本地已安装

```bash
open ~/Applications/Goban.app
```

## 怎么玩

| 操作 | 说明 |
|------|------|
| 点交叉点 | 落子（加大吸附） |
| 人机 / 双人 | 侧栏「对局设置」（**Tab** / **☰** / **⌘T**） |
| 难度 / 执子 | 人机时显示；双人自动隐藏 |
| 音效 / 主题 | 侧栏「外观」（默认折叠） |
| 全屏 | 系统菜单 **View → Enter Full Screen（⌘⌃F）**；绿键为 Zoom 放大 |
| 动效 | 落子缩放；最后一手为**低对比细环**；胜线静态标出 |
| 执子 | 执黑 / 执白（人机） |
| 悔棋 | **Z** / **⌘Z** / 菜单「对局」 |
| 新局 | **N** / **⌘N** / 菜单 |
| 存档 | 自动存档；失活/退出时保存；窗口位置记忆 |
| 复盘 | **← → Home End** |
| 棋谱 | 复制 / 导出 SGF（导出后在 Finder 显示） |
| 模式 | **⌘1** 双人 · **⌘2** 人机（有棋时确认） |
| 说明 | **?** |

先连成五子者胜。沉浸模式：收起侧栏后棋盘铺满窗口。

## 开发

```bash
cd ~/goban
cp src/board.html frontend/dist/index.html
export PATH="$HOME/.native/toolchains/zig-0.16.0:$PATH"
zig build -Doptimize=ReleaseFast
native package --target macos --signing adhoc --output dist/Goban.app --binary zig-out/bin/goban
cd dist && ditto -c -k --sequesterRsrc --keepParent Goban.app Goban-macOS-arm64.zip && rm -rf Goban.app
```

主界面：`src/board.html` → 同步到 `frontend/dist/index.html` 后打包进 Resources。

## 许可

MIT
