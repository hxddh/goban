# v3.2.0 全面评审 + 底层依赖新版本

评估日期：2026-11-13。基准：main `da1edc8`（v3.2.0）。
范围：这一次**不只看对弈**——规则核心、宿主（Zig）、持久化、SGF、CI，以及底层依赖有没有新版本、新版本里有什么可以用上。
方法：读源码；`node scripts/test-game.mjs`（all passed）+ 四套浏览器回归（结果见文末）；可疑处写小脚本实测，标 **实测** 的都跑出来过，标 **读码** 的是从代码推断；SDK 0.11.0 / 0.11.1 两个 npm 包逐文件对比。

> **状态：只是评估，没有改代码。** 需要你决定的在最后一节。

---

## 一、结论先说

1. **连珠禁手判定有两处真错**（实测）：一处把合法黑棋判成「双三」不让下，一处放过「同一条线上的双四」。禁手是这个应用写在门面上的规则，引擎、练习题「找禁手点」、复盘都建立在 `core.js` 这一处判定上——**这是这一版最该修的**。
2. **宿主读文件超过 256 KB 会被悄悄截断**（读码 + 估算）：备份恢复和 SGF 导入走的都是它，对局库长了以后恢复会失败并报「文件损坏」。
3. **安全面偏宽**：网页能让宿主读写**任意绝对路径**；开发用的 `http://127.0.0.1:5173` 留在了正式包的白名单里；页面没有 CSP。
4. **依赖**：`@native-sdk/cli` 出了 **0.11.1**（11-09）；Zig 出了 **0.17.1**；Node **26** 已是 Active LTS。其中只有 SDK 0.11.1 会**自动**进下一次构建（CI 不锁版本），它有一处**静默的行为变化**（见第四节）。

---

## 二、正确性问题（按严重程度）

| # | 位置 | 问题 | 怎么触发 | 证据 |
|---|---|---|---|---|
| B1 | `core.js:132-155` | 「活四」判定把「同一条线上有两个不同的成五点」也算成活四，于是 `B.B.B.B` 这类线被当成活三 | 黑 (7,3)(7,7)(7,9) + 纵向真活三 (6,5)(8,5)，黑下 (7,5)：`renjuForbidden` 回 `double3`。按 RIF 横线不是三（补任何一点都成不了真活四 `.BBBB.`），这一手合法，却被 `place()` 拒绝；引擎的 `legalizeRenju` 也会避开它 | **实测** |
| B2 | `core.js:170-174` | 每个方向最多算一个四，漏掉「同线双四」 | 黑 (7,3)(7,5)(7,7)(7,9)，下 (7,6) 成 `B.BBB.B`——两个成五点，是禁手。`renjuForbidden` 回 `null`：人能下，**引擎交货口的合法性检查也放行，引擎自己会违规** | **实测** |
| B3 | `engine.js:270-272` | `moveAsync` 认为「worker 忙 = 只剩过期任务」，直接重建 worker、把所有在途请求回 `null` | 复盘后台的引擎比较（`Review.deepen`，约 8 × 500ms）进行中按 **H**：提示把 worker 重建，复盘那条拿到 `null`；复盘下一条又重建，提示拿到 `null` 显示「没有提示」；复盘的「已深算」永远完不成 | 读码（重建逻辑已核对） |
| B4 | `app.js:88-153` | 导入 SGF 不清 `lastArchiveId` | 从「对局」打开一局没下完的（id = X）→ 导入 SGF → 续下到终局：`recordGameEnd` 见 X 仍是 `play`，用导入的棋**覆盖**库里那一局（模式、规则都不对） | 读码 |
| B5 | `app.js:1884-1891` | 从库里接着下完的一局，悔棋会把整条记录删掉 | `removeByEndedAt` 删的是原条目（连同重下分支 `lines`），而不是退回 `play` | 读码 |
| B6 | `archive.js` `valid()`、`backup.js:316-333` | 对局库只校验「history 是非空数组」 | 恢复一份含 `{r:20,c:3}` 或 `null` 手的备份：`inspect` 回 ok；之后 `Practice.dueCount()` 抛 TypeError，**练习打不开** | **实测** |
| B7 | `sgf.js:156-183` | `extractMainline` 每个 `(` 递归一层 | 约 6 万层括号（远低于 200 KB 上限）栈溢出：粘贴时是未处理的 rejection、无任何提示；文件导入时报「读取失败」 | **实测** |
| B8 | `sgf.js:216` | 着手扫描用正则，`B`/`W` 前只认 `;(` `)` 空白 | `;N[x]B[ij]`、`;B[hh]W[hi]` 丢手（末手丢了就悄悄截短）；`PB[Alice B[hh]` 从人名里**造出**一手；`GN[.. RU[renju] ..]` 会把棋谱当连珠读；`SZ[19:19]` 不校验 | **实测** |
| B9 | `backup.js:341-349` | 恢复时不检查每次写入是否成功 | 配额满在半路：回 ok、重载后一半是旧数据一半是备份 | 读码 |
| B10 | `main.zig` `readTextFile` | 读缓冲 256 KB，`readPositionalAll` 填满即返回——**超出部分静默丢弃**；写入解码上限 384 KB | 备份是 `JSON.stringify(..., null, 2)`。按 `{r,c}` 的实际存法估算：100 局 × 60 手 ≈ 170 KB，100 局 × 100 手 ≈ 243 KB，再加练习进度、重下分支就过 256 KB → 恢复读到半截 → 报「备份文件损坏」。SDK 桥本身的上限是 1 MB（`bridge.max_message_bytes` / `max_response_bytes`），瓶颈在我们自己的缓冲 | 读码 + 估算 |

