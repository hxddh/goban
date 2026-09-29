/**
 * 打开内置自动更新(Native SDK 0.10+,仅 macOS 系统宿主):往 app.zon 里写 `.updates`。
 *
 *   node scripts/enable-updates.mjs <base64 Ed25519 公钥> [app.zon]
 *
 * 只由发布流程调用(build-macos.yml),而且只在仓库配好了公钥变量
 * NATIVE_UPDATE_PUBLIC_KEY 时才调用 —— 仓库里的 app.zon 不带 `.updates`,开发构建与
 * 没配密钥的发布都照旧,不会出现一个查不到更新源的「检查更新」。
 *
 * 不在启动时检查(check_on_start = false):README 承诺「离线、不联网」,只有玩家自己点
 * 「Check for Updates…」时才联网。
 *
 * 更新源放在「最新一版」的发布附件里:releases/latest/download/update-macos.json,
 * 由同一个工作流用私钥签出来。公钥进应用,私钥只在 GitHub Secret 里。
 */
import fs from "fs";

const [key, file = "app.zon"] = process.argv.slice(2);
const FEED = "https://github.com/hxddh/goban/releases/latest/download/update-macos.json";

const raw = Buffer.from(key || "", "base64");
if (!key || raw.length !== 32 || raw.toString("base64") !== key.trim()) {
  console.error("enable-updates: 公钥必须是 32 字节 Ed25519 公钥的 base64(`native update keygen` 打印的那一行)");
  process.exit(1);
}
let zon = fs.readFileSync(file, "utf8");
if (/^\s*\.updates\s*=/m.test(zon)) {
  console.log("enable-updates: app.zon 已有 .updates,不重复写");
  process.exit(0);
}
const anchor = /^(\s*)\.web_engine\s*=/m;
if (!anchor.test(zon)) {
  console.error("enable-updates: app.zon 里找不到 .web_engine,不知道往哪里插");
  process.exit(1);
}
zon = zon.replace(anchor, (m, indent) =>
  `${indent}.updates = .{ .feed_url = "${FEED}", .public_key = "${key.trim()}", .check_on_start = false },\n${m}`);
fs.writeFileSync(file, zon);
console.log("enable-updates: 已写入 .updates(" + FEED + ")");
