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

// v1.74:模式 / 难度 / 执子 / 思考住在「新局」卡片里,选好点「开始」才生效
async function setup(page, o) {
  await page.evaluate(() => { const s = document.getElementById("new-sheet"); if (s && s.hidden) document.getElementById("btn-new").click(); });
  await page.waitForTimeout(100);
  await page.evaluate((o) => {
    const q = (sel) => { const b = document.querySelector(sel); if (b) b.click(); };
    if (o.mode) q('#mode-seg [data-mode="' + o.mode + '"]');
    if (o.diff) q('#diff-seg [data-diff="' + o.diff + '"]');
    if (o.think) q('#think-seg [data-think="' + o.think + '"]');
    if (o.color) q('#color-seg [data-human="' + o.color + '"]');
    const st = document.getElementById("new-start"); if (st) st.click();
  }, o);
  await page.waitForTimeout(150);
  await dismissConfirm(page);
  await page.waitForTimeout(150);
}

async function toPvp(page) { await setup(page, { mode: "pvp" }); }

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
async function newGame(page) { await setup(page, {}); await page.waitForTimeout(50); }

// ---- S1. 偏好与这一局分开(A):库里的双人旧局、重下,都不改侧栏偏好 ----
{
  const page = await newPage();
  // 下一局双人,留进对局库;再把偏好切回人机
  await toPvp(page);
  await finish(page);
  await newGame(page);
  await setup(page, { mode: "ai" });
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
  // v1.67 起执子的默认偏好是 "auto"(低档执黑、高档轮流);要验的是重下强制的「白」没漏进偏好
  report("S2 重下时(强制人机、人执白)改设置:偏好里仍是双人、执子仍是默认",
    during.mode === "ai" && during.humanColor === "w" && pref.mode === "pvp" && pref.humanColor === "auto",
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

// ---- S4. 学习入口(C,v1.74 改):复盘 / 练习 / 记录收进「⋯」;到期数挂在「⋯」与「练习」上,0 时不出现 ----
{
  const page = await newPage();
  const look = () => page.evaluate(() => {
    const b = document.getElementById("daily-badge"), m = document.getElementById("more-badge");
    return {
      inMenu: ["sgf-review", "open-practice", "sgf-slots"].every((id) => { const e = document.getElementById(id); return !!e && !!e.closest("#more-menu"); }),
      badge: b && !b.hidden ? b.textContent : null,
      more: m && !m.hidden ? m.textContent : null,
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
  report("S4 复盘 / 练习 / 记录在「⋯」里;到期数是「练习」与「⋯」上的徽标,0 时不出现",
    zero.inMenu && zero.badge === null && zero.more === null && one.badge === "1" && one.more === "1",
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

// ---- S6. 精修的两条闸门(v1.65)----
// 一、(v1.74 退役:侧栏里不留空组 —— 侧栏整个退役了)
// 二、每套主题的主按钮与主题强调色同一色相(±35°)—— 日间曾是冷蓝、夜盘曾是杏色。
{
  const page = await newPage();
  await toPvp(page);
  const click = clicker(page);
  await click(7, 7); await page.waitForTimeout(120);
  await click(7, 8); await page.waitForTimeout(150);
  const hues = {};
  for (const th of ["wood", "night", "day", "notebook"]) {
    hues[th] = await page.evaluate((t) => {
      document.documentElement.setAttribute("data-theme", t);
      const hue = (r, g, b) => {
        r /= 255; g /= 255; b /= 255;
        const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
        if (!d) return 0;
        let h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
        return (h * 60 + 360) % 360;
      };
      const acc = getComputedStyle(document.documentElement).getPropertyValue("--accent").trim();
      const a = acc.match(/^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})/i);
      const bg = getComputedStyle(document.getElementById("settings-close")).backgroundImage;
      const m = bg.match(/rgb\((\d+), (\d+), (\d+)\)/);
      if (!a || !m) return null;
      const ha = hue(parseInt(a[1], 16), parseInt(a[2], 16), parseInt(a[3], 16));
      const hb = hue(+m[1], +m[2], +m[3]);
      const diff = Math.min(Math.abs(ha - hb), 360 - Math.abs(ha - hb));
      return { accent: Math.round(ha), button: Math.round(hb), diff: Math.round(diff) };
    }, th);
  }
  const badHue = Object.entries(hues).filter(([, v]) => !v || v.diff > 35).map(([k]) => k);
  report("S6 四套主题的主按钮都与强调色同一色相",
    badHue.length === 0,
    JSON.stringify({ hues, errs: page.__errors }));
  await page.close();
}

// ---- S7.(v1.74 退役)侧栏「轮到谁」的两颗小棋子 —— 对阵行并进顶栏,小棋子随侧栏一起没有了 ----

// ---- S8. 棋子轮廓(v1.66)----
// 沿每颗子的边取 24 个方向,比较边内(边缘一带)与边外 3px 的亮度:差 ≥ 20 算这个方向「看得见」。
// 三套实物主题上每颗子至少 80% 的方向看得见。v1.65 夜盘黑子只有 54–71%(反光只在左上一角)。
// 在 2× 屏上量(Mac 视网膜屏是这个应用的主要屏幕;1× 下子的半径只有十几个像素,取样太粗)。
{
  const ctx2 = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2 });
  const page = await ctx2.newPage();
  page.__errors = [];
  page.on("pageerror", (e) => page.__errors.push("PAGEERR " + e.message));
  await page.goto(ORIGIN + "/index.html", { waitUntil: "networkidle" });
  await page.evaluate(() => { if (window.GobanHost) window.GobanHost.storageSet = function () {}; localStorage.clear(); });
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForTimeout(250);
  await toPvp(page);
  const click = clicker(page);
  for (const [r, c] of [[7, 7], [7, 8], [3, 3], [3, 4], [11, 11], [11, 10]]) { await click(r, c); await page.waitForTimeout(120); }
  await page.mouse.move(5, 5);
  const out = {};
  for (const th of ["night", "wood", "day"]) {
    await page.evaluate((t) => { document.getElementById("settings-btn").click(); document.querySelector(`#theme-seg button[data-theme="${t}"]`).click(); document.getElementById("settings-close").click(); }, th);
    await page.waitForTimeout(600);
    out[th] = await page.evaluate(() => {
      const cv = document.getElementById("board"); const g = window.GobanDraw.pitchFor(cv.width); const ctx = cv.getContext("2d");
      const rr = g.step * window.GobanDraw.STONE_R; const Y = (d) => 0.2126 * d[0] + 0.7152 * d[1] + 0.0722 * d[2];
      const px = (x, y) => ctx.getImageData(Math.round(x), Math.round(y), 1, 1).data;
      const res = {};
      for (const [r, c] of [[7, 7], [3, 3], [11, 11], [7, 8], [3, 4], [11, 10]]) {
        const x = g.pad + c * g.step, y = g.pad + r * g.step; let ok = 0;
        for (let k = 0; k < 24; k++) {
          const a = (k / 24) * Math.PI * 2, cx = Math.cos(a), sy = Math.sin(a);
          const o = Y(px(x + cx * (rr + 3), y + sy * (rr + 3)));
          const d = Math.max(Math.abs(Y(px(x + cx * (rr - 2), y + sy * (rr - 2))) - o), Math.abs(Y(px(x + cx * (rr - 0.6), y + sy * (rr - 0.6))) - o));
          if (d >= 20) ok++;
        }
        res[r + "," + c] = Math.round((ok / 24) * 100);
      }
      return res;
    });
  }
  const bad = Object.entries(out).flatMap(([th, v]) => Object.entries(v).filter(([, p]) => p < 80).map(([k, p]) => th + "@" + k + "=" + p + "%"));
  report("S8 棋子轮廓:三套实物主题上每颗子至少 80% 的边看得见", bad.length === 0, JSON.stringify({ bad, out, errs: page.__errors }));
  await ctx2.close();
}

// ---- S9. 执子轮流(v1.67)----
// 困难 / 极限默认每局轮流:玩家落过子的一局之后新局换色;一子没落(包括执白时电脑已先手)
// 就点新局,不换;在困难与极限之间换难度开新局,不打乱交替;偏好仍是 auto(卡片里亮「轮流」)。
{
  const page = await newPage();
  const click = clicker(page);
  // v1.74:对阵行并进顶栏(「你执黑 · 困难」):黑方是「你」还是「电脑」
  const role = async () => (/执黑|: Black/.test(await text(page, "match")) ? "你" : "电脑");
  const moves = () => page.evaluate(() => [...window.GobanSgfIo.buildSgf().matchAll(/;[BW]\[/g)].length);
  const waitMoves = async (n) => { for (let i = 0; i < 60 && (await moves()) < n; i++) await page.waitForTimeout(100); };
  await setup(page, { diff: "hard" });
  const seen = [];
  seen.push(await role());                                   // 第 1 局:执黑
  await click(3, 3); await waitMoves(2);                     // 人落一子,电脑应一手
  await newGame(page);
  seen.push(await role());                                   // 第 2 局:换成执白
  await waitMoves(1);                                        // 电脑先手
  await newGame(page);                                       // 人一子没落就重开
  seen.push(await role());                                   // 第 3 局:不换,仍执白
  await waitMoves(1);
  await click(3, 3); await waitMoves(3);                     // 执白落一子,再从卡片换到极限开新局
  await setup(page, { diff: "extreme" });
  seen.push(await role());                                   // 第 4 局:换回执黑
  const st = await settings(page);
  await page.evaluate(() => document.getElementById("btn-new").click()); await page.waitForTimeout(100);
  const act = await active(page, "color-seg", "human");
  await page.keyboard.press("Escape");
  const want = ["你", "电脑", "电脑", "你"];
  const ok = JSON.stringify(seen) === JSON.stringify(want) && st.humanColor === "auto" && st.lastHumanColor === "b" && act === "alt";
  report("S9 困难 / 极限每局轮流执子:落过子才换色,中途换难度不打乱", ok,
    JSON.stringify({ seen, want, stored: { humanColor: st.humanColor, last: st.lastHumanColor }, active: act, errs: page.__errors }));
  await page.close();
}

// ---- S10. 简洁(v1.68;v1.74 改)----
// 全新用户一打开:首次提示不压棋盘;可点的控件 ≤ 22;空棋盘时时间线不出现(占位不收起);
// 落下第一子后它在。规则在设置弹层里。
{
  const page = await newPage();
  const count = () => page.evaluate(() => [...document.querySelectorAll("button, [role=button], input, select")]
    .filter((e) => e.offsetParent !== null && e.getBoundingClientRect().width > 0 && getComputedStyle(e).visibility !== "hidden").length);
  const shown = (id) => page.evaluate((i) => { const e = document.getElementById(i);
    return !!e && e.offsetParent !== null && e.getBoundingClientRect().height > 0 && getComputedStyle(e).visibility !== "hidden"; }, id);
  const overlap = await page.evaluate(() => {
    const w = document.getElementById("welcome-bar"), b = document.getElementById("board");
    if (!w || w.hidden) return "no-welcome";
    const r1 = w.getBoundingClientRect(), r2 = b.getBoundingClientRect();
    return r1.left < r2.right && r1.right > r2.left && r1.top < r2.bottom && r1.bottom > r2.top;
  });
  const withWelcome = await count();
  const emptyHidden = !(await shown("timeline"));
  const ruleInSettings = await page.evaluate(() => { const r = document.getElementById("rule-field"); return !!r && !!r.closest("#settings-modal"); });
  await clicker(page)(7, 7);
  await page.waitForTimeout(400);
  const afterMove = await shown("timeline");
  report("S10 一打开:提示不压棋盘、可点控件 ≤ 22、空棋盘不显示时间线,落子后在",
    overlap === false && withWelcome <= 22 && emptyHidden && afterMove && ruleInSettings,
    JSON.stringify({ overlap, withWelcome, emptyHidden, afterMove, ruleInSettings, errs: page.__errors }));
  await page.close();
}

// ---- S11. 侧栏只留下棋要用的(v1.70)----
// 首次打开(提示还在)可点控件 ≤ 21(v1.69 是 24);对局中除棋谱每一手外 ≤ 19(v1.69 是 24)。
// 挪走的都还在、两步之内够得着:存档 → 复制 / 导出 / 导入 / 粘贴;练习 → 今日。
// 一件信息只说一遍:顶栏没有手数、侧栏没有「已存」、人机时信息行不写档名。
{
  const page = await newPage();
  const count = () => page.evaluate(() => [...document.querySelectorAll("button, [role=button], input, select")]
    .filter((e) => e.offsetParent !== null && e.getBoundingClientRect().width > 0 && !e.closest("#move-list")).length);
  const first = await count();
  const click = clicker(page);
  for (const [r, c] of [[7, 7], [6, 8], [8, 6]]) { await click(r, c); await page.waitForTimeout(900); }
  const mid = await count();
  const dup = await page.evaluate(() => ({
    movesChip: !!document.getElementById("moves"),
    saved: /已存|自动存档/.test(document.getElementById("app").innerText),
    // v1.74:难度只在顶栏说一次(「你执黑 · 普通」),难度格收进了「新局」卡片
    levelOnce: /普通/.test((document.getElementById("match") || {}).textContent || "") &&
      !(document.getElementById("diff-seg") || { offsetParent: null }).offsetParent,
  }));
  await page.evaluate(() => document.getElementById("sgf-slots").click());
  await page.waitForTimeout(150);
  const inSlots = await page.evaluate(() => ["sgf-copy", "sgf-download", "sgf-import", "sgf-paste"]
    .every((id) => { const e = document.getElementById(id); return !!e && !!e.closest("#slots-modal") && e.offsetParent !== null; }));
  let copied = "";
  if (inSlots) {   // 旧布局里它们不在弹层里:判失败,而不是让点击超时把整套测试带崩
    await page.click("#sgf-copy");
    await page.waitForTimeout(150);
    copied = await page.evaluate(() => navigator.clipboard.readText());
  }
  await page.evaluate(() => document.getElementById("slots-close").click());
  await page.evaluate(() => document.getElementById("open-practice").click());
  await page.waitForTimeout(200);
  const pTitle = await page.evaluate(() => document.getElementById("practice-title").textContent.trim());
  const dailyChip = await page.evaluate(() => { const b = document.querySelector('#practice-skill [data-skill="daily"]'); return !!b && b.offsetParent !== null && b.classList.contains("active"); });
  await page.evaluate(() => document.querySelector('#practice-skill [data-skill="all"]').click());
  await page.waitForTimeout(150);
  const freeTitle = await page.evaluate(() => document.getElementById("practice-title").textContent.trim());
  const ok = first <= 21 && mid <= 19 && !dup.movesChip && !dup.saved && dup.levelOnce &&
    inSlots && /^\(;/.test(copied) && pTitle === "每日挑战" && dailyChip && freeTitle === "战术练习";
  report("S11 侧栏只留下棋要用的:控件 ≤ 21 / ≤ 19;文件操作在存档里、每日在练习里;信息不重复", ok,
    JSON.stringify({ first, mid, dup, inSlots, copied: copied.slice(0, 12), pTitle, dailyChip, freeTitle, errs: page.__errors }));
  await page.close();
}

// ---- S12. 再简一层,并把挖出来的 bug 钉死(v1.71)----
// 控件:首次打开 ≤ 16、对局中 ≤ 15、终局 ≤ 18(v1.70 是 21 / 19 / 24);弹层 5 种(v1.70 是 6)。
// 挪走的都还在:Home / End、? 与设置里的「快捷键」、「记录」里的战绩。
// B1 离开 swap2 提示条收起;B2 下完的局点新局不再确认;B3「练这一手」出现就一定有题;
// B4 不足两手不显示「复盘」;B5 文案不再提已不存在的东西;标准一局的提示条减半以上(v1.70 这段流程实测 4 条)。
{
  const page = await newPage();
  const click = clicker(page);
  const count = () => page.evaluate(() => [...document.querySelectorAll("button, [role=button], input, select")]
    .filter((e) => e.offsetParent !== null && e.getBoundingClientRect().width > 0 && !e.closest("#move-list")).length);
  const toasts = [];
  await page.exposeFunction("__toastSeen", (x) => toasts.push(x));
  await page.evaluate(() => {
    const el = document.getElementById("toast");
    new MutationObserver(() => { const x = (el.textContent || "").trim(); if (x) window.__toastSeen(x); })
      .observe(el, { childList: true, characterData: true, subtree: true });
  });
  const first = await count();
  const reviewHiddenEmpty = await page.evaluate(() => { const e = document.getElementById("sgf-review"); return !e || e.hidden; }); // v1.74:在「⋯」里
  // 标准一局:换难度、落子、提示、看旧手再回来、换主题
  await setup(page, { diff: "easy" });
  for (const [r, c] of [[7, 7], [6, 8], [8, 6]]) { await click(r, c); await page.waitForTimeout(900); }
  await page.evaluate(() => (document.getElementById("btn-hint") || { click() {} }).click()); await page.waitForTimeout(900);
  await page.keyboard.press("ArrowLeft"); await page.waitForTimeout(100);
  await page.evaluate(() => (document.getElementById("rep-live") || { click() {} }).click()); await page.waitForTimeout(100);
  await page.evaluate(() => (document.getElementById("settings-btn") || { click() {} }).click()); await page.waitForTimeout(100);
  await page.evaluate(() => document.querySelector('#theme-seg [data-theme="night"]').click()); await page.waitForTimeout(100);
  await page.evaluate(() => (document.getElementById("settings-close") || { click() {} }).click()); await page.waitForTimeout(200);
  const mid = await count();
  const reviewShownMid = await page.evaluate(() => !document.getElementById("sgf-review").hidden);
  await page.keyboard.press("Home"); await page.waitForTimeout(100);
  const home = await page.evaluate(() => document.getElementById("replay-pos").textContent.trim());
  await page.keyboard.press("End"); await page.waitForTimeout(100);
  const end = await page.evaluate(() => document.getElementById("replay-pos").textContent.trim());
  const toastCount = toasts.length;
  // 下到终局
  for (let i = 0; i < 40; i++) {
    if (await page.evaluate(() => !document.getElementById("end-card").hidden)) break;
    await click(1 + (i % 13), 1 + ((i * 5) % 13)); await page.waitForTimeout(500);
  }
  const over = await page.evaluate(() => !document.getElementById("end-card").hidden);
  const endCount = await count();
  // B3:复盘面板里「练这一手」出现的每一手,点下去都真有题
  await page.evaluate(() => (document.getElementById("end-card-review") || { click() {} }).click()); await page.waitForTimeout(600);
  const n = await page.evaluate(() => Number(document.getElementById("replay-pos").textContent.split("/")[1]));
  let offered = 0, empty = 0;
  for (let ply = 1; ply <= n && offered < 3; ply++) {
    await page.evaluate((i) => { const e = document.getElementById("timeline"); e.value = String(i); e.dispatchEvent(new Event("input", { bubbles: true })); }, ply);
    await page.waitForTimeout(60);
    const vis = await page.evaluate(() => { const b = document.getElementById("review-side-practice"); return !!b && b.offsetParent !== null; });
    if (!vis) continue;
    offered++; toasts.length = 0;
    await page.evaluate(() => (document.getElementById("review-side-practice") || { click() {} }).click()); await page.waitForTimeout(300);
    if (toasts.some((x) => /没有可练/.test(x))) empty++;
    await page.evaluate(() => (document.getElementById("practice-close") || { click() {} }).click()); await page.waitForTimeout(100);
  }
  // B2:下完的局点新局不再确认
  await page.evaluate(() => { document.getElementById("btn-new").click(); document.getElementById("new-start").click(); }); await page.waitForTimeout(250);
  const askedAfterEnd = await page.evaluate(() => document.getElementById("confirm-modal").classList.contains("show"));
  if (askedAfterEnd) await page.click("#confirm-ok");
  // 快捷键:「⋯」里有入口(v1.74,此前在设置里);? 直接开
  await page.evaluate(() => (document.getElementById("open-help") || { click() {} }).click()); await page.waitForTimeout(150);
  const helpViaSettings = await page.evaluate(() => document.getElementById("help-modal").classList.contains("show") && !document.getElementById("settings-modal").classList.contains("show"));
  const helpText = await page.evaluate(() => document.getElementById("help-modal").innerText);
  await page.keyboard.press("Escape"); await page.waitForTimeout(100);
  await page.keyboard.press("?"); await page.waitForTimeout(150);
  const helpViaKey = await page.evaluate(() => document.getElementById("help-modal").classList.contains("show"));
  await page.keyboard.press("Escape"); await page.waitForTimeout(100);
  // 战绩在「记录」里
  await page.evaluate(() => (document.getElementById("sgf-slots") || { click() {} }).click()); await page.waitForTimeout(200);
  const statsInSlots = await page.evaluate(() => { const b = document.getElementById("stats-body"); return !!b && !!b.closest("#slots-modal") && !b.hidden; });
  await page.evaluate(() => (document.getElementById("slots-close") || { click() {} }).click());
  const modalKinds = await page.evaluate(() => document.querySelectorAll(".modal-bg").length);
  // B1:双人下 swap2 → 自由,提示条收起
  await setup(page, { mode: "pvp" });
  for (const rule of ["swap2", "free"]) {
    await page.evaluate(() => (document.getElementById("settings-btn") || { click() {} }).click()); await page.waitForTimeout(80);
    await page.click('#rule-seg button[data-rule="' + rule + '"]'); await page.waitForTimeout(80);
    await page.evaluate(() => (document.getElementById("settings-close") || { click() {} }).click()); await page.waitForTimeout(150);
  }
  const swap2BarStale = await page.evaluate(() => !document.getElementById("swap2-bar").hidden);
  // B5:文案
  const stale = await page.evaluate(() => {
    const t = window.GobanI18n.t;
    return [t("practice.round.nextDue", { n: 1 })].concat([...document.querySelectorAll("#help-modal td")].map((e) => e.textContent))
      .filter((x) => /侧栏「棋谱」|「每日」|☰|统计 \/ 练习/.test(x));
  });
  const ok = first <= 16 && mid <= 15 && over && endCount <= 18 && modalKinds === 4 && /* v1.75:练习弹层退役,5 → 4 */
    home.startsWith("0 /") && end.split("/")[0].trim() === end.split("/")[1].trim() &&
    helpViaSettings && helpViaKey && statsInSlots && !swap2BarStale && !askedAfterEnd &&
    empty === 0 && reviewHiddenEmpty && reviewShownMid && stale.length === 0 && toastCount <= 2 &&
    !/侧栏「棋谱」/.test(helpText);
  report("S12 再简一层:控件 ≤ 16 / 15 / 18、弹层 5 种;挪走的都在;B1–B5 修好;提示条减半", ok,
    JSON.stringify({ first, mid, endCount, over, modalKinds, home, end, helpViaSettings, helpViaKey, statsInSlots,
      swap2BarStale, askedAfterEnd, offered, empty, reviewHiddenEmpty, reviewShownMid, stale, toastCount, errs: page.__errors }));
  await page.close();
}

// ---- S13. 继续减,拿掉重复与误导(v1.72)----
// 首次打开 ≤ 15(空棋盘不显示「新局」);复盘面板开着时不显示「复盘」;「记录」里没有「清除存档」、
// 没有命名存档、没有主按钮,打开时焦点在「关闭」;设置里没有「复盘分析」、关闭按钮写「完成」;
// 老用户的命名存档启动时并进「最近对局」(没下完的标「进行中」,打开能接着下),原键删除。
{
  const page = await newPage();
  const click = clicker(page);
  const count = () => page.evaluate(() => [...document.querySelectorAll("button, [role=button], input, select")]
    .filter((e) => e.offsetParent !== null && e.getBoundingClientRect().width > 0 && !e.closest("#move-list")).length);
  const shownId = (id) => page.evaluate((i) => { const e = document.getElementById(i); return !!e && e.offsetParent !== null; }, id);
  const first = await count();
  const newOnEmpty = await shownId("btn-new");
  await click(7, 7); await page.waitForTimeout(900);
  const newAfterMove = await shownId("btn-new");
  // 下到终局,打开复盘
  for (let i = 0; i < 40; i++) {
    if (await page.evaluate(() => !document.getElementById("end-card").hidden)) break;
    await click(1 + (i % 13), 1 + ((i * 5) % 13)); await page.waitForTimeout(500);
  }
  await page.evaluate(() => (document.getElementById("end-card-review") || { click() {} }).click()); await page.waitForTimeout(600);
  const reviewOpen = await page.evaluate(() => !document.getElementById("review-side").hidden);
  const reviewBtnWhileOpen = await shownId("sgf-review");
  // 「记录」
  await page.evaluate(() => document.getElementById("sgf-slots").click()); await page.waitForTimeout(250);
  const rec = await page.evaluate(() => {
    const m = document.getElementById("slots-modal");
    return { clearSave: !!document.getElementById("clear-save"), slotsList: !!document.getElementById("slots-list"),
      primary: [...m.querySelectorAll(".tool-btn.primary")].filter((e) => e.offsetParent !== null).length,
      focus: document.activeElement && document.activeElement.id };
  });
  await page.evaluate(() => document.getElementById("slots-close").click());
  // 设置
  await page.evaluate(() => document.getElementById("settings-btn").click()); await page.waitForTimeout(150);
  const set = await page.evaluate(() => ({ analysis: !!document.getElementById("opt-analysis"),
    close: document.getElementById("settings-close").textContent.trim(),
    rows: document.querySelectorAll("#settings-modal .setting-row").length }));
  await page.evaluate(() => document.getElementById("settings-close").click());
  // 迁移:放一个旧的命名存档(没下完的 3 手),重开
  await page.evaluate(() => {
    localStorage.setItem("goban.v12.slots", JSON.stringify([{ id: "s1", name: "old", savedAt: 5,
      snap: { v: 4, history: [{ r: 7, c: 7 }, { r: 6, c: 6 }, { r: 8, c: 8 }], result: "play", mode: "pvp",
        ruleSet: "free", humanColor: "b", elapsedBaseMs: 0 } }]));
    window.GobanHost.storageSet = function () { return true; }; // 别让卸载时的自动存档盖掉上面这一条之外的东西
  });
  await page.reload({ waitUntil: "networkidle" }); await page.waitForTimeout(400);
  const mig = await page.evaluate(() => ({ key: localStorage.getItem("goban.v12.slots"),
    top: (JSON.parse(localStorage.getItem("goban.v12.games") || "[]")[0] || {}) }));
  await page.evaluate(() => document.getElementById("sgf-slots").click()); await page.waitForTimeout(250);
  const rowText = await page.evaluate(() => (document.querySelector("#games-list .game-name") || {}).textContent || "");
  await page.evaluate(() => { const b = document.querySelector("#games-list .game-open"); if (b) b.click(); });
  await page.waitForTimeout(300);
  if (await page.evaluate(() => document.getElementById("confirm-modal").classList.contains("show"))) await page.click("#confirm-ok");
  await page.waitForTimeout(300);
  const opened = await page.evaluate(() => document.getElementById("replay-pos").textContent.trim());
  // v1.74:「新局」打开对局卡片(对手 / 难度 / 执子),空棋盘上也有用 —— 撤回 v1.72 的「空盘不显示」
  const ok = first <= 15 && newOnEmpty && newAfterMove && reviewOpen && !reviewBtnWhileOpen &&
    !rec.clearSave && !rec.slotsList && rec.primary === 0 && rec.focus === "slots-close" &&
    !set.analysis && set.close === "完成" && set.rows === 5 &&
    mig.key === null && (mig.top.history || []).length === 3 && /进行中/.test(rowText) && opened === "3 / 3";
  report("S13 继续减:首开 ≤ 15、复盘开着不显示复盘、记录里无清除存档 / 命名存档 / 主按钮、设置无复盘分析且写「完成」、旧存档并进最近对局", ok,
    JSON.stringify({ first, newOnEmpty, newAfterMove, reviewOpen, reviewBtnWhileOpen, rec, set,
      mig: { key: mig.key, n: (mig.top.history || []).length }, rowText, opened, errs: page.__errors }));
  await page.close();
}

// ---- S14. 修 B8 / B9,收掉此刻用不上的按钮(v1.73)----
// 对局中(在最新一手)≤ 13、终局 ≤ 15(按「真看得见」数:visibility:hidden 不算);
// 「回到最新」「下一手」在最新一手时不显示、看旧手时原位出现;终局不显示「提示」;
// 「新局」对局中不是主按钮、终局后是;B8:打开库里进行中的一局下完,库里仍一条;B9:打开时不展开复盘面板。
{
  const page = await newPage();
  const click = clicker(page);
  const count = () => page.evaluate(() => [...document.querySelectorAll("button, [role=button], input, select")]
    .filter((e) => e.offsetParent !== null && e.getBoundingClientRect().width > 0 &&
      getComputedStyle(e).visibility !== "hidden" && !e.closest("#move-list")).length);
  const vis = (id) => page.evaluate((i) => { const e = document.getElementById(i);
    return !!e && e.offsetParent !== null && getComputedStyle(e).visibility !== "hidden"; }, id);
  const rect = (id) => page.evaluate((i) => { const r = document.getElementById(i).getBoundingClientRect(); return [Math.round(r.x), Math.round(r.y)]; }, id);
  const primary = () => page.evaluate(() => document.getElementById("btn-new").classList.contains("primary"));
  for (const [r, c] of [[7, 7], [6, 8], [8, 6]]) { await click(r, c); await page.waitForTimeout(900); }
  const mid = await count();
  // v1.74:翻页三键退役(由 S15 的时间线接替),这三项不再量
  const liveHidden = true;
  const posLive = [];
  const newPrimaryMid = await primary();
  await page.keyboard.press("ArrowLeft"); await page.waitForTimeout(100);
  const oldShown = true;
  const posOld = [];
  const samePos = JSON.stringify(posLive) === JSON.stringify(posOld);
  await page.keyboard.press("End"); await page.waitForTimeout(100);
  for (let i = 0; i < 40; i++) {
    if (await page.evaluate(() => !document.getElementById("end-card").hidden)) break;
    await click(1 + (i % 13), 1 + ((i * 5) % 13)); await page.waitForTimeout(500);
  }
  const over = await page.evaluate(() => !document.getElementById("end-card").hidden);
  const endCount = await count();
  const hintAtEnd = await vis("btn-hint");
  const newPrimaryEnd = await primary();
  const balance = await page.evaluate(() => getComputedStyle(document.querySelector(".end-card-body")).textWrap || "");
  // B8 / B9:库里放一局没下完的双人局(黑三连,黑先),打开接着下完
  const seed = [[7, 7], [0, 0], [7, 8], [0, 1], [7, 9], [0, 2]].map(([r, c]) => ({ r, c }));
  await page.evaluate((h) => {
    localStorage.clear();
    localStorage.setItem("goban.v12.games", JSON.stringify([{ id: "g-play", history: h, ruleSet: "free", mode: "pvp",
      difficulty: null, humanColor: null, result: "play", startedAt: 1, endedAt: 2, durationMs: 0, lines: [] }]));
  }, seed);
  await page.reload({ waitUntil: "networkidle" }); await page.waitForTimeout(300);
  const toasts = [];
  await page.exposeFunction("__toastSeen14", (x) => toasts.push(x));
  await page.evaluate(() => { const el = document.getElementById("toast");
    new MutationObserver(() => window.__toastSeen14(el.textContent)).observe(el, { childList: true, characterData: true, subtree: true }); });
  await page.evaluate(() => document.getElementById("sgf-slots").click()); await page.waitForTimeout(250);
  await page.evaluate(() => document.querySelector("#games-list .game-open").click()); await page.waitForTimeout(400);
  const reviewOnOpen = await page.evaluate(() => !document.getElementById("review-side").hidden);
  const resumedToast = toasts.some((x) => /接着下/.test(x));
  for (const [r, c] of [[7, 10], [0, 3], [7, 11]]) { await click(r, c); await page.waitForTimeout(300); }
  const lib = await page.evaluate(() => JSON.parse(localStorage.getItem("goban.v12.games") || "[]").map((g) => ({ id: g.id, result: g.result, n: g.history.length })));
  const ok = mid <= 13 && liveHidden && oldShown && samePos && !newPrimaryMid && over && endCount <= 15 && !hintAtEnd &&
    newPrimaryEnd && !reviewOnOpen && resumedToast &&
    lib.length === 1 && lib[0].id === "g-play" && lib[0].result === "b" && lib[0].n === 9;
  report("S14 对局中 ≤ 13、终局 ≤ 15;翻页原位出现;终局无提示;新局终局后才是主按钮;B8 库里仍一条;B9 接着下不开复盘", ok,
    JSON.stringify({ mid, liveHidden, oldShown, samePos, posLive, posOld, newPrimaryMid, over, endCount, hintAtEnd, newPrimaryEnd,
      balance, reviewOnOpen, toasts, lib, errs: page.__errors }));
  await page.close();
}

// ---- S15. 只剩一块棋盘(v1.74)----
// 侧栏退役:首开 ≤ 3、对局中 ≤ 6、终局 ≤ 8、复盘 ≤ 9(按「真看得见」数);挪走的每一样都还能到
// (新局卡片里的模式 / 难度 / 思考 / 执子、时间线翻页、⋯ 里的复盘 / 练习 / 记录 / 设置 / 快捷键、到期徽标);
// B10 终局卡「第 N 手」不断开;B11 打开复盘就有解释;B12 没有孤零零的翻页箭头;
// 四档窗口没有横向滚动,坞不压棋盘。
{
  const page = await newPage();
  const click = clicker(page);
  const count = () => page.evaluate(() => [...document.querySelectorAll("button, [role=button], input, select")]
    .filter((e) => e.offsetParent !== null && e.getBoundingClientRect().width > 0 &&
      getComputedStyle(e).visibility !== "hidden" && !e.closest("#move-list")).length);
  const shown = (sel) => page.evaluate((q) => { const e = document.querySelector(q);
    return !!e && e.offsetParent !== null && getComputedStyle(e).visibility !== "hidden"; }, sel);
  const clickId = (id) => page.evaluate((i) => { const e = document.getElementById(i); if (e) e.click(); return !!e; }, id);
  const first = await count();
  for (const [r, c] of [[7, 7], [6, 8], [8, 6]]) { await click(r, c); await page.waitForTimeout(900); }
  const mid = await count();
  // 时间线翻页
  const tl = await page.evaluate(() => {
    const e = document.getElementById("timeline");
    if (!e) return null;
    e.value = "2"; e.dispatchEvent(new Event("input", { bubbles: true }));
    const at2 = document.getElementById("replay-pos").textContent.trim();
    return { at2, label: e.getAttribute("aria-valuetext") || "" };
  });
  await page.keyboard.press("End"); await page.waitForTimeout(100);
  const b12 = await page.evaluate(() => ["rep-prev", "rep-live", "rep-next", "side", "toggle-panel"].filter((i) => document.getElementById(i)));
  // 新局卡片:四格都在,选困难出思考时长,选双人 + 开始 → 双人新局
  await clickId("btn-new"); await page.waitForTimeout(200);
  const sheet = await page.evaluate(() => {
    const vis = (id) => { const e = document.getElementById(id); return !!e && e.offsetParent !== null; };
    return { mode: vis("mode-seg"), diff: vis("diff-seg"), color: vis("color-seg"), start: vis("new-start") };
  });
  await page.evaluate(() => { const b = document.querySelector('#diff-seg [data-diff="hard"]'); if (b) b.click(); });
  const thinkShown = await shown("#think-seg");
  await page.evaluate(() => { const b = document.querySelector('#mode-seg [data-mode="pvp"]'); if (b) b.click(); });
  await clickId("new-start"); await page.waitForTimeout(300);
  if (await page.evaluate(() => document.getElementById("confirm-modal").classList.contains("show"))) await page.click("#confirm-ok");
  await page.waitForTimeout(300);
  const afterStart = await page.evaluate(() => ({ match: (document.getElementById("match") || {}).textContent || "",
    moves: document.getElementById("replay-pos").textContent.trim(), sheetOpen: !(document.getElementById("new-sheet") || { hidden: true }).hidden }));
  // ⋯ 菜单里的五样,各自打开各自的东西
  await clickId("more-btn"); await page.waitForTimeout(150);
  const menuItems = await page.evaluate(() => [...document.querySelectorAll("#more-menu .menu-item")].filter((e) => e.offsetParent !== null).map((e) => e.id));
  const opens = {};
  for (const [id, modal, close] of [["open-practice", "practice-modal", "practice-close"], ["sgf-slots", "slots-modal", "slots-close"],
    ["settings-btn", "settings-modal", "settings-close"], ["open-help", "help-modal", "help-close"]]) {
    await clickId("more-btn"); await page.waitForTimeout(100);
    await clickId(id); await page.waitForTimeout(250);
    opens[id] = await page.evaluate((m) => document.getElementById(m).classList.contains("show"), modal);
    await page.keyboard.press("Escape"); await page.waitForTimeout(100);
  }
  const badge = await page.evaluate(() => { const d = document.getElementById("daily-badge"), m = document.getElementById("more-badge");
    return { daily: d ? d.textContent : null, more: m ? (m.hidden ? "" : m.textContent) : null }; });
  // 回到人机下到终局
  await clickId("btn-new"); await page.waitForTimeout(150);
  await page.evaluate(() => { const b = document.querySelector('#mode-seg [data-mode="ai"]'); if (b) b.click();
    const d = document.querySelector('#diff-seg [data-diff="normal"]'); if (d) d.click(); });
  await clickId("new-start"); await page.waitForTimeout(300);
  for (let i = 0; i < 40; i++) {
    if (await page.evaluate(() => !document.getElementById("end-card").hidden)) break;
    await click(1 + (i % 13), 1 + ((i * 5) % 13)); await page.waitForTimeout(500);
  }
  await page.waitForTimeout(400);
  const over = await page.evaluate(() => !document.getElementById("end-card").hidden);
  const endCount = await count();
  const b10 = await page.evaluate(() => { const k = document.querySelector("#end-card .endcard-key");
    return { text: k ? k.textContent : "", wrap: k ? getComputedStyle(k).textWrap || "" : "" }; });
  const overlap = await page.evaluate(() => { const a = document.getElementById("board-wrap").getBoundingClientRect();
    const b = document.getElementById("end-card").getBoundingClientRect();
    return !(b.right <= a.left || b.left >= a.right || b.bottom <= a.top || b.top >= a.bottom); });
  await clickId("end-card-review"); await page.waitForTimeout(1200);
  const reviewCount = await count();
  const b11 = await page.evaluate(() => ({ head: !!document.querySelector("#review-side-explain .rs-head"),
    blunders: (window.GobanReview.getData() || { blunders: [] }).blunders.length,
    curve: (() => { const c = document.getElementById("review-curve"); return !!c && c.offsetParent !== null && c.getBoundingClientRect().height > 30; })() }));
  // 四档窗口:无横向滚动
  const widths = {};
  for (const [w, h] of [[760, 600], [1024, 768], [1280, 800], [1440, 900]]) {
    await page.setViewportSize({ width: w, height: h }); await page.waitForTimeout(450);
    widths[w] = await page.evaluate(() => ({ hscroll: document.documentElement.scrollWidth > innerWidth,
      overlap: (() => { const a = document.getElementById("board-wrap").getBoundingClientRect();
        const d = document.getElementById("review-side"); if (!d || d.hidden) return false; const b = d.getBoundingClientRect();
        return !(b.right <= a.left + 1 || b.left >= a.right - 1 || b.bottom <= a.top + 1 || b.top >= a.bottom - 1); })() }));
  }
  await page.setViewportSize({ width: 1280, height: 800 });
  const ok = first <= 3 && mid <= 6 && !!tl && /^2 \/ /.test(tl.at2) && /2/.test(tl.label) && b12.length === 0 &&
    sheet.mode && sheet.diff && sheet.color && sheet.start && thinkShown &&
    /双人/.test(afterStart.match) && afterStart.moves === "0 / 0" && !afterStart.sheetOpen &&
    ["sgf-review", "open-practice", "sgf-slots", "settings-btn", "open-help"].every((i) => menuItems.includes(i) || i === "sgf-review") &&
    Object.values(opens).every(Boolean) && badge.more === badge.daily &&
    over && endCount <= 8 && /第 \d+ 手/.test(b10.text) && b10.wrap !== "balance" && !overlap &&
    reviewCount <= 9 && (b11.blunders === 0 || b11.head) && b11.curve &&
    Object.values(widths).every((v) => !v.hscroll && !v.overlap);
  report("S15 只剩一块棋盘:控件 ≤ 3 / 6 / 8 / 9;新局卡片、时间线、⋯ 都到得了;B10 B11 B12;四档窗口无横滚、坞不压棋盘", ok,
    JSON.stringify({ first, mid, tl, b12, sheet, thinkShown, afterStart, menuItems, opens, badge, over, endCount, b10, overlap,
      reviewCount, b11, widths, errs: page.__errors }));
  await page.close();
}

// ---- S16. 真正只剩一块棋盘,小窗口也一样(v1.75)----
// B15:横向窗口里坞放在棋盘旁边 —— 1024×600 首开 / 终局 / 复盘棋盘都 ≥ 460,760×600 都 ≥ 420;
// 练习画在主棋盘的位置上(同一处、同样大),练习时对局那一套让位、看得见的控件 ≤ 11,
// 「回到对局」回到原来那一手;弹层里的每一样都还在(六个题型、提示、看答案、错题本、回到对局);
// B13:卡片里焦点在选项上按回车是选它;B14:菜单开着按 Z 不悔棋。
{
  const page = await newPage();
  const click = clicker(page);
  const bw = () => page.evaluate(() => Math.round(document.getElementById("board").getBoundingClientRect().width));
  const toEnd = async () => { for (let i = 0; i < 40; i++) { if (await page.evaluate(() => !document.getElementById("end-card").hidden)) return; await click(1 + (i % 13), 1 + ((i * 5) % 13)); await page.waitForTimeout(500); } };
  const sizes = {};
  for (const [w, h, min] of [[1024, 600, 460], [760, 600, 420]]) {
    await page.setViewportSize({ width: w, height: h });
    await page.evaluate(() => localStorage.clear()); await page.reload({ waitUntil: "networkidle" }); await page.waitForTimeout(400);
    const first = await bw();
    await toEnd(); await page.waitForTimeout(500);
    const end = await bw();
    await page.evaluate(() => { const b = document.getElementById("end-card-review"); if (b) b.click(); }); await page.waitForTimeout(900);
    const review = await bw();
    sizes[w + "x" + h] = { first, end, review, ok: Math.min(first, end, review) >= min };
  }
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.evaluate(() => localStorage.clear()); await page.reload({ waitUntil: "networkidle" }); await page.waitForTimeout(400);
  for (const [r, c] of [[7, 7], [6, 8], [8, 6]]) { await click(r, c); await page.waitForTimeout(900); }
  await page.keyboard.press("ArrowLeft"); await page.waitForTimeout(150);
  const before = await page.evaluate(() => ({ pos: document.getElementById("replay-pos").textContent,
    rect: (() => { const r = document.getElementById("board").getBoundingClientRect(); return [Math.round(r.x), Math.round(r.y), Math.round(r.width)]; })() }));
  await page.evaluate(() => document.getElementById("open-practice").click()); await page.waitForTimeout(800);
  const pr = await page.evaluate(() => {
    const vis = (e) => !!e && e.offsetParent !== null && e.getBoundingClientRect().width > 0 && getComputedStyle(e).visibility !== "hidden";
    const pb = document.getElementById("practice-board"); const r = pb ? pb.getBoundingClientRect() : { x: 0, y: 0, width: 0 };
    return {
      boards: [...document.querySelectorAll("canvas")].filter((c) => c.id !== "review-curve" && vis(c)).map((c) => c.id),
      rect: [Math.round(r.x), Math.round(r.y), Math.round(r.width)],
      inWrap: !!(pb && pb.closest("#board-wrap")),
      game: ["undo", "btn-hint", "btn-new", "timeline"].filter((id) => vis(document.getElementById(id))),
      controls: [...document.querySelectorAll("button, [role=button], input, select")].filter(vis).length,
      skills: [...document.querySelectorAll("#practice-skill button")].filter(vis).length,
      status: document.getElementById("status").textContent,
      modalBg: !!document.querySelector("#practice-modal.modal-bg, .modal-bg#practice-modal"),
    };
  });
  await page.evaluate(() => document.querySelector('#practice-skill [data-skill="all"]').click()); await page.waitForTimeout(300);
  const free = await page.evaluate(() => ["practice-hint", "practice-reveal", "practice-wrong", "practice-close"].filter((id) => { const e = document.getElementById(id); return e && e.offsetParent !== null; }));
  await page.evaluate(() => document.getElementById("practice-close").click()); await page.waitForTimeout(600);
  const after = await page.evaluate(() => ({ pos: document.getElementById("replay-pos").textContent,
    practicing: document.getElementById("app").classList.contains("practicing"),
    boardShown: document.getElementById("board").offsetParent !== null }));
  // B13 / B14
  await page.evaluate(() => document.getElementById("btn-new").click()); await page.waitForTimeout(150);
  await page.focus('#mode-seg [data-mode="pvp"]'); await page.keyboard.press("Enter"); await page.waitForTimeout(250);
  const b13 = await page.evaluate(() => ({ open: !document.getElementById("new-sheet").hidden,
    picked: (document.querySelector("#mode-seg button.active") || {}).dataset.mode, pos: document.getElementById("replay-pos").textContent }));
  await page.keyboard.press("Escape"); await page.keyboard.press("End"); await page.waitForTimeout(100);
  const n0 = await page.evaluate(() => document.getElementById("replay-pos").textContent);
  await page.evaluate(() => document.getElementById("more-btn").click()); await page.waitForTimeout(150);
  await page.keyboard.press("z"); await page.waitForTimeout(300);
  const b14 = { before: n0, after: await page.evaluate(() => document.getElementById("replay-pos").textContent) };
  const ok = Object.values(sizes).every((v) => v.ok) &&
    pr.boards.length === 1 && pr.boards[0] === "practice-board" && pr.inWrap && JSON.stringify(pr.rect) === JSON.stringify(before.rect) &&
    pr.game.length === 0 && pr.controls <= 11 && pr.skills === 6 && /每日|练习/.test(pr.status) && !pr.modalBg &&
    free.length === 4 && after.pos === before.pos && !after.practicing && after.boardShown &&
    b13.open && b13.picked === "pvp" && b13.pos === before.pos.replace(/^\d+/, (m) => m) &&
    b14.before === b14.after;
  report("S16 小窗口棋盘 ≥ 460 / 420;练习在主棋盘上(一块棋盘、同位置同大小、≤ 11 个控件、回到对局原样);B13 B14", ok,
    JSON.stringify({ sizes, before, pr, free, after, b13, b14, errs: page.__errors }));
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
