/**
 * 生成 README 用的截图 —— 从 `src/web` 真实渲染，不是手工拼图。
 *
 *   node scripts/gen-screenshots.mjs
 *
 * 产出 docs/screenshots/：board.png（人机对局全景）、review.png（复盘评分曲线
 * 与失着列表）、theme-{wood,night,day,notebook}.png（四套棋盘的盘面）。
 *
 * 三件刻意的安排：
 *
 * 1. **全景里黑方也由引擎选点。** 人手随便下，十几手就被普通档打穿，截出来是
 *    「白棋胜」的终局——那不是一张能放在 README 顶上的图。两边同强度才会走出
 *    一盘还没分胜负的中局。
 * 2. **复盘那局故意下得散。** 引擎判不出失着时，弹层显示的是「没有检出明显失着
 *    👍」——功能没错，但那张图什么也证明不了。要让失着列表真有东西。
 * 3. **主题图用 `scale: "css"`。** 全景值得 1.5× 的清晰度，四张盘面只在表格里
 *    占半格，1× 就够；不这么做这四张会占掉整个目录四分之三的体积。
 *
 * 注意渲染引擎的差异：应用跑的是 WKWebView / WebView2，这里是 Chromium，
 * 且容器里没有 PingFang SC，中文回落到文泉驿。**版式、配色、棋盘（Canvas 画的）
 * 都一致，只有中文字形不同** —— 真机上比这里更好看，不会更差。
 */
import fs from "fs";
import os from "os";
import path from "path";
import http from "http";
import { fileURLToPath } from "url";
import { execFileSync } from "child_process";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const webRoot = path.join(root, "src/web");
const OUT = path.join(root, "docs/screenshots");
fs.mkdirSync(OUT, { recursive: true });

const { chromium } = await import(
  process.env.PLAYWRIGHT_MODULE || "playwright"
).catch(() => {
  console.error("需要 playwright：npm i -D playwright");
  process.exit(1);
});

// worker 源码是拼出来的，和浏览器回归用同一个生成器
const wdir = fs.mkdtempSync(path.join(os.tmpdir(), "goban-shots-"));
execFileSync(process.execPath, [path.join(root, "scripts/gen-worker-src.mjs"), wdir]);

const MIME = { ".html": "text/html", ".css": "text/css", ".js": "text/javascript" };
const server = http.createServer((req, res) => {
  const u = decodeURIComponent((req.url || "/").split("?")[0]);
  const rel = u === "/" ? "index.html" : u.replace(/^\/+/, "");
  if (rel === "js/worker-src.js") {
    res.writeHead(200, { "content-type": "text/javascript" });
    res.end(fs.readFileSync(path.join(wdir, "worker-src.js")));
    return;
  }
  const f = path.join(webRoot, rel);
  if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { "content-type": MIME[path.extname(f)] || "text/plain" });
  res.end(fs.readFileSync(f));
});
await new Promise((r) => server.listen(0, r));
const ORIGIN = "http://127.0.0.1:" + server.address().port;

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || undefined,
});
const ctx = await browser.newContext({
  viewport: { width: 960, height: 900 },
  deviceScaleFactor: 1.5,
});

async function fresh() {
  const page = await ctx.newPage();
  await page.goto(ORIGIN + "/index.html", { waitUntil: "networkidle" });
  // 不写盘：截图不该在开发机上留下存档
  await page.evaluate(() => {
    if (window.GobanHost) window.GobanHost.storageSet = function () {};
    localStorage.clear();
  });
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForTimeout(400);
  await page.keyboard.press("]");
  await page.waitForTimeout(200);
  return page;
}

const state = (p) =>
  p.evaluate(() => ({
    status: document.getElementById("status").textContent.trim(),
    moves: document.getElementById("replay-pos").textContent.trim(),
    thinking: !document.getElementById("think-dot").hidden,
  }));