小问题（读码）：

- `draw.js:134-140` 只在尺寸变化时重算像素比：窗口拖到另一块 DPR 不同、CSS 尺寸相同的屏上，棋盘可能一直是糊的。
- 连珠下黑方无合法点时 `legalizeRenju` 仍交出禁手点，`place()` 拒绝后没人再问引擎——电脑不走了。极少见。
- `engine.js:213` 每次重新初始化都 `createObjectURL`，旧的不 revoke。
- 死代码：`app.js` 的 `aiMoveSync` / `bytesToBase64` / `copySgfText`；`engine.js` 的 `useWorker = true` 常量分支。

查过、没问题的：XSS（`innerHTML` 只接 i18n 文本与坐标，SGF 注释与人名不进 DOM 或走 `textContent`）；中英词典键完全一致；存档恢复 `applySnapshot` 校验充分；`gameGen` 在新局 / 悔棋 / 载入 / 导入时都挡住了过期的 AI 结果。

结构上：`app.js` 2732 行、`practice.js` 1915 行。B4、B5 的根因相同——「导入 / 重下 / 从库里打开」各自手动重置一部分状态。一个「开始新的对局上下文」的函数能一并解决。

---

## 三、安全面

| 项 | 现状 | 建议 |
|---|---|---|
| 任意路径读写 | `goban.writeTextFile` / `readTextFile` 接受网页给的任何绝对路径 | 只接受**刚由保存 / 打开对话框返回**的路径（宿主记一个短时白名单），或改用 SDK 的 `zero.dialogs` 返回句柄后由宿主读写 |
| 开发源进正式包 | `allowed_origins` 和桥策略都含 `http://127.0.0.1:5173` | 只在 Debug 构建里加 |
| 没有 CSP | 脚本全是本地文件，worker 来自 Blob | `default-src 'self'; script-src 'self'; worker-src blob:; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'none'`——顺带把「不联网」从承诺变成机制 |
| Web Inspector | SDK 0.11.0 在 macOS 上**一律打开**（发布包也能被 Safari 远程检查） | 0.11.1 已改为默认关闭，见下节 |

---

## 四、底层依赖：有没有新版本

| 组件 | 现在 | 最新 | 结论 |
|---|---|---|---|
| `@native-sdk/cli` / `core` | 0.11.0（v3.2.0 用它打包；**CI 不锁版本**） | **0.11.1**（2026-11-09） | 下一次构建会自动用上。要跟一处改动（见下） |
| Zig | 0.16.0（`minimum_zig_version`，setup-zig 照它装） | **0.17.1**（11-02；0.17.0 是 10-01） | **先别升**：SDK 0.11.1 仍钉 0.16（`toolchain.zig: pinned_zig_version = "0.16.0"`）。我们自己的代码迁移量小（`build.zig:116,166` 的 `.Debug` → `.debug`；`std.Io` 的用法 0.17 不变），但 0.17 把 Darwin 最低版本提到 15，可能抬高 app 的最低 macOS——未核实 |
| Node（`.nvmrc`） | 24（10-20 起 Maintenance LTS，2028-04 EOL） | **26**（10-28 起 Active LTS） | 可以换 26。SDK 要求 `>=24`，两者都满足 |
| Playwright（CI 不锁） | 装的是最新 | 1.65.0（11-05） | **锁版本**：1.65 改了无障碍名的计算，不锁的话基线会无声地变 |
| actions/checkout · setup-node · upload-artifact · setup-zig | v7 · v7 · v7 · v2 | v7.0.1 · v7.1.0 · v7.0.2 · v2.2.1 | 都已是最新大版本，不用动 |
| macOS runner | `macos-15` | `macos-26`（2-26 起 GA，`macos-latest` 已指向它） | 15 仍受支持；换 26 能拿到新的 Xcode SDK。要不要换取决于最低支持的 macOS |
| Windows runner | `windows-latest` | 已是 Server 2025 + VS 2026 | 不用动。另：`windows-11-arm` 现在可用，Windows arm64 包可以原生构建 |
| WKWebView / WebView2 | 跟系统 | Safari 27.2 / Edge 157 | 见第五节 |

### SDK 0.11.0 → 0.11.1 对我们的影响

