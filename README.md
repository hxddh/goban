# 五子棋 Goban

macOS 五子棋 — **真正的棋盘 UI**（木色盘、网格线、圆子、星位、中文）。

用 [Native SDK](https://github.com/vercel-labs/native) 包一层系统 WebView，棋盘用 Canvas 绘制。

## 打开

```bash
open ~/Applications/Goban.app
```

或开发：

```bash
cd ~/goban
native dev
```

## 怎么玩

| 操作 | 说明 |
|------|------|
| 点棋盘交叉点 | 落子（黑先） |
| 人机对战 | 你执黑，电脑执白 |
| 双人对战 | 本机两人轮流 |
| 悔棋 | 按钮或 **Z** |
| 新局 | 按钮或 **N** |

先连成五子者胜。

## 工程

```text
app.zon                 # Native 窗口 + WebView
frontend/dist/index.html  # 完整棋盘与规则（Canvas）
assets/icon.png
```

```bash
native build
native package --target macos --signing adhoc --output dist/Goban.app
ditto dist/Goban.app ~/Applications/Goban.app
```

## 许可

MIT
