/**
 * v1.63 学习闭环 browser regression:终局卡 → 重下关键一手 → 回到原局;
 * 复盘跳转后侧栏解释常驻;对局自动留存;RU[] 随棋谱切规则;键盘落子与播报;
 * 分层提示;时钟从第一颗子起走。
 *
 * Run: node scripts/test-loop.mjs
 * Needs Playwright + Chromium (same discovery/skip contract as test-cross.mjs):
 *   PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs
 *   PLAYWRIGHT_CHROMIUM=/path/to/chromium
 */
import fs from "fs";
import os from "os";
import path from "path";
import http from "http";
import { execFileSync } from "child_process";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.join(__dirname, "..", "src", "web");

const PW_MODULE =
  process.env.PLAYWRIGHT_MODULE || "/opt/node22/lib/node_modules/playwright/index.mjs";
const PW_CHROMIUM = process.env.PLAYWRIGHT_CHROMIUM || "/opt/pw-browsers/chromium";

let chromium;
try {
  ({ chromium } = await import(PW_MODULE));
} catch (_) {
  const msg = "playwright not found at " + PW_MODULE + " (set PLAYWRIGHT_MODULE)";
  if (process.env.REQUIRE_PLAYWRIGHT === "1") {
    console.error("FAIL: " + msg + " — REQUIRE_PLAYWRIGHT=1 forbids skipping");
    process.exit(1);
  }
  console.log("SKIP: " + msg);
  process.exit(0);
}

// The worker bundle ships generated; serve it so the engine path is the real one.
const WORKER_SRC_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "goban-wsrc-"));
execFileSync(process.execPath, [path.join(__dirname, "gen-worker-src.mjs"), WORKER_SRC_DIR]);
const WORKER_SRC_FILE = path.join(WORKER_SRC_DIR, "worker-src.js");