几乎全是 TypeScript core 与画布标记那条线的改动，我们用的桥、更新器、窗口状态、Windows 宿主、`package` / `automate` / `update` 都没变；`appkit_host.m` 的 `#import` 集合不变，`check-frameworks.mjs` 照样通过。

**唯一要跟的：Web Inspector。** 0.11.1 新增 `AppInfo.webview_inspection`（默认 `false`），macOS 宿主据此决定 `developerExtrasEnabled` / `inspectable` 和「Toggle Web Inspector」菜单项。SDK 自带的 runner 在 Debug 下打开它，但我们用自己的 `src/runner.zig`，没设这个字段——**升级后 Debug 构建也没有 Inspector 了**。补法（照 SDK 模板）：

```zig
if (comptime @hasField(native_sdk.AppInfo, "webview_inspection"))
    info.webview_inspection = build_options.webview_inspection orelse (builtin.mode == .Debug);
```

并在 `build.zig` 加 `-Dwebview-inspect` 选项。发布包随之关掉 Inspector，算是顺带的加固。

另一处有用的修复：automation 的快照文件改为原子写入，`smoke-*.yml` 里 `native automate` 读到半截快照的可能没有了。

---

## 五、新版本里值得用上的能力

按「对玩家或对稳妥有多大用」排序。

### 现在就能用（SDK 已有，我们没用）

1. **`webview_inspection`**（0.11.1）：上节。
2. **按窗口设置配色**（0.11.1，`PlatformServices.setWindowColorScheme`）：夜盘主题时让标题栏 / 红绿灯区域跟着变暗。需要新加一个桥处理器（JS 窗口 API 里没有暴露）。
3. **`os.addRecentDocument`**：导出的 SGF 进系统「最近使用」。
4. **`os.revealPath`**：已有封装（`host.js:49`），导出后可以给一个「在访达中显示」。

### 网页平台（两边都有，按最低系统）

| 能力 | Safari / Chromium | 用在哪 |
|---|---|---|
| `light-dark()`、`@starting-style` | 17.5 / 117–123 | 主题 token 写一遍；坞、卡片的进场动画不用 JS |
| popover | 17 / 116 | 「⋯」菜单、新局卡片：焦点陷阱与 Esc 关闭交给浏览器，能删一部分 `app.js` 里手写的焦点管理 |
| 同文档 View Transitions | 18 / 111 | 终局 ↔ 复盘、时间线 ↔ 评分曲线的切换 |
| OffscreenCanvas（worker 内） | 16.4 / 69 | 复盘评分曲线可以在 worker 里画 |
| Wasm SIMD128 / tail call | 16.4–18.2 / 91–112 | 引擎热点（棋型增量、评估）用 Zig 编成 wasm——工具链本来就有。v3.2 的结论是「极限的搜索已经到顶，再多时间换不来棋力」，所以这是**给普通 / 困难同样时间里算得更深**，以及留出余量做「棋型之外的评估」，不是直接让极限变强 |

**不要依赖**：Wasm relaxed SIMD / memory64、Temporal、`scheduler.yield`（Safari 没有）；Wasm 多线程需要 `crossOriginIsolated`，嵌入式 WebView 的自定义协议能否满足未核实。

### 构建与测试

- **Playwright 锁版本**，并考虑用 aria 快照（`toMatchAriaSnapshot`）代替一部分手写的 DOM 断言；Clock API 可以把「电脑最短 0.6 秒」这类计时闸门跑快。
- **Node 26**：`.ts` 直接运行早已稳定（24.12 起），测试脚本可以逐步加类型，不用构建步骤。
- **Windows arm64 包**：`windows-11-arm` 原生构建，或 Zig 交叉编译。

---

## 六、要你决定的

1. **下一版先修什么？** 建议 v3.2.1 只修正确性：B1–B2（禁手，附 RIF 典型局面的闸门）、B10（读写缓冲加到 1 MB 且超长报错而非截断）、B3–B9。
2. **SDK 要不要锁版本？** 现在「CI 永远用最新」：好处是自动拿到修复；代价是 0.11.1 这种静默变化不经评审就进了发布包。建议锁到 0.11.1、升级走一个小 PR（同时补 `webview_inspection`）。
3. **安全三项**（路径白名单 / 去掉开发源 / CSP）要不要一起做？
4. **Zig 0.17**：等 SDK 声明支持再升，还是现在先把 `build.zig` 的两处写法改成两边都能编？
5. **Node 26、`macos-26` runner、Windows arm64**：要不要做？

---

## 附：测试

- `node scripts/test-game.mjs`：all passed（本地，Node 22）。
- 浏览器回归（本地 Chromium）：见 PR 说明。
- main 上 v3.2.0 的 CI、build-macos、build-windows、release 全部成功（2026-10-18）。
- 实测脚本没有进仓库；可以在修复 PR 里把 B1、B2、B6、B7、B8 的局面变成闸门。
