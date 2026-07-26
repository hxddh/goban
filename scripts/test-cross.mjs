/**
 * Cross-feature browser regression: swap2 × save/restore × slots × import.
 * These are the combinations a single-feature smoke never walks — the v1.23
 * mid-opening save/restore bug lived exactly here.
 *
 * Run: node scripts/test-cross.mjs
 * Needs Playwright + Chromium; override discovery with:
 *   PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs
 *   PLAYWRIGHT_CHROMIUM=/path/to/chromium
 * Skips (exit 0) when Playwright is unavailable so plain `node` environments
 * (CI unit-test jobs) are not broken by it.
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

// Skipping keeps plain `node` environments usable, but a silent skip in CI
// would turn this whole suite into a green no-op — REQUIRE_PLAYWRIGHT=1 (set
// by .github/workflows/ci.yml) makes a missing browser a hard failure.
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

// js/worker-src.js is generated at build time and is therefore absent from
// src/web. Serving a 404 for it (as this suite used to) makes engine.js fall
// back to fetch() — a path the packaged app can never take, since the zero://
// scheme handler returns responses spec-strict fetch() rejects. Generate it
// here so the whole suite runs against what actually ships.
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
const ctx = await browser.newContext();
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
  // Tests share one context (clipboard permission needs it) — isolate state:
  // neutralize the dying page's unload auto-save (beforeunload/pagehide/
  // visibilitychange all write) BEFORE clearing, or the clear gets undone.
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
      const S = window.GobanCore.SIZE;
      const rect = cv.getBoundingClientRect();
      const w = cv.width, pad = w * 0.045, step = (w - pad * 2) / (S - 1);
      const x = rect.left + ((pad + c * step) / w) * rect.width;
      const y = rect.top + ((pad + r * step) / w) * rect.height;
      cv.dispatchEvent(new MouseEvent("click", { clientX: x, clientY: y, bubbles: true }));
    }, { r, c });
}

const snap = (page) =>
  page.evaluate(() => ({
    bar: !document.getElementById("swap2-bar").hidden,
    msg: document.getElementById("swap2-msg").textContent,
    btns: [...document.querySelectorAll(".swap2-btn")].map((b) => b.textContent),
    moves: document.getElementById("replay-pos").textContent,
    status: document.getElementById("status").textContent,
  }));

// "]" is idempotent (setPanelOpen(true)); #toggle-panel flips. Since v1.33
// the panel starts OPEN on a fresh profile — and newPage() clears storage, so
// every page here is a fresh profile — which turned a "click to open" into a
// "click to close" and made the controls inside inert.
async function openPanel(page) {
  await page.keyboard.press("]");
  await page.waitForTimeout(120);
}

async function dismissConfirm(page) {
  if (await page.evaluate(() => document.getElementById("confirm-modal").classList.contains("show"))) {
    await page.click("#confirm-ok");
    await page.waitForTimeout(120);
  }
}

async function enableSwap2Pvp(page) {
  await openPanel(page);
  await page.click('button[data-mode="pvp"]');
  await page.waitForTimeout(100);
  await dismissConfirm(page);
  await page.click('button[data-opening="swap2"]');
  await page.waitForTimeout(120);
  await dismissConfirm(page);
}

// ---- Test 0: [hidden] elements must be VISUALLY hidden in every theme ----
// The v1.23 swap2-bar leak passed attribute-level checks (el.hidden was true)
// while author CSS display rules kept it rendered — assert computed display.
{
  const page = await newPage();
  const leaks = [];
  for (const theme of ["wood", "night", "day", "notebook"]) {
    await page.evaluate((t) => document.documentElement.setAttribute("data-theme", t), theme);
    await page.waitForTimeout(60);
    const found = await page.evaluate(() =>
      [...document.querySelectorAll("[hidden]")].filter((el) => {
        const r = el.getBoundingClientRect();
        return getComputedStyle(el).display !== "none" || r.width > 0 || r.height > 0;
      }).map((el) => el.id || el.className));
    if (found.length) leaks.push(theme + ":" + found.join(","));
  }
  // positive path: the swap2 bar still SHOWS once the opening is active
  await page.evaluate(() => document.documentElement.setAttribute("data-theme", "wood"));
  await enableSwap2Pvp(page);
  const bar = await page.evaluate(() => {
    const el = document.getElementById("swap2-bar");
    const r = el.getBoundingClientRect();
    return { hidden: el.hidden, display: getComputedStyle(el).display, w: r.width };
  });
  report("0 [hidden] visually hidden in all themes (+bar shows when active)",
    leaks.length === 0 && !bar.hidden && bar.display !== "none" && bar.w > 100 &&
      page.__errors.length === 0,
    JSON.stringify({ leaks, bar, errs: page.__errors }));
  await page.close();
}

// ---- Test 0b: top-bar actions must stay clickable with the sidebar open ----
// The sidebar used to paint over the chrome bar: 悔棋/提示/新局/?/☰ showed
// through as ghosts but every click landed on #side, and the sidebar hosts no
// duplicates of them — an open panel left no way to undo or start a new game
// by mouse. Attribute/visibility checks all passed; only hit testing catches
// it, so assert elementFromPoint at each button's centre, both panel states,
// across the window widths the app actually runs at.
{
  const page = await newPage();
  const IDS = ["undo", "btn-hint", "btn-new", "help-btn", "toggle-panel"];
  const hitTest = () =>
    page.evaluate((ids) => {
      const bar = document.querySelector(".chrome").getBoundingClientRect();
      const bad = [];
      for (const id of ids) {
        const el = document.getElementById(id);
        const b = el.getBoundingClientRect();
        const hit = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2);
        if (!(hit === el || el.contains(hit))) {
          bad.push(id + "←" + (hit ? hit.id || hit.className || hit.tagName : "null"));
        } else if (b.right > bar.right + 0.5 || b.left < bar.left - 0.5) {
          bad.push(id + ":出界"); // squeezed out of the bar rather than covered
        }
      }
      return bad;
    }, IDS);

  const blocked = [];
  // Toggle with the keyboard shortcuts ("]" open / "[" close) so a covered ☰
  // cannot abort the run — the pointer assertions below are the actual test.
  for (const width of [560, 700, 820, 960, 1280, 1728]) {
    await page.setViewportSize({ width, height: 860 });
    await page.waitForTimeout(120);
    for (const id of await hitTest()) blocked.push(width + "px 收起:" + id);

    await page.keyboard.press("]");
    await page.waitForTimeout(420); // .28s panel transition + settle
    const openPanel = await page.evaluate(() =>
      document.getElementById("app").classList.contains("panel-open"));
    if (!openPanel) blocked.push(width + "px 面板未打开");
    for (const id of await hitTest()) blocked.push(width + "px 展开:" + id);

    // …and a real click must still reach a handler while the panel is open
    let helpOpens = false;
    try {
      await page.click("#help-btn", { timeout: 2500 });
      await page.waitForTimeout(200);
      helpOpens = await page.evaluate(() =>
        document.getElementById("help-modal").classList.contains("show"));
    } catch (_) { helpOpens = false; }
    if (!helpOpens) blocked.push(width + "px 展开:帮助点不开");
    await page.keyboard.press("Escape"); // close help (if it opened)
    await page.waitForTimeout(150);
    await page.keyboard.press("[");
    await page.waitForTimeout(420);
  }
  await page.setViewportSize({ width: 1280, height: 860 });
  report("0b 顶栏按钮在侧栏开合两态下均可点击",
    blocked.length === 0 && page.__errors.length === 0,
    JSON.stringify({ blocked, errs: page.__errors }));
  await page.close();
}

// ---- Test A: mid-'place' save/restore (the v1.23 bug) ----
{
  const page = await newPage();
  const click = clicker(page);
  await enableSwap2Pvp(page);
  await click(7, 7); await page.waitForTimeout(100);
  await click(7, 8); await page.waitForTimeout(150);
  const before = await snap(page);
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForTimeout(300);
  const after = await snap(page);
  await clicker(page)(5, 5); await page.waitForTimeout(200);
  const choice = await snap(page);
  report("A swap2 mid-place survives reload",
    before.bar && after.bar && /第 3 子/.test(after.msg) && /布子中/.test(after.status) &&
      choice.btns.length === 3 && page.__errors.length === 0,
    JSON.stringify({ after: after.msg, choiceBtns: choice.btns.length, errs: page.__errors }));
  await page.close();
}

// ---- Test B: mid-'p1choose' (after 加两手) save/restore ----
{
  const page = await newPage();
  const click = clicker(page);
  await enableSwap2Pvp(page);
  await click(7, 7); await page.waitForTimeout(80);
  await click(7, 8); await page.waitForTimeout(80);
  await click(5, 5); await page.waitForTimeout(150);
  await page.click('.swap2-btn:has-text("加两手")'); await page.waitForTimeout(120);
  await click(9, 9); await page.waitForTimeout(80);
  await click(9, 10); await page.waitForTimeout(150);
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForTimeout(300);
  const after = await snap(page);
  await page.click('.swap2-btn:has-text("执黑")'); await page.waitForTimeout(150);
  await clicker(page)(3, 3); await page.waitForTimeout(150);
  const end = await snap(page);
  report("B swap2 mid-p1choose survives reload",
    after.bar && after.btns.length === 2 && end.bar === false && end.moves === "6 / 6" &&
      page.__errors.length === 0,
    JSON.stringify({ afterBtns: after.btns, endMoves: end.moves, errs: page.__errors }));
  await page.close();
}

// ---- Test C: loading a normal slot mid-swap2 cancels the opening ----
{
  const page = await newPage();
  const click = clicker(page);
  await openPanel(page);
  await page.waitForTimeout(80);
  await page.click('button[data-mode="pvp"]');
  await page.waitForTimeout(100);
  await dismissConfirm(page);
  await click(7, 7); await page.waitForTimeout(80);
  await click(7, 8); await page.waitForTimeout(120);
  await page.click("#sgf-slots"); await page.waitForTimeout(120);
  await page.click("#slot-save-current"); await page.waitForTimeout(120);
  await page.click("#slots-close"); await page.waitForTimeout(80);
  await page.click('button[data-opening="swap2"]');
  await page.waitForTimeout(120);
  await dismissConfirm(page);
  await click(10, 10); await page.waitForTimeout(120);
  const mid = await snap(page);
  await page.click("#sgf-slots"); await page.waitForTimeout(120);
  await page.click(".slot-load"); await page.waitForTimeout(150);
  await dismissConfirm(page);
  await page.waitForTimeout(150);
  const loaded = await snap(page);
  await click(8, 8); await page.waitForTimeout(150);
  const end = await snap(page);
  report("C slot load mid-swap2 cancels opening",
    mid.bar && loaded.bar === false && loaded.moves === "2 / 2" && end.moves === "3 / 3" &&
      page.__errors.length === 0,
    JSON.stringify({ mid: mid.bar, loaded: loaded.moves, end: end.moves, errs: page.__errors }));
  await page.close();
}

// ---- Test D: mid-swap2 slot round-trip restores the opening phase ----
{
  const page = await newPage();
  const click = clicker(page);
  await enableSwap2Pvp(page);
  await click(7, 7); await page.waitForTimeout(80);
  await click(7, 8); await page.waitForTimeout(150);
  await page.click("#sgf-slots"); await page.waitForTimeout(120);
  await page.click("#slot-save-current"); await page.waitForTimeout(120);
  await page.click("#slots-close"); await page.waitForTimeout(80);
  await click(2, 2); await page.waitForTimeout(150);
  await page.click('.swap2-btn:has-text("执白")'); await page.waitForTimeout(150);
  await page.click("#sgf-slots"); await page.waitForTimeout(120);
  await page.click(".slot-load"); await page.waitForTimeout(150);
  await dismissConfirm(page);
  await page.waitForTimeout(200);
  const restored = await snap(page);
  report("D mid-swap2 slot restores opening phase",
    restored.bar && /第 3 子/.test(restored.msg) && restored.moves === "2 / 2" &&
      page.__errors.length === 0,
    JSON.stringify({ msg: restored.msg, moves: restored.moves, errs: page.__errors }));
  await page.close();
}

// ---- Test E: SGF import mid-swap2 cancels the opening overlay ----
{
  const page = await newPage();
  const click = clicker(page);
  await enableSwap2Pvp(page);
  await click(7, 7); await page.waitForTimeout(120);
  const mid = await snap(page);
  await page.evaluate(() =>
    navigator.clipboard.writeText("(;FF[4]GM[4]SZ[15];B[hh];W[ii];B[gg];W[jj])"));
  await page.click("#sgf-paste"); await page.waitForTimeout(300);
  await dismissConfirm(page);
  await page.waitForTimeout(200);
  const after = await snap(page);
  report("E import mid-swap2 cancels opening",
    mid.bar && after.bar === false && after.moves === "4 / 4" && page.__errors.length === 0,
    JSON.stringify({ after: after.moves, bar: after.bar, errs: page.__errors }));
  await page.close();
}

// ---- Test F: AI-mode mid-p2choose reload re-triggers the AI side choice ----
{
  const page = await newPage();
  const click = clicker(page);
  await openPanel(page);
  await page.waitForTimeout(80);
  await page.click('button[data-opening="swap2"]');
  await page.waitForTimeout(120);
  await dismissConfirm(page);
  await click(7, 7); await page.waitForTimeout(80);
  await click(7, 8); await page.waitForTimeout(80);
  // 3rd stone starts a 350ms AI decision timer — reload BEFORE it fires
  await click(5, 5); await page.waitForTimeout(60);
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForTimeout(1200); // restore + 500ms rescheduled AI choice + settle
  const after = await snap(page);
  const roles = await page.evaluate(() => ({
    b: document.getElementById("black-role").textContent,
    w: document.getElementById("white-role").textContent,
  }));
  const humanAssigned = roles.b === "你" || roles.w === "你";
  report("F AI mid-p2choose reload resumes AI choice",
    after.bar === false && humanAssigned && page.__errors.length === 0,
    JSON.stringify({ bar: after.bar, roles, status: after.status, errs: page.__errors }));
  await page.close();
}

// ---- Test G: 中英切换 — static markup, runtime strings and persistence ----
{
  const page = await newPage();
  await page.keyboard.press("]");
  await page.waitForTimeout(420);
  const zh = await page.evaluate(() => ({
    undo: document.getElementById("undo").textContent,
    status: document.getElementById("status").textContent,
    practice: document.getElementById("open-practice").textContent,
    lang: document.documentElement.getAttribute("lang"),
  }));

  await page.click('#lang-seg button[data-lang="en"]');
  await page.waitForTimeout(300);
  const en = await page.evaluate(() => ({
    undo: document.getElementById("undo").textContent,
    status: document.getElementById("status").textContent,
    practice: document.getElementById("open-practice").textContent,
    title: document.getElementById("undo").getAttribute("title"),
    lang: document.documentElement.getAttribute("lang"),
    stored: localStorage.getItem("goban.v12.lang"),
  }));
  const CJK = /[\u4e00-\u9fa5]/;
  // the whole visible chrome + sidebar must be free of Chinese in English mode
  const leftovers = await page.evaluate(() => {
    const out = [];
    const scope = [document.querySelector(".chrome"), document.getElementById("side")];
    for (const root of scope) {
      root.querySelectorAll("*").forEach((el) => {
        if (el.children.length) return; // leaf nodes only
        const txt = (el.textContent || "").trim();
        if (/[\u4e00-\u9fa5]/.test(txt) && !el.hasAttribute("data-i18n-raw")) out.push(txt.slice(0, 12));
      });
    }
    return out;
  });

  // a runtime-rendered string too: play one move so the status line is derived
  await clicker(page)(7, 7);
  await page.waitForTimeout(400);
  const runtimeEn = await page.evaluate(() => document.getElementById("status").textContent);

  // persistence across reload
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForTimeout(500);
  const afterReload = await page.evaluate(() => ({
    undo: document.getElementById("undo").textContent,
    lang: document.documentElement.getAttribute("lang"),
  }));

  // …and back to 中文
  await page.keyboard.press("]");
  await page.waitForTimeout(420);
  await page.click('#lang-seg button[data-lang="zh"]');
  await page.waitForTimeout(300);
  const backZh = await page.evaluate(() => document.getElementById("undo").textContent);

  report("G 中英切换：静态文案 + 运行时文案 + 持久化",
    zh.undo === "悔棋" && en.undo === "Undo" && en.title === "Undo (Z)" &&
      en.practice === "Practice" && !CJK.test(en.status) && en.lang === "en" &&
      en.stored === "en" && leftovers.length === 0 && !CJK.test(runtimeEn) &&
      afterReload.undo === "Undo" && afterReload.lang === "en" && backZh === "悔棋" &&
      page.__errors.length === 0,
    JSON.stringify({ zh: zh.undo, en: en.undo, runtimeEn, leftovers: leftovers.slice(0, 3),
      afterReload: afterReload.undo, backZh, errs: page.__errors }));
  await page.close();
}

// ---- Test H: the engine worker boots from the SHIPPED bundle -------------
// Not "a worker starts" — which the fetch fallback also satisfies — but that
// the embedded bundle is the thing that started it, with the fetch path cut
// off the way zero:// cuts it off in the packaged app.
{
  const page = await newPage();
  await page.route("**/js/{core,ai,ai2,ai-worker}.js", (route) =>
    route.request().resourceType() === "fetch" ? route.abort() : route.continue());
  await page.goto(ORIGIN + "/index.html");
  await page.waitForTimeout(1500);

  const embedded = await page.evaluate(() => typeof window.GOBAN_WORKER_SRC === "string" && window.GOBAN_WORKER_SRC.length > 1000);
  const state = await page.evaluate(() =>
    window.GobanEngine && window.GobanEngine.state ? window.GobanEngine.state() : "?");

  // and it can actually answer a move — a worker that boots but cannot think
  // would still read "ready"
  const g = await page.evaluate(() => {
    const r = document.getElementById("board").getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, pad: r.width * 0.06 };
  });
  const step = (g.w - 2 * g.pad) / 14;
  await page.mouse.click(g.x + g.pad + 7 * step, g.y + g.pad + 7 * step);
  const answered = await page
    .waitForFunction(() => document.getElementById("move-list").children.length >= 2, { timeout: 10000 })
    .then(() => true).catch(() => false);

  report("H 打包版 worker：内嵌 bundle 启动并应答（fetch 兜底已切断）",
    embedded && state === "ready" && answered,
    JSON.stringify({ embedded, state, answered }));
  await page.close();
}