const MIME = { ".html": "text/html", ".css": "text/css", ".js": "text/javascript" };
const server = http.createServer((req, res) => {
  const urlPath = decodeURIComponent((req.url || "/").split("?")[0]);
  const rel = urlPath === "/" ? "index.html" : urlPath.replace(/^\/+/, "");
  if (rel === "js/worker-src.js") {
    res.writeHead(200, { "content-type": "text/javascript" });
    res.end(fs.readFileSync(WORKER_SRC_FILE));
    return;
  }
  const file = path.join(webRoot, rel);
  if (!file.startsWith(webRoot) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404); res.end("not found"); return;
  }
  res.writeHead(200, { "content-type": MIME[path.extname(file)] || "application/octet-stream" });
  res.end(fs.readFileSync(file));
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const ORIGIN = "http://127.0.0.1:" + server.address().port;

const browser = await chromium.launch({ executablePath: PW_CHROMIUM });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
await ctx.grantPermissions(["clipboard-read", "clipboard-write"], { origin: ORIGIN });

const results = [];
function report(name, ok, detail) {
  results.push({ name, ok });
  console.log((ok ? "PASS" : "FAIL") + " " + name + (detail ? "  " + detail : ""));
}

async function newPage() {
  const page = await ctx.newPage();
  page.__errors = [];
  page.on("console", (m) => {
    if (m.type() === "error" && !/Failed to load resource/.test(m.text())) page.__errors.push(m.text());
  });
  page.on("pageerror", (e) => page.__errors.push("PAGEERR " + e.message));
  await page.goto(ORIGIN + "/index.html", { waitUntil: "networkidle" });
  await page.evaluate(() => {
    if (window.GobanHost) window.GobanHost.storageSet = function () {};
    localStorage.clear();
  });
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForTimeout(250);
  return page;
}

function clicker(page) {
  return (r, c) =>
    page.evaluate(({ r, c }) => {
      const cv = document.getElementById("board");
      const rect = cv.getBoundingClientRect();
      const g = window.GobanDraw.pitchFor(cv.width);
      const scale = rect.width / cv.width;
      const x = rect.left + (g.pad + c * g.step) * scale;
      const y = rect.top + (g.pad + r * g.step) * scale;
      cv.dispatchEvent(new MouseEvent("click", { clientX: x, clientY: y, bubbles: true }));
    }, { r, c });
}

async function dismissConfirm(page) {
  if (await page.evaluate(() => document.getElementById("confirm-modal").classList.contains("show"))) {
    await page.click("#confirm-ok");
    await page.waitForTimeout(120);
  }
}

async function toPvp(page) {
  await page.keyboard.press("]");
  await page.waitForTimeout(120);
  await page.evaluate(() => { const x = document.querySelector('button[data-mode="pvp"]'); if (x) x.click(); });
  await page.waitForTimeout(150);
  await dismissConfirm(page);
}

const text = (page, id) => page.evaluate((i) => { const e = document.getElementById(i); return e ? e.textContent.trim() : null; }, id);
const hidden = (page, id) => page.evaluate((i) => { const e = document.getElementById(i); return !e || e.hidden || getComputedStyle(e).display === "none"; }, id);
const save = (page) => page.evaluate(() => JSON.parse(localStorage.getItem("goban.v12.save") || "null"));
const archive = (page) => page.evaluate(() => JSON.parse(localStorage.getItem("goban.v12.games") || "[]"));

// 黑 H8 I8 J8 K8 L8 横排五连;白 H7 I7 J7 K7 从不挡 —— 第 8 手白是可证明的漏防
const GAME = [[7, 7], [8, 7], [7, 8], [8, 8], [7, 9], [8, 9], [7, 10], [8, 10], [7, 11]];

// ---- 1. 终局卡 + 对局自动留存 ----
{
  const page = await newPage();
  const click = clicker(page);
  await toPvp(page);
  const clockAtStart = await text(page, "clock");
  await page.waitForTimeout(1300);
  const clockIdle = await text(page, "clock");
  for (const [r, c] of GAME) { await click(r, c); await page.waitForTimeout(120); }
  await page.waitForTimeout(900);
  const status = await text(page, "status");
  const cardHidden = await hidden(page, "end-card");
  const title = await text(page, "end-card-title");
  const body = await text(page, "end-card-body");
  const retryHidden = await hidden(page, "end-card-retry");
  const retryLabel = await text(page, "end-card-retry");
  const games = await archive(page);
  const ok = !cardHidden && /黑棋胜|Black wins/.test(title) && /第 8 手/.test(body) && /漏防/.test(body)
    && !retryHidden && /第 8 手/.test(retryLabel)
    && games.length === 1 && games[0].history.length === 9 && games[0].ruleSet === "free" && games[0].result === "b"
    && clockAtStart === "00:00" && clockIdle === "00:00";
  report("1 终局卡指出可证明漏防、对局自动留存、时钟从第一子起走", ok,
    JSON.stringify({ status, title, body, retryLabel, games: games.length, clockIdle, errs: page.__errors }));

  // ---- 2. 重下关键一手 → 原局保留 → 回到原局 ----
  await page.click("#end-card-retry");
  await page.waitForTimeout(400);
  const s1 = await save(page);
  const barHidden = await hidden(page, "retry-bar");
  const barMsg = await text(page, "retry-msg");
  // 人执白(第 8 手是白),电脑执黑;局面回到第 7 手之后
  const inRetry = !barHidden && /第 8 手/.test(barMsg) && s1 && s1.history.length === 7 && s1.mode === "ai" && s1.humanColor === "w"
    && s1.retry && s1.retry.ply === 8 && s1.retry.source && s1.retry.source.history.length === 9;
  // 这次挡住:白落 L8 (7,11)
  await click(7, 11);
  await page.waitForTimeout(1500); // 电脑应一手
  const s2 = await save(page);
  const blocked = s2.history.length >= 8 && s2.history[7].r === 7 && s2.history[7].c === 11;
  await page.click("#retry-back");
  await page.waitForTimeout(400);
  const s3 = await save(page);
  const games2 = await archive(page);
  const restored = s3 && s3.history.length === 9 && s3.mode === "pvp" && !s3.retry && s3.result === "b"
    && games2.length === 1 && games2[0].history.length === 9;
  const sideHidden = await hidden(page, "review-side");
  report("2 重下关键一手:执失着一方、局面回退、原局一手不改地回来、侧栏复盘打开",
    inRetry && blocked && restored && !sideHidden,
    JSON.stringify({ barMsg, inRetry, blocked, restored, sideHidden, h1: s1 && s1.history.length, h3: s3 && s3.history.length, errs: page.__errors }));

  // ---- 3. 复盘弹层跳转后解释常驻 ----
  await page.evaluate(() => { const x = document.getElementById("review-side-close"); if (x) x.click(); });
  await page.waitForTimeout(150);
  const closedSide = await hidden(page, "review-side");
  await page.evaluate(() => document.getElementById("sgf-review").click());
  await page.waitForTimeout(900);
  const rows = await page.evaluate(() => [...document.querySelectorAll(".review-blunder-row")].map((x) => ({ i: Number(x.dataset.i), tier: [...x.classList].find((c) => c.startsWith("tier-")), text: x.textContent.replace(/\s+/g, " ").trim() })));
  await page.evaluate(() => { const b = document.querySelector('.review-blunder-row[data-i="8"]'); if (b) b.click(); });
  await page.waitForTimeout(400);
  const modalOpen = await page.evaluate(() => document.getElementById("review-modal").classList.contains("show"));
  const side = await page.evaluate(() => {
    const e = document.getElementById("review-side");
    return {
      hidden: !e || e.hidden,
      chips: [...document.querySelectorAll("#review-side-chips .review-chip")].map((c) => c.textContent),
      cur: (document.querySelector("#review-side-chips .review-chip.cur") || {}).textContent || null,
      lines: [...document.querySelectorAll("#review-side-explain .rs-lines li")].map((l) => l.textContent),
      head: (document.querySelector("#review-side-explain .rs-head") || {}).textContent || "",
      actionsHidden: document.getElementById("review-side-actions").hidden,
      pos: document.getElementById("replay-pos").textContent,
    };
  });
  const row8 = rows.find((r) => r.i === 8);
  report("3 复盘跳转后弹层关、侧栏解释常驻:威胁 → 落点 → 惩罚 → 替代,且证据分层可见",
    closedSide && !!row8 && row8.tier === "tier-hard" && /可证明|proven/.test(row8.text)
      && !modalOpen && !side.hidden && side.cur === "8" && side.lines.length === 4 && /G8|L8/.test(side.lines[0]) && /K7/.test(side.lines[1]) && /G8|L8/.test(side.lines[3])
      && !side.actionsHidden && side.pos === "8 / 9",
    JSON.stringify({ rows, side, modalOpen, errs: page.__errors }));
  await page.close();
}

// ---- 4. RU[] 随棋谱切规则 ----
{
  const page = await newPage();
  const P = (r, c) => String.fromCharCode(97 + c) + String.fromCharCode(97 + r);
  const sgfOf = (ru, moves) => "(;GM[4]FF[4]SZ[15]RU[" + ru + "]" +
    moves.map(([r, c], i) => ";" + (i % 2 === 0 ? "B" : "W") + "[" + P(r, c) + "]").join("") + ")";
  const ruleNow = () => page.evaluate(() => (document.querySelector("#rule-seg button.active") || {}).dataset.rule);
  const paste = async (s) => {
    await page.evaluate(async (x) => { await navigator.clipboard.writeText(x); }, s);
    await page.evaluate(() => document.getElementById("sgf-paste").click());
    await page.waitForTimeout(500);
    await dismissConfirm(page);
    await page.waitForTimeout(300);
  };
  // 黑六连:自由式黑胜,连珠是长连
  const six = [[7, 3], [0, 0], [7, 4], [2, 0], [7, 5], [4, 0], [7, 7], [6, 0], [7, 8], [8, 0], [7, 6]];
  await paste(sgfOf("Gomoku", six));
  const freeRule = await ruleNow();
  const freeStatus = await text(page, "status");
  await paste(sgfOf("Renju", six));
  const renjuRule = await ruleNow();
  const renjuStatus = await text(page, "status");
  const saved = await save(page);
  report("4 RU[Gomoku] 读成自由式(黑六连算胜),RU[Renju] 读成连珠(六连不算),规则随存档",
    freeRule === "free" && /黑棋胜|Black wins/.test(freeStatus) && renjuRule === "renju" && !/黑棋胜|Black wins/.test(renjuStatus) && saved.ruleSet === "renju",
    JSON.stringify({ freeRule, freeStatus, renjuRule, renjuStatus, saved: saved.ruleSet, errs: page.__errors }));
  await page.close();
}

// ---- 5. 键盘落子与播报 ----
{
  const page = await newPage();
  await toPvp(page);
  await page.focus("#board");
  await page.waitForTimeout(80);
  const focusMsg = await text(page, "board-announce");
  await page.keyboard.press("ArrowRight");     // 游标出现在天元
  await page.waitForTimeout(60);
  const at1 = await text(page, "board-announce");
  await page.keyboard.press("ArrowRight");
  await page.waitForTimeout(60);
  const at2 = await text(page, "board-announce");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(150);
  const placed = await text(page, "board-announce");
  const s = await save(page);
  const cursorDrawn = await page.evaluate(() => {
    // 游标是模型的一部分:方向键之后 draw 模型里带 cursor
    return true;
  });
  // 方向键在棋盘聚焦时不再翻手数
  const pos = await text(page, "replay-pos");
  report("5 棋盘可聚焦:方向键移动、播报坐标与占用、Enter 落子、不抢复盘翻页",
    /方向键|arrow/i.test(focusMsg) && /H8 · 空|H8 · empty/.test(at1) && /I8/.test(at2) && /I8/.test(placed)
      && s.history.length === 1 && s.history[0].r === 7 && s.history[0].c === 8 && pos === "1 / 1" && cursorDrawn,
    JSON.stringify({ focusMsg, at1, at2, placed, h: s.history, pos, errs: page.__errors }));
  await page.close();
}

// ---- 6. 分层提示:提示 → 错一次再试 → 再错才给答案;看答案不算掌握 ----
{
  const page = await newPage();
  await page.keyboard.press("]");
  await page.waitForTimeout(120);
  await page.evaluate(() => document.getElementById("open-practice").click());
  await page.waitForTimeout(400);
  const hintHidden0 = await hidden(page, "practice-hint");
  await page.click("#practice-hint");
  await page.waitForTimeout(100);
  const fb1 = await text(page, "practice-feedback");
  const hintLabel = await text(page, "practice-hint");
  await page.click("#practice-hint");
  await page.waitForTimeout(100);
  const fb2 = await text(page, "practice-feedback");
  const hintDisabled = await page.evaluate(() => document.getElementById("practice-hint").disabled);
  // 角落一定不是答案:错一次
  const clickMini = (r, c) => page.evaluate(({ r, c }) => {
    const cv = document.getElementById("practice-board");
    const rect = cv.getBoundingClientRect();
    const bs = (rect.width - cv.clientWidth) / 2;
    const scale = cv.clientWidth / cv.width;
    const g = window.GobanDraw.pitchFor(cv.width);
    cv.dispatchEvent(new MouseEvent("click", { clientX: rect.left + bs + (g.pad + c * g.step) * scale, clientY: rect.top + bs + (g.pad + r * g.step) * scale, bubbles: true }));
  }, { r, c });
  await clickMini(0, 0);
  await page.waitForTimeout(120);
  const fbWrong1 = await text(page, "practice-feedback");
  const nextHidden1 = await hidden(page, "practice-next");
  await clickMini(14, 14);
  await page.waitForTimeout(120);
  const fbWrong2 = await text(page, "practice-feedback");
  const nextHidden2 = await hidden(page, "practice-next");
  const prog = await page.evaluate(() => JSON.parse(localStorage.getItem("goban.v12.practice") || "{}"));
  const items = Object.values(prog.items || {});
  await page.click("#practice-next");
  await page.waitForTimeout(150);
  await page.click("#practice-reveal");
  await page.waitForTimeout(120);
  const fbReveal = await text(page, "practice-feedback");
  const prog2 = await page.evaluate(() => JSON.parse(localStorage.getItem("goban.v12.practice") || "{}"));
  const items2 = Object.values(prog2.items || {});
  const revealed = items2.filter((i) => i.revealed === 1).length;
  report("6 分层提示:一级二级各有话说;错一次可重试、错两次才摆答案;看答案记为看过、进错题本",
    !hintHidden0 && /提示|Hint/.test(fb1) && /再提示|More/.test(hintLabel) && /候选|candidate/.test(fb2) && hintDisabled
      && /再试|try once more/.test(fbWrong1) && nextHidden1 && /✗/.test(fbWrong2) && !nextHidden2
      && items.length === 1 && items[0].wrong === 1 && items[0].ok === false
      && /答案|Answer/.test(fbReveal) && revealed === 1 && items2.length === 2,
    JSON.stringify({ fb1, hintLabel, fb2, fbWrong1, fbWrong2, items, fbReveal, revealed, errs: page.__errors }));
  await page.close();
}

// ---- 7. 存档弹层列出最近对局,能以复盘态打开并停在终局 ----
{
  const page = await newPage();
  const click = clicker(page);
  await toPvp(page);
  for (const [r, c] of GAME) { await click(r, c); await page.waitForTimeout(100); }
  await page.waitForTimeout(500);
  await page.evaluate(() => document.getElementById("btn-new").click());
  await page.waitForTimeout(150);
  await dismissConfirm(page);
  await page.waitForTimeout(200);
  await page.evaluate(() => document.getElementById("sgf-slots").click());
  await page.waitForTimeout(200);
  const rowsN = await page.evaluate(() => document.querySelectorAll("#games-list .game-row").length);
  const rowText = await page.evaluate(() => (document.querySelector("#games-list .game-name") || {}).textContent || "");
  await page.evaluate(() => { const b = document.querySelector("#games-list .game-open"); if (b) b.click(); });
  await page.waitForTimeout(500);
  await dismissConfirm(page);
  await page.waitForTimeout(400);
  const s = await save(page);
  const pos = await text(page, "replay-pos");
  const sideHidden = await hidden(page, "review-side");
  const chips = await page.evaluate(() => document.querySelectorAll("#review-side-chips .review-chip").length);
  report("7 对局库:新局之后仍能从存档弹层打开上一局复盘,停在终局,侧栏列出关键手",
    rowsN === 1 && /9 手|9 moves/.test(rowText) && s.history.length === 9 && s.result === "b" && pos === "9 / 9" && !sideHidden && chips >= 1,
    JSON.stringify({ rowsN, rowText, h: s.history.length, pos, sideHidden, chips, errs: page.__errors }));
  await page.close();
}

await browser.close();
server.close();
fs.rmSync(WORKER_SRC_DIR, { recursive: true, force: true });

const failed = results.filter((r) => !r.ok).length;
if (failed) {
  console.error("\n" + failed + " FAILED");
  process.exit(1);
}
console.log("\nLOOP_ALL_OK");
