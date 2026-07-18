# 五子棋 Goban

macOS 五子棋 — 木色棋盘、网格线、圆子、星位、中文界面。

窗口用 [Native SDK](https://github.com/vercel-labs/native) + 系统 WebView，棋盘用 Canvas 绘制。

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
| 点交叉点 | 落子 |
| 人机 / 双人 | 侧栏切换（**Tab** / **☰** 收起侧栏） |
| 难度 | 简单 / 普通 / 困难（人机） |
| 执子 | 执黑 / 执白（人机，执白则电脑先手） |
| 悔棋 | **Z** 或按钮 |
| 新局 | **N** 或按钮 |
| 存档 | **自动存档**，下次打开续下；可「清除存档并新局」 |
| 复盘 | 侧栏 **|&lt; &lt; &gt; &gt;|** 或 **← → Home End** |
| 棋谱 | **复制 / 导出 SGF** |
| 说明 | **?** 查看快捷键 |

先连成五子者胜。沉浸模式：收起侧栏后棋盘铺满窗口。

## 开发

```bash
cd ~/goban
# 需要 Zig 0.16（native 工具链）
zig build -Doptimize=ReleaseFast
native package --target macos --signing adhoc --output dist/Goban.app --binary zig-out/bin/goban
```

主界面源码：`src/board.html`（嵌入到二进制）。

## 许可

MIT
