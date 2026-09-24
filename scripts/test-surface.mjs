/**
 * v1.64 收口 browser regression:偏好与这一局分开(S1/S2)、复盘只有侧栏一个面(S3)、
 * 学习入口的层级(S4)、初见一句话(S5)。
 *
 * Run: node scripts/test-surface.mjs
 * Needs Playwright + Chromium (same discovery/skip contract as test-loop.mjs).
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

const settings = (page) => page.evaluate(() => JSON.parse(localStorage.getItem("goban.v11.settings") || "{}"));
const active = (page, seg, attr) => page.evaluate(({ seg, attr }) => {
  const b = document.querySelector("#" + seg + " button.active");
  return b ? b.dataset[attr] : null;
}, { seg, attr });
async function finish(page) {
  const click = clicker(page);
  for (const [r, c] of GAME) { await click(r, c); await page.waitForTimeout(100); }
  await page.waitForTimeout(600);
}
async function newGame(page) {
  await page.evaluate(() => document.getElementById("btn-new").click());
  await page.waitForTimeout(150);
  await dismissConfirm(page);
  await page.waitForTimeout(200);
}

// ---- S1. 偏好与这一局分开(A):库里的双人旧局、重下,都不改侧栏偏好 ----
{
  const page = await newPage();
  // 下一局双人,留进对局库;再把偏好切回人机
  await toPvp(page);
  await finish(page);
  await newGame(page);
  await page.evaluate(() => document.querySelector('#mode-seg button[data-mode="ai"]').click());
  await page.waitForTimeout(200);
  await dismissConfirm(page);
  const prefBefore = (await settings(page)).mode;
  // 打开那局双人旧局 —— 这一局是双人
  await page.evaluate(() => document.getElementById("sgf-slots").click());
  await page.waitForTimeout(200);
  await page.evaluate(() => document.querySelector("#games-list .game-open").click());
  await page.waitForTimeout(500);
  await dismissConfirm(page);
  const gameMode = (await save(page)).mode;
  // 任何一次存设置(切音效)都不该把这一局的「双人」写成偏好
  await page.evaluate(() => document.getElementById("settings-btn").click());
  await page.waitForTimeout(150);
  await page.evaluate(() => document.getElementById("opt-sound").click());
  await page.evaluate(() => document.getElementById("settings-close").click());
  await page.waitForTimeout(150);
  const prefAfter = (await settings(page)).mode;
  await newGame(page);
  const newMode = await active(page, "mode-seg", "mode");
  report("S1 库里打开双人旧局再改设置:偏好仍是人机,新局仍是人机",
    prefBefore === "ai" && gameMode === "pvp" && prefAfter === "ai" && newMode === "ai",
    JSON.stringify({ prefBefore, gameMode, prefAfter, newMode, errs: page.__errors }));
  await page.close();
}

// ---- S2. 重下改的执子只属于这一局 ----
{
  const page = await newPage();
  await toPvp(page);
  await finish(page);
  await page.click("#end-card-retry");   // 第 8 手是白:重下时人执白、强制人机
  await page.waitForTimeout(400);
  const during = await save(page);
  await page.evaluate(() => document.getElementById("settings-btn").click());
  await page.waitForTimeout(150);
  await page.evaluate(() => document.getElementById("opt-coords").click());
  await page.evaluate(() => document.getElementById("settings-close").click());
  await page.waitForTimeout(150);
  const pref = await settings(page);
  report("S2 重下时(强制人机、人执白)改设置:偏好里仍是双人、执黑",
    during.mode === "ai" && during.humanColor === "w" && pref.mode === "pvp" && pref.humanColor === "b",
    JSON.stringify({ during: { mode: during.mode, human: during.humanColor }, pref: { mode: pref.mode, human: pref.humanColor }, errs: page.__errors }));
  await page.close();
}

// ---- S3. 复盘只有侧栏一个面(B):局势波动默认折叠、头上的数只数站得住的 ----
{
  const page = await newPage();
  const P = (r, c) => String.fromCharCode(97 + c) + String.fromCharCode(97 + r);
  // 第 9 手黑放着 (7,7) 的五不下:可证明;前面还有几手只有静态分差
  const moves = [[7, 3], [7, 2], [7, 4], [0, 0], [7, 5], [0, 2], [7, 6], [0, 4], [14, 14]];
  const sgf = "(;GM[4]FF[4]SZ[15]" + moves.map(([r, c], i) => ";" + (i % 2 ? "W" : "B") + "[" + P(r, c) + "]").join("") + ")";
  await page.evaluate(async (x) => { await navigator.clipboard.writeText(x); }, sgf);
  await page.evaluate(() => document.getElementById("sgf-paste").click());
  await page.waitForTimeout(500);
  await dismissConfirm(page);
  await page.waitForTimeout(300);
  // 同一个 evaluate 里点开并读:第二遍引擎比较要 50ms 后才开始,此刻软失着都还在
  const st = await page.evaluate(() => {
    document.getElementById("sgf-review").click();
    const d = window.GobanReview.getData();
    const chips = [...document.querySelectorAll("#review-side-chips .review-chip[data-i]")].map((c) => Number(c.dataset.i));
    const soft = d.blunders.filter((b) => b.tier === "soft").map((b) => b.i);
    const firm = d.blunders.filter((b) => b.tier !== "soft").map((b) => b.i);
    const firmB = d.blunders.filter((b) => b.tier !== "soft" && b.color === "b").length;
    const firmW = d.blunders.filter((b) => b.tier !== "soft" && b.color === "w").length;
    const more = document.querySelector("#review-side-chips [data-more]");
    return { chips, soft, firm, firmB, firmW, more: more ? more.textContent : null, stat: document.getElementById("review-stat").textContent,
             modals: document.querySelectorAll("#review-modal").length };
  });
  await page.evaluate(() => { const m = document.querySelector("#review-side-chips [data-more]"); if (m) m.click(); });
  await page.waitForTimeout(100);
  const expanded = await page.evaluate(() => [...document.querySelectorAll("#review-side-chips .review-chip[data-i]")].map((c) => Number(c.dataset.i)));
  report("S3 复盘面板:局势波动默认折叠成一枚「+N」、展开才列;头上只数可证明 / 引擎比较",
    st.modals === 0 && st.soft.length >= 1 && st.soft.every((i) => !st.chips.includes(i)) && st.firm.every((i) => st.chips.includes(i))
      && !!st.more && st.more.includes(String(st.soft.length)) && st.soft.every((i) => expanded.includes(i))
      && st.stat.replace(/\D+/g, " ").trim() === st.firmB + " " + st.firmW,
    JSON.stringify({ st, expanded, errs: page.__errors }));
  await page.close();
}

// ---- S4. 学习入口(C):三个按钮与「新局」同一套控件;到期数是徽标 ----
{
  const page = await newPage();
  const look = () => page.evaluate(() => {
    const h = (id) => Math.round(document.getElementById(id).getBoundingClientRect().height);
    const b = document.getElementById("daily-badge");
    return {
      tool: ["sgf-review", "open-practice", "open-daily"].every((id) => document.getElementById(id).classList.contains("tool-btn")),
      h: [h("sgf-review"), h("open-practice"), h("open-daily"), h("btn-new")],
      quiet: ["sgf-slots", "open-stats"].every((id) => document.getElementById(id).classList.contains("text-link")),
      badge: b && !b.hidden ? b.textContent : null,
    };
  });
  const zero = await look();
  // 种一道今天到期的题
  await page.evaluate(() => {
    const P = window.GobanPractice;
    const key = P.progress.puzzleKey(P.puzzles.buildCandidates()[0]);
    localStorage.setItem("goban.v12.practice", JSON.stringify({ v: 2, items: { [key]: { n: 1, wrong: 0, ok: true, streak: 1, due: "2000-01-01", last: "1999-12-31" } } }));
  });
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForTimeout(300);
  const one = await look();
  report("S4 复盘 / 练习 / 每日是按钮(与新局等高),存档 / 统计是文字;到期数是徽标,0 时不出现",
    zero.tool && zero.quiet && zero.h.every((x) => x === zero.h[3]) && zero.badge === null && one.badge === "1",
    JSON.stringify({ zero, one, errs: page.__errors }));
  await page.close();
}

// ---- S5. 初见一句话(D):只在第一次启动出现;落子、做题、× 都会让它走 ----
{
  const page = await newPage();         // localStorage 已清空 = 第一次启动
  const first = !(await hidden(page, "welcome-bar"));
  await clicker(page)(7, 7);
  await page.waitForTimeout(200);
  const afterMove = await hidden(page, "welcome-bar");
  await page.reload({ waitUntil: "networkidle" });   // 第二次启动:设置已存过
  await page.waitForTimeout(300);
  const second = await hidden(page, "welcome-bar");
  // 做题那条路:清空再来,点「先做今天的 5 道题」
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForTimeout(300);
  await page.evaluate(() => document.getElementById("welcome-daily").click());
  await page.waitForTimeout(300);
  const dailyOpen = await page.evaluate(() => window.GobanPractice.isOpen() && /每日|Daily/.test(document.getElementById("practice-title").textContent));
  const goneAfterDaily = await hidden(page, "welcome-bar");
  report("S5 初见一句话:第一次启动在、落子即走、第二次启动不再出现;「先做题」直接打开每日",
    first && afterMove && second && dailyOpen && goneAfterDaily,
    JSON.stringify({ first, afterMove, second, dailyOpen, goneAfterDaily, errs: page.__errors }));
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
console.log("\nSURFACE_ALL_OK");
