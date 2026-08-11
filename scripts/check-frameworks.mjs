/**
 * macOS 框架清单守卫:比对 SDK 的 appkit_host.m 里 `#import <X/…>` 与
 * build.zig 里的 `linkFramework("X", …)`,少了就报。
 *
 *   node scripts/check-frameworks.mjs [--sdk <path>]
 *   （或用环境变量 SDK_PATH，构建工作流里已经有这个变量）
 *
 * ## 为什么需要它
 *
 * 那份 `.m` 由 SDK 提供、由**我们**编译，而链接需求（`linkFramework` 清单）
 * 在我们这边维护 —— SDK 只交源码，不交它自己的链接需求。于是每次 SDK 动
 * `appkit_host.m`，都可能悄悄多要一个框架，而我们要手动跟上。
 *
 * 实际发生过：SDK **0.8.4** 给 `appkit_host.m` 加了 `NativeSdkScreenAudioCapture`
 * （屏幕/系统音频采集），`#import <ScreenCaptureKit/…>`。我们没跟上，macOS
 * 构建当场 10 个未定义符号。而 `release.yml` 是**先建 tag、先建 release，再串
 * 平台构建**，所以不修就发版的结果不是「发布失败」，是「发布成功但 macOS 安装
 * 包缺席」—— v1.45.0 正是这么来的。
 *
 * ## 这条闸门守得住什么、守不住什么（重要，别高估它）
 *
 * **守得住**：`.m` 里新出现一个 `#import <NewFramework/…>` 而 build.zig 没跟上。
 * 这正是 ScreenCaptureKit 那次的形状，也是最常见的形状。
 *
 * **守不住**：**传递性的符号依赖**。同一次事故里的 `CoreMedia` 就没有被 `#import`
 * 过 —— `CMSampleBuffer*` / `CMTimeMake` 是通过 AVFoundation / ScreenCaptureKit 的
 * 头文件带进来的，只有链接器找得出来。那一半只能靠真构建。
 *
 * 所以它的作用是**把一类失败提前到构建前、并且说人话**，不是替代构建。
 */
import fs from "fs";
import path from "path";

/**
 * `#import <X/…>` 里出现、但**不需要**显式 linkFramework 的那些。
 * 每一条都要有理由 —— 否则这个名单会变成「报错就往里加」的垃圾桶。
 */
export const NO_LINK_NEEDED = {
  CoreFoundation: "随 Foundation 一并满足",
  dispatch: "libSystem 的一部分，不是框架",
  ImageIO: "由 AppKit 传递满足（实测不显式 link 也能过）",
};

/** 从 Objective-C 源码里取出所有 `#import <Framework/…>` 的框架名。 */
export function frameworksImported(hostSrc) {
  const out = new Set();
  for (const m of hostSrc.matchAll(/^\s*#import\s+<([A-Za-z0-9_]+)\//gm)) out.add(m[1]);
  return out;
}

/** 从 build.zig 里取出所有 linkFramework("X", …) 的框架名（先剥注释）。 */
export function frameworksLinked(buildZigSrc) {
  const noComments = buildZigSrc.replace(/(^|[^:])\/\/.*$/gm, "$1");
  const out = new Set();
  for (const m of noComments.matchAll(/linkFramework\(\s*"([^"]+)"/g)) out.add(m[1]);
  return out;
}

/**
 * @returns {{missing: string[], imported: number, linked: number, skipped: string[]}}
 */
export function checkFrameworks(hostSrc, buildZigSrc) {
  const imported = frameworksImported(hostSrc);
  const linked = frameworksLinked(buildZigSrc);
  const missing = [];
  const skipped = [];
  for (const fw of imported) {
    if (linked.has(fw)) continue;
    if (Object.prototype.hasOwnProperty.call(NO_LINK_NEEDED, fw)) { skipped.push(fw); continue; }
    missing.push(fw);
  }
  missing.sort();
  skipped.sort();
  return { missing, imported: imported.size, linked: linked.size, skipped };
}

// ── CLI ──────────────────────────────────────────────────────────────────────
const isMain = process.argv[1] && import.meta.url === "file://" + path.resolve(process.argv[1]);
if (isMain) {
  const argIdx = process.argv.indexOf("--sdk");
  const sdk = argIdx > -1 ? process.argv[argIdx + 1] : process.env.SDK_PATH;
  if (!sdk) {
    console.error("需要 SDK 路径:--sdk <path> 或环境变量 SDK_PATH");
    process.exit(2);
  }
  const hostPath = path.join(sdk, "src/platform/macos/appkit_host.m");
  const buildPath = path.join(path.dirname(new URL(import.meta.url).pathname), "..", "build.zig");
  if (!fs.existsSync(hostPath)) {
    console.error("找不到 " + hostPath + " —— SDK 路径不对?");
    process.exit(2);
  }
  const r = checkFrameworks(fs.readFileSync(hostPath, "utf8"), fs.readFileSync(buildPath, "utf8"));
  // 覆盖数要报出来:扫不到东西的闸门永远是绿的
  console.log(
    "框架比对:.m 里 import " + r.imported + " 个 · build.zig 链接 " + r.linked +
    " 个 · 免链接名单命中 " + r.skipped.length + " 个 (" + r.skipped.join(", ") + ")"
  );
  if (r.imported < 8) {
    console.error("只扫到 " + r.imported + " 个 import —— 覆盖不足,大概率是路径或正则坏了");
    process.exit(2);
  }
  if (r.missing.length) {
    console.error(
      "\n❌ appkit_host.m 需要这些框架,而 build.zig 没有链接:\n" +
      r.missing.map((f) => '    app_mod.linkFramework("' + f + '", .{});').join("\n") +
      "\n\n(注意:本检查只看 #import,抓不到传递性的符号依赖 —— 比如 0.8.4 那次的" +
      " CoreMedia。加完再跑一次真构建。)"
    );
    process.exit(1);
  }
  console.log("✓ 没有缺失的框架");
}