// I 对比度：--accent 是按「面」调的（描边、色块、落子标记），但同一个变量
// 在五处又当文字用。day 的 #b8894a 当文字只有 2.75:1，v1.32 才分出
// --accent-text。四个主题一起量，避免下次只改一个主题的调色板时又漏掉。
{
  const page = await newPage();
  await page.waitForTimeout(300);
  const rows = [];
  for (const theme of ["wood", "night", "day", "notebook"]) {
    await page.evaluate((t) => document.querySelector(`#theme-seg button[data-theme="${t}"]`)?.click(), theme);
    await page.waitForTimeout(150);
    rows.push(await page.evaluate((t) => {
      // getComputedStyle returns rendered colours; composite any alpha onto the
      // opaque ancestor, or a 14% tint reads as fully opaque and passes wrongly.
      const parse = (s) => {
        const n = (s.match(/[\d.]+/g) || []).map(Number);
        if (/^color\(srgb/.test(s)) return [n[0] * 255, n[1] * 255, n[2] * 255, n.length > 3 ? n[3] : 1];
        return [n[0], n[1], n[2], n.length > 3 ? n[3] : 1];
      };
      const lum = ([r, g, b]) => {
        const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
        return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
      };
      // 导入 is always enabled — 复制/导出 are disabled at 0 手 (opacity .35),
      // and disabled controls are exempt from the contrast rule anyway.
      const el = document.getElementById("sgf-import");
      let bg = [255, 255, 255, 1], n = el;
      while (n) {
        const c = parse(getComputedStyle(n).backgroundColor);
        if (c[3] > 0) { bg = c[3] >= 1 ? c : c.map((v, i) => i < 3 ? v * c[3] + 255 * (1 - c[3]) : 1); break; }
        n = n.parentElement;
      }
      const fg = parse(getComputedStyle(el).color);
      const a = lum(fg), b = lum(bg);
      return { theme: t, ratio: +(((Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)).toFixed(2)) };
    }, theme));
  }
  const bad = rows.filter((r) => r.ratio < 4.5);
  report("I 四个主题下 --accent-text 当正文都过 AA 4.5:1",
    bad.length === 0 && page.__errors.length === 0,
    JSON.stringify({ rows, errs: page.__errors }));
  await page.close();
}

// J 键盘可达：v1.31 之前 Tab 被绑去开合侧栏,于是 40 个按钮一个都走不到,
// 而弹层从 v1.25.2 起就有焦点陷阱。两头都要守：主界面 Tab 走得进侧栏,
// 弹层里 Tab 走不出去。
{
  const page = await newPage();
  await page.keyboard.press("]");
  await page.waitForTimeout(350);
  const seen = new Set();
  for (let i = 0; i < 40; i++) {
    await page.keyboard.press("Tab");
    const id = await page.evaluate(() => {
      const e = document.activeElement;
      return e && e !== document.body && e.closest("#side") ? (e.id || e.textContent.trim().slice(0, 8)) : null;
    });
    if (id) seen.add(id);
  }
  await page.evaluate(() => document.getElementById("help-btn").click());
  await page.waitForTimeout(300);
  let escaped = 0;
  for (let i = 0; i < 6; i++) {
    await page.keyboard.press("Tab");
    if (!(await page.evaluate(() => !!(document.activeElement && document.activeElement.closest(".modal-bg"))))) escaped++;
  }
  report("J Tab 走得进侧栏（≥20 项）且走不出弹层",
    seen.size >= 20 && escaped === 0 && page.__errors.length === 0,
    JSON.stringify({ reachable: seen.size, escaped, errs: page.__errors }));
  await page.close();
}

// K 折叠线：五个功能入口在任何常见窗口高度都要够得着。v1.32 把侧栏刮到
// 856px 让它们挤进 900px 的窗口，但 1280×720 同样是普通窗口，那里又掉到线下。
// v1.33 改成钉住脚栏——断言从"侧栏不滚动"改成"入口在视口内"，因为后者才是
// 用户真正在乎的事，而且不随内容多寡失效。
{
  const FEATS = ["open-practice", "open-daily", "open-stats", "sgf-slots", "sgf-review"];
  const bad = [];
  for (const [w, h] of [[1280, 720], [1366, 768], [960, 900], [1440, 900]]) {
    const page = await newPage();
    await page.setViewportSize({ width: w, height: h });
    await page.keyboard.press("]");
    await page.waitForTimeout(350);
    const miss = await page.evaluate((ids) => {
      const H = innerHeight, W = innerWidth;
      return ids.filter((id) => {
        const e = document.getElementById(id);
        if (!e) return true;
        const b = e.getBoundingClientRect();
        return !(b.width > 0 && b.height > 0 && b.top >= 0 && b.bottom <= H + 0.5 &&
                 b.right > 0 && b.left < W);
      });
    }, FEATS);
    if (miss.length) bad.push(w + "x" + h + ":" + miss.join(","));
    if (page.__errors.length) bad.push(w + "x" + h + ":errs " + page.__errors.join("|"));
    await page.close();
  }
  report("K 五个功能入口在 720/768/900 高的窗口都在视口内",
    bad.length === 0, JSON.stringify({ bad }));
}

// L 首屏可见性：v1.32 之前侧栏默认关闭，视口内只剩 5 个按钮，
// 练习/每日/复盘/统计/存档 全在 ☰ 之后且没有任何引导。首次运行展开一次；
// 用户自己关掉之后必须记住，否则就成了每次都要关的骚扰。
{
  const page = await newPage();
  const seen = await page.evaluate(() => {
    const W = innerWidth, H = innerHeight;
    const inView = (e) => {
      const b = e.getBoundingClientRect();
      return b.width > 0 && b.height > 0 && b.right > 0 && b.left < W && b.bottom > 0 && b.top < H;
    };
    return {
      open: document.getElementById("app").classList.contains("panel-open"),
      feats: ["open-practice", "open-daily", "sgf-review", "open-stats", "sgf-slots"]
        .filter((id) => { const e = document.getElementById(id); return e && inView(e); }).length,
    };
  });
  await page.keyboard.press("[");
  await page.waitForTimeout(400);
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForTimeout(400);
  const remembered = await page.evaluate(() =>
    !document.getElementById("app").classList.contains("panel-open"));
  report("L 首次运行侧栏展开（5 个功能入口可见）且记住用户关闭",
    seen.open && seen.feats === 5 && remembered && page.__errors.length === 0,
    JSON.stringify({ ...seen, remembered, errs: page.__errors }));
  await page.close();
}

// M 长思考的出口：极限档每手 5s（深 8s）。此前思考期间悔棋被禁用，误落一子
// 只能等满预算。悔棋现在兼任取消键——中断、撤回自己那一手，且电脑不再落子。
// 局面何时进入真正的搜索取决于战术层，所以这里落子直到观察到思考态为止。
{
  const page = await newPage();
  await page.evaluate(() => document.querySelector('button[data-diff="extreme"]').click());
  await page.waitForTimeout(250);
  await dismissConfirm(page);
  await page.waitForTimeout(200);
  const click = clicker(page);
  const pts = [[7, 7], [6, 8], [8, 6], [9, 7], [5, 6], [10, 4], [4, 10], [11, 3], [3, 11]];
  let caught = null;
  for (const [r, c] of pts) {
    const before = await page.evaluate(() => document.getElementById("replay-pos").textContent.trim());
    await click(r, c);
    await page.waitForTimeout(450);
    const st = await page.evaluate(() => ({
      thinking: /思考中|thinking/i.test(document.getElementById("status").textContent),
      undoLive: !document.getElementById("undo").disabled,
      moves: document.getElementById("replay-pos").textContent.trim(),
    }));
    if (st.thinking) { caught = { before, ...st }; break; }
    await page.waitForFunction(
      () => !/思考中|thinking/i.test(document.getElementById("status").textContent),
      { timeout: 40000 }).catch(() => {});
  }
  let after = null;
  if (caught) {
    await page.evaluate(() => document.getElementById("undo").click());
    await page.waitForTimeout(1600);
    after = await page.evaluate(() => ({
      thinking: /思考中|thinking/i.test(document.getElementById("status").textContent),
      moves: document.getElementById("replay-pos").textContent.trim(),
    }));
  }
  const n = (m) => Number(String(m).split("/")[0].trim());
  report("M 思考中悔棋可点，点了即中断并撤回，电脑不再落子",
    !!caught && caught.undoLive && after && !after.thinking &&
      n(after.moves) === n(caught.moves) - 1 && page.__errors.length === 0,
    JSON.stringify({ caught, after, errs: page.__errors }));
  await page.close();
}

// N 减少动效：到 v1.32 为止整个媒体查询只有一条规则（.think-dot），
// 57 个元素照动 —— 声明了但没实现。
{
  const counts = {};
  for (const mode of ["no-preference", "reduce"]) {
    const p2 = await ctx.newPage();
    await p2.emulateMedia({ reducedMotion: mode });
    await p2.goto(ORIGIN + "/index.html", { waitUntil: "networkidle" });
    await p2.waitForTimeout(400);
    counts[mode] = await p2.evaluate(() => {
      let c = 0;
      for (const el of document.querySelectorAll("*")) {
        const s = getComputedStyle(el);
        const t = s.transitionDuration.split(",").some((d) => parseFloat(d) > 0.001);
        const a = s.animationName !== "none" &&
          s.animationDuration.split(",").some((d) => parseFloat(d) > 0.001);
        if (t || a) c++;
      }
      return c;
    });
    await p2.close();
  }
  // The positive half matters as much: a stylesheet that animates nothing at
  // all would pass a "reduce === 0" check while having no motion to reduce.
  report("N prefers-reduced-motion 真的停下来（正常态仍有动效）",
    counts.reduce === 0 && counts["no-preference"] > 20,
    JSON.stringify(counts));
}

// O 悔棋不能把棋局卡死。v1.33.0 把中断放在了 undo() 的守卫之前：执白开局时
// 电脑在空盘上思考，此时按 z（按钮是禁用的，但 z / ⌘Z / 原生菜单都直达 undo()）
// 会掐掉思考然后 early-return —— 没人调 maybeAiTurn()，电脑再也不落子；也没人
// 调 sync()，状态一直冻在「电脑思考中…」。这一条守的是"中断之后局面仍然自洽"。
{
  const page = await newPage();
  // 装一个探针：一进入「思考中 且 0 手」就立刻派发 z，不靠时序碰运气
  await page.evaluate(() => {
    window.__fired = false;
    const tick = () => {
      const st = document.getElementById("status").textContent;
      const mv = document.getElementById("replay-pos").textContent.trim();
      if (!window.__fired && /思考中|thinking/i.test(st) && /^0 \/ 0$/.test(mv)) {
        window.__fired = true;
        document.dispatchEvent(new KeyboardEvent("keydown", { key: "z", bubbles: true }));
        return;
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  await page.evaluate(() => document.querySelector('button[data-human="w"]').click());
  await page.waitForTimeout(250);
  await dismissConfirm(page);
  await page.waitForTimeout(4000);
  const r = await page.evaluate(() => ({
    fired: window.__fired,
    moves: document.getElementById("replay-pos").textContent.trim(),
    status: document.getElementById("status").textContent.trim(),
  }));
  // fired=false 只说明这次没抓到窗口（开局走定式，很快），不算失败；
  // 抓到了就必须证明电脑仍然落了子。
  report("O 电脑开局思考时按 z 不会把棋局卡死",
    (!r.fired || r.moves !== "0 / 0") && !/思考中|thinking/i.test(r.status) &&
      page.__errors.length === 0,
    JSON.stringify({ ...r, errs: page.__errors }));
  await page.close();
}

console.log("---");
const allOk = results.every((r) => r.ok);
console.log(allOk ? "CROSS_ALL_OK" : "CROSS_FAIL (" + results.filter((r) => !r.ok).map((r) => r.name).join("; ") + ")");
await browser.close();
server.close();
process.exit(allOk ? 0 : 1);