/** 人手落一子，然后等电脑应手（手数 +2）或终局。 */
async function play(page, r, c) {
  const before = await state(page);
  await page.evaluate(([r, c]) => {
    const cv = document.getElementById("board");
    const g = window.GobanDraw.pitchFor(cv.width);
    const rect = cv.getBoundingClientRect();
    const s = rect.width / cv.width;
    cv.dispatchEvent(new MouseEvent("click", {
      clientX: rect.left + (g.pad + c * g.step) * s,
      clientY: rect.top + (g.pad + r * g.step) * s,
      bubbles: true,
    }));
  }, [r, c]);
  for (let i = 0; i < 120; i++) {
    await page.waitForTimeout(100);
    const s = await state(page);
    if (/胜|Win|平局|Draw/.test(s.status)) return "over";
    if (!s.thinking && s.moves !== before.moves &&
        Number(s.moves.split("/")[1]) >= Number(before.moves.split("/")[1]) + 2) return "ok";
  }
  return "slow";
}

// ── 全景 + 四套主题：人机 · 普通 · 执黑（全是默认档，不用改设置）
{
  const page = await fresh();
  const engineMove = () =>
    page.evaluate(() => {
      const sgf = window.GobanSgfIo.buildSgf();
      const b = Array.from({ length: 15 }, () => Array(15).fill(""));
      for (const m of sgf.matchAll(/;([BW])\[([a-o])([a-o])\]/g))
        b[m[3].charCodeAt(0) - 97][m[2].charCodeAt(0) - 97] = m[1].toLowerCase();
      const mv = window.GobanAi.aiMove({ board: b, side: "b", difficulty: "normal", timeMs: 500 });
      return mv ? [mv.r, mv.c] : null;
    });
  for (let k = 0; k < 11; k++) {
    const mv = await engineMove();
    if (!mv) break;
    if ((await play(page, mv[0], mv[1])) === "over") break;
  }
  console.log("全景:", JSON.stringify(await state(page)));
  await page.mouse.move(5, 5);            // 移开指针，否则会画出悬停预览
  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(OUT, "board.png") });
  console.log("✓ board.png");

  for (const th of ["wood", "night", "day", "notebook"]) {
    await page.click("#settings-btn"); await page.waitForTimeout(350);
    await page.click(`#theme-seg button[data-theme="${th}"]`); await page.waitForTimeout(300);
    await page.keyboard.press("Escape"); await page.waitForTimeout(500);
    await page.mouse.move(5, 5); await page.waitForTimeout(300);
    await page.locator("#board").screenshot({
      path: path.join(OUT, `theme-${th}.png`), scale: "css",
    });
    console.log("✓ theme-" + th + ".png");
  }
  await page.close();
}

// ── 复盘：故意下得散，让引擎判得出失着
{
  const page = await fresh();
  const sloppy = [[7, 7], [2, 2], [12, 12], [2, 12], [12, 2], [0, 7], [14, 7], [7, 0], [7, 14], [0, 0]];
  for (const [r, c] of sloppy) if ((await play(page, r, c)) === "over") break;
  await page.evaluate(() => document.getElementById("sgf-review").click());
  let txt = "";
  for (let i = 0; i < 100; i++) {
    await page.waitForTimeout(250);
    const o = await page.evaluate(() => {
      const m = document.getElementById("review-modal");
      return m && m.classList.contains("show") ? m.textContent : "";
    });
    if (o && !/分析中|Analyzing/.test(o)) { txt = o; break; }
  }
  await page.waitForTimeout(1200);
  const blunders = /失着 · 黑 (\d+)/.exec(txt.replace(/\s+/g, " "));
  if (!blunders || blunders[1] === "0")
    console.warn("⚠ 这一局没判出失着，复盘图证明不了什么 —— 换个更散的走法重跑");
  await page.locator("#review-modal .modal").screenshot({ path: path.join(OUT, "review.png") });
  console.log("✓ review.png（黑失着 " + (blunders ? blunders[1] : "?") + "）");
  await page.close();
}

await browser.close();
server.close();
fs.rmSync(wdir, { recursive: true, force: true });
