# 五子棋 Goban

五子棋 / Gomoku — macOS 与 Windows 桌面应用。Native SDK WebView + Canvas，**完全离线**：不联网、不要账号、没有任何外部请求。

*A Gomoku (Five in a Row) desktop app for macOS and Windows. Offline, no account, no network. Renju forbidden moves, swap2 opening, game review with a score curve, and tactics practice. Chinese / English.*

![对局中：人机 · 普通难度 · 执黑](docs/screenshots/board.png)

## 下载

[Releases](https://github.com/hxddh/goban/releases) 页任选：

| 平台 | 产物 |
|------|------|
| macOS（Apple Silicon） | **Goban-macOS-arm64.zip** |
| Windows（x64） | **Goban-Windows-x64.zip** |

### macOS 首次打开

安装包是 adhoc 签名、**未经 Apple 公证**，所以第一次打开要手动放行一次，之后就和普通应用一样：

1. 解压，把 `Goban.app` 拖进「应用程序」（或 `~/Applications`）
2. 双击 —— 会提示无法验证开发者，点「完成」
3. 打开**系统设置 → 隐私与安全性**，下滑到「安全性」一栏，点 **「仍要打开」**，再确认一次

> **macOS 15（Sequoia）起，「右键 → 打开」这条旧路子已被 Apple 移除**，只能走系统设置。

嫌麻烦，一行命令也行：

```bash
xattr -dr com.apple.quarantine /Applications/Goban.app
# 放在个人目录下的话：xattr -dr com.apple.quarantine ~/Applications/Goban.app
```

### Windows 首次打开

解压后运行 `Goban/goban.exe`。需要 WebView2 运行时（Win10 / 11 一般已预装）。
首次 SmartScreen 会拦一次 —— 点「更多信息 → 仍要运行」。

## 四套棋盘

| 木盘 | 夜盘 |
|:---:|:---:|
| ![木盘](docs/screenshots/theme-wood.png) | ![夜盘](docs/screenshots/theme-night.png) |
| **日间** | **练习本** |
| ![日间](docs/screenshots/theme-day.png) | ![练习本](docs/screenshots/theme-notebook.png) |

## 复盘

一键分析整局：评分曲线 + 失着列表，点任意一处跳到那一手。可导出带评注的 SGF，也可以就地推演。

![复盘分析：评分曲线与失着列表](docs/screenshots/review.png)

## 怎么玩

| 操作 | 说明 |
|------|------|
| 点交叉点 | 落子（须在最新一手；悬停有预览） |
| 侧栏 | 顶栏 **☰** 或 **[** / **]** 开关；对局设置 / 棋谱 / 底部功能入口 |
| 设置 | 顶栏**齿轮**：主题 / 坐标 / 复盘分析 / 语言 / 音效（v1.51 起从侧栏搬进这里） |
| 人机 | 难度 简/普/难/**极**；执子；难与极 = **C2 引擎**（增量窗口表深搜索 + 战术级联），并多出一行「思考」快/标/深（约 0.8 / 2 / 3.5 秒） |
| 提示 | **H** / 顶栏「提示」：虚线十字建议点（不自动落子；**复盘中也可用**） |
| 全屏 | **View → Enter Full Screen（⌘⌃F）**；绿键 Zoom |
| 棋谱 | 手数列表点击跳转；复制 / 导出 / 导入 / **粘贴** SGF（可拖入 `.sgf`） |
| 存档 | 侧栏底部「**存档**」：命名保存当前对局、历史列表、读取 / 重命名 / 删除；另有全部数据的备份 / 恢复 |
| 复盘 | 侧栏底部「**复盘**」：一键全局分析 → **评分曲线 + 失着列表**，点曲线或失着跳转；可**导出带评注 SGF**、**推演**当前局面（虚影主变） |
| 规则 | 侧栏·对局「**规则**」三选一 —— 都是「黑先手占优，拿什么补」的答案：**自由**（无禁手、标准开局）/ **swap2**（平衡开局：先手布 3 子，对手选边或加两手；人机下电脑按局面自动选边）/ **禁手**（连珠：黑不得长连、双四、双三，且只有恰好五连算胜；禁手点在盘上画小方框）|
| 禁手档 | **人机可用**：引擎在交货口验一次落子合法性（v1.55），实测自战 12 局 × 2 引擎违规手 **0**。**复盘 v1.56 起也可用**：胜负硬判定（制胜 / 错失胜着 / 漏防）与「更优点」都已按规则算；只剩优劣曲线仍按无禁手估——实测 8 局合法连珠自战 341 手黑棋，黑的静态首选点有 **3.5%** 是禁手点，曲线在这些局面偏乐观。这条偏差就写在复盘弹层里 |
| 练习 | 侧栏底部「**练习**」：战术做题——**找制胜一手 / 挡住成五威胁 / 连续冲四取胜（VCF）**；**130 道内置题**（制胜 50 · 防守 45 · VCF 35）+ 从你对局的失着自动生成；答错给正解讲解，VCF 题**按序号摆出整条制胜顺序**；出题顺序为 未做过 → 错题 → 已掌握 |
| 错题本 | 练习弹窗「**错题本**」：只做做错过、还没做对的题；答对一次即移出。进度（做过 / 已掌握 / 错题）进「统计」 |
| 每日 | 侧栏底部「**每日**」：每日挑战——每天固定 **5 题**（当天重进同一套题），完成打卡；**连续打卡天数**进统计 |
| 语言 | 齿轮「**语言**」：中文 / English 全界面切换（含运行时文案），选择随存档保留 |
| 统计 | 侧栏底部「**统计**」：分难度胜负与胜率、连胜、总局数/手数/用时 |
| 导入后 | 默认仅复盘；未终局可点 **续下** 继续（含 AI） |
| 坐标 | 齿轮：A–O / 15–1 标注开关 |
| 复盘分析 | 齿轮：开启后复盘逐手标注优劣（**制胜/错失胜着/漏防/最佳/更优**）；金色菱形指向引擎更优点 |
| 悔棋 / 新局 | **Z** / **N**（有棋时确认） |
| 说明 | **?**（含完整快捷键表与当前版本号） |

## 开发

```bash
cd ~/goban
# 一键：同步 frontend → 单测 → 编译 → 打包 zip → 安装到 ~/Applications
./scripts/package.sh
```

源码布局：

```
src/web/
  index.html · styles.css
  js/core.js       # 规则（纯）
  js/sgf.js        # SGF
  js/ai.js         # C1 引擎：棋型 / VCF·VCT / 迭代 α-β（简/普）
  js/ai2.js        # C2 引擎：增量窗口表 + 深搜索（难/极）
  js/ai-worker.js  # 普通·困难后台计算
  js/host.js       # Native / localStorage 门面
  js/state.js      # 对局状态 / 导入快照
  js/draw.js       # 棋盘 Canvas 渲染
  js/audio.js      # 离线合成音效
  js/slots.js      # 命名存档槽（存取 + 列表渲染）
  js/review.js     # 复盘：评分曲线 / 失着检出
  js/stats.js      # 对局统计
  js/practice.js   # 战术练习 + 每日挑战 + 错题本（独立小棋盘）
  js/i18n.js       # 中英词典 + t() + 静态标记应用
  js/ui.js         # 展示层：toast / 格式化 / 弹层焦点 / 手数列表 / swap2 提示条
  js/sgfio.js      # SGF 导出：复制 / 保存对话框 / 下载兜底
  js/engine.js     # 引擎桥接：Worker 生命周期 + 降级兜底
  js/app.js        # UI 编排
src/main.zig · src/runner.zig
scripts/package.sh
scripts/test-game.mjs
```

`frontend/dist` 由脚本从 `src/web` 生成。测试：`node scripts/test-game.mjs`；浏览器回归：`node scripts/test-cross.mjs`、`node scripts/test-daily.mjs`

截图由 `scripts/gen-screenshots.mjs` 从 `src/web` 真实渲染生成（Chromium），不是手工拼的。

## 许可

MIT
