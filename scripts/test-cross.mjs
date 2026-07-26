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
/** Flipped by gate V; the stylesheet is linked from index.html, so the request
 *  for it carries no query of ours — a server flag is the only handle. */
let NOMIX = false;
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
  // NOMIX serves the stylesheet an engine without color-mix() effectively
  // sees: every color-mix declaration dropped, and @supports not(...) taken.
  // Only "prop: …color-mix(" lines go — striking the @supports condition line
  // would leave an orphan block, and striking a comment line that carries the
  // closing */ would swallow everything after it. Both mistakes corrupt the
  // sheet from that point on and make the simulation measure nothing real.
  if (rel === "styles.css" && NOMIX) {
    const css = fs.readFileSync(file, "utf8")
      .split("\n")
      .filter((l) => !/^\s*[-a-z][-a-z]*\s*:.*color-mix\(/.test(l))
      .join("\n")
      .replace("@supports not (background: color-mix(in srgb, red 50%, blue))",
               "@supports (display: block)");
    res.writeHead(200, { "content-type": "text/css" });
    res.end(css);
    return;
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

// P 渐变底上的文字也要过 AA。此前每一次对比度审计都把 background-image 是渐变的
// 元素整个跳过（"渐变底跳过 7~9"），于是「新局」这个主按钮的白字在日间/笔记本主题下
// 一直是 2.79（顶边）/ 3.44–4.20（文字所在的那条带），从 v1.9 活到 v1.33.1，
// 连过四次审计。跳过等于没测 —— 这一条按色标插值算，不再回避。
{
  const bad = [];
  const page = await newPage();
  for (const theme of ["wood", "night", "day", "notebook"]) {
    await page.evaluate((t) => document.querySelector(`#theme-seg button[data-theme="${t}"]`)?.click(), theme);
    await page.waitForTimeout(150);
    const rows = await page.evaluate((t) => {
      const parse = (s) => {
        const n = (s.match(/[\d.]+/g) || []).map(Number);
        if (/^color\(srgb/.test(s)) return [n[0] * 255, n[1] * 255, n[2] * 255];
        return [n[0], n[1], n[2]];
      };
      const lum = ([r, g, b]) => {
        const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
        return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
      };
      const ratio = (a, b) => {
        const x = lum(a), y = lum(b);
        return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
      };
      const mix = (a, b, u) => a.map((v, i) => v + (b[i] - v) * u);
      const out = [];
      for (const el of document.querySelectorAll("*")) {
        const cs = getComputedStyle(el);
        if (!/gradient/.test(cs.backgroundImage)) continue;
        const r = el.getBoundingClientRect();
        if (r.width < 1 || r.height < 1) continue;
        if (![...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim())) continue;
        const stops = (cs.backgroundImage.match(/rgba?\([^)]+\)|color\(srgb[^)]+\)/g) || []).map(parse);
        if (stops.length < 2) continue;
        const fg = parse(cs.color);
        // 采样整只元素（含边缘）：文字可能不居中，保守一点
        const worst = Math.min(...[0, 0.25, 0.5, 0.75, 1].map((u) => {
          const i = Math.min(stops.length - 2, Math.floor(u * (stops.length - 1)));
          const local = (u * (stops.length - 1)) - i;
          return ratio(fg, mix(stops[i], stops[i + 1], local));
        }));
        const size = parseFloat(cs.fontSize), wt = Number(cs.fontWeight) || 400;
        const large = size >= 18 || (size >= 14 && wt >= 700);
        out.push({ theme: t, txt: (el.textContent || "").trim().slice(0, 6),
                   worst: +worst.toFixed(2), need: large ? 3 : 4.5 });
      }
      return out;
    }, theme);
    for (const r of rows) if (r.worst < r.need) bad.push(r);
  }
  report("P 渐变背景上的文字同样过 AA（按色标插值，不跳过）",
    bad.length === 0 && page.__errors.length === 0,
    JSON.stringify({ bad, errs: page.__errors }));
  await page.close();
}

// Q 滚动内容不得从脚栏底下经过。v1.33.0 用 position:sticky 钉住脚栏，等于在
// 半透明面板上再叠一层半透明条——木色主题下能直接读出条底下滚过的「导入」。
// 提高不透明度只是遮住症状；v1.34 改成结构保证：滚动区到脚栏为止，脚栏是它的
// 兄弟节点。
//
// 判据只能是几何边界，不能是「矩形相交」：被 overflow 裁掉的元素，
// getBoundingClientRect() 照样返回未裁剪的矩形，扫描相交必然误报（这个坑在
// v1.29 和 v1.32 的审计里各踩过一次）。真正的不变式是滚动区的下边缘不越过
// 脚栏的上边缘 —— 越不过去，就没有任何东西能被画到脚栏底下。
{
  const bad = [];
  for (const [w, h] of [[1280, 600], [1280, 720], [1366, 768], [1440, 900]]) {
    const page = await newPage();
    await page.setViewportSize({ width: w, height: h });
    await page.keyboard.press("]");
    await page.waitForTimeout(350);
    const r = await page.evaluate(() => {
      const sc = document.querySelector(".side-scroll");
      const foot = document.querySelector(".side-foot");
      if (!sc || !foot) return { missing: true };
      let worstGap = Infinity;
      for (const t of [0, 0.5, 1]) {
        sc.scrollTop = Math.round((sc.scrollHeight - sc.clientHeight) * t);
        worstGap = Math.min(worstGap,
          foot.getBoundingClientRect().top - sc.getBoundingClientRect().bottom);
      }
      sc.scrollTop = sc.scrollHeight;
      const rows = [...sc.querySelectorAll(".setting-row")].filter((e) => e.getBoundingClientRect().height > 0);
      const lb = rows[rows.length - 1].getBoundingClientRect();
      const scb = sc.getBoundingClientRect();
      return {
        worstGap: Math.round(worstGap),
        // 最后一行滚到底后必须真正落在滚动区的可视范围内
        lastVisible: lb.bottom <= scb.bottom + 0.5 && lb.top >= scb.top - 0.5,
        bg: getComputedStyle(foot).backgroundColor,
        scrolls: sc.scrollHeight - sc.clientHeight,
      };
    });
    const tag = w + "x" + h;
    if (r.missing) bad.push(tag + ":缺少 .side-scroll/.side-foot");
    else {
      if (r.worstGap < -0.5) bad.push(tag + ":滚动区越过脚栏 " + (-r.worstGap) + "px");
      if (!r.lastVisible) bad.push(tag + ":滚到底后最后一行仍不可见");
      if (r.bg !== "rgba(0, 0, 0, 0)") bad.push(tag + ":脚栏有自己的背景 " + r.bg);
    }
    if (page.__errors.length) bad.push(tag + ":errs " + page.__errors.join("|"));
    await page.close();
  }
  report("Q 滚动区止于脚栏，且脚栏没有自己的背景（结构保证，非遮挡）",
    bad.length === 0, JSON.stringify({ bad }));
}

// R 棋盘必须始终按 1:dpr 渲染，且格距落在整设备像素上。
// 两个都是 v1.35 修掉的清晰度缺陷：
//  · #board-wrap 的 width/height 有 .28s 过渡，画布是它的 100%，所以尺寸是逐帧
//    到位的。window 的 resize 处理器只采样了第 0 帧就再没复测，于是任何一次窗口
//    缩放之后位图都停在旧尺寸（实测 828px 的框里放着 1576px 的位图 = 1.90×
//    重采样），整盘的线与棋子全被磨软，直到有人碰一下侧栏才自愈。
//  · pad = w×0.045 = 70.92、step = 102.44 都是小数，30 条线全部落在半像素上。
{
  const bad = [];
  const page = await newPage();
  const probe = () => page.evaluate(() => {
    const cv = document.getElementById("board");
    const r = cv.getBoundingClientRect();
    const W = cv.width;
    // 读 draw.js 实际使用的几何，不要在这里重算 —— 重算出来的整数是同义反复，
    // 反证时怎么改 draw.js 都会通过。
    const g = window.GobanDraw.geometry();
    return {
      ratio: +(W / r.width).toFixed(3),
      dpr: Math.min(window.devicePixelRatio || 1, 2),
      intPitch: Number.isInteger(g.step) && Number.isInteger(g.pad),
      pitch: g.step, origin: g.pad,
      css: Math.round(r.width), bmp: W,
    };
  });
  const steps = [
    ["初始", null],
    ["关侧栏", "["],
    ["开侧栏", "]"],
  ];
  for (const [label, key] of steps) {
    if (key) { await page.keyboard.press(key); }
    await page.waitForTimeout(650);
    const r = await probe();
    if (Math.abs(r.ratio - r.dpr) > 0.005) bad.push(label + ":比值 " + r.ratio + " ≠ dpr " + r.dpr + " (" + r.bmp + "/" + r.css + ")");
    if (!r.intPitch) bad.push(label + ":格距非整数 step=" + r.pitch + " pad=" + r.origin);
  }
  for (const [w, h] of [[1320, 900], [760, 760], [1000, 820]]) {
    await page.setViewportSize({ width: w, height: h });
    await page.waitForTimeout(700);
    const r = await probe();
    const tag = w + "x" + h;
    if (Math.abs(r.ratio - r.dpr) > 0.005) bad.push(tag + ":比值 " + r.ratio + " ≠ dpr " + r.dpr + " (" + r.bmp + "/" + r.css + ")");
    if (!r.intPitch) bad.push(tag + ":格距非整数 step=" + r.pitch + " pad=" + r.origin);
  }
  if (page.__errors.length) bad.push("errs " + page.__errors.join("|"));
  report("R 棋盘位图恒为 1:dpr，且格距为整数设备像素",
    bad.length === 0, JSON.stringify({ bad }));
  await page.close();
}

// S 落子预览必须和真正落下的棋子同大小、同色系。
// v1.35 把棋子半径从 0.43 提到 0.46，但预览、推演两处各自留着 0.40，缺口从 0.03
// 拉到 0.06 —— 预览比它预览的那颗子小 13%，小到网格线从它身上跑出来。更糟的是
// 它靠 alpha 变淡：黑子 0.38 叠在木色棋盘上合成 rgb(122,99,73)，一块橄榄棕色的
// 斑，既不是黑也不是白，看不出将要落的是哪一色。现在预览是同一颗棋子按 42% 拉向
// 中性灰、不透明画出，不投影 —— 所以这条闸门量三件事：半径、色相中性、和棋盘分离。
{
  const bad = [];
  for (const theme of ["wood", "night", "day"]) {
    const page = await newPage();
    await page.evaluate((t) => {
      const b = document.querySelector('[data-theme="' + t + '"]');
      if (!b) throw new Error("no theme button " + t);
      b.click();
    }, theme);
    await page.waitForTimeout(300);
    const geo = await page.evaluate(() => {
      const c = document.getElementById("board");
      const r = c.getBoundingClientRect();
      return { rect: { x: r.x, y: r.y, w: r.width }, g: window.GobanDraw.geometry(),
               stoneR: window.GobanDraw.STONE_R };
    });
    const { pad, step, w } = geo.g;
    const scale = geo.rect.w / w;
    // 悬停在 (5,5)：空点，离星位和边框都远
    await page.mouse.move(geo.rect.x + (pad + 5 * step) * scale,
                          geo.rect.y + (pad + 5 * step) * scale);
    await page.waitForTimeout(250);
    const r = await page.evaluate(({ pad, step }) => {
      const g = document.getElementById("board").getContext("2d");
      const cx = Math.round(pad + 5 * step), cy = Math.round(pad + 5 * step);
      const n = Math.round(step * 0.75);
      const d = g.getImageData(cx - n, cy - n, 2 * n + 1, 2 * n + 1).data;
      const at = (dx, dy) => ((n + dy) * (2 * n + 1) + (n + dx)) * 4;
      const lum = (i) => 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
      // 沿中心行向右走，最大亮度跃变处即预览的轮廓
      let best = 0, edge = 0;
      for (let x = 2; x <= n; x++) {
        const dl = Math.abs(lum(at(x, 0)) - lum(at(x - 1, 0)));
        if (dl > best) { best = dl; edge = x; }
      }
      const c0 = at(0, 0);
      // 网格线是否还从预览里透出来：同一行上，压线的采样点 vs 两侧等距采样点。
      // 棋子自己的径向渐变沿这条行单调变化，所以线漏出来的表现是中间那点比两侧
      // 的平均值更暗；不受渐变影响。
      const yOff = -Math.round(step * 0.2), dx = Math.round(step * 0.14);
      const bleed = Math.max(0,
        (lum(at(-dx, yOff)) + lum(at(dx, yOff))) / 2 - lum(at(0, yOff)));
      return {
        edge, edgeDelta: +best.toFixed(1), bleed: +bleed.toFixed(1),
        rgb: [d[c0], d[c0 + 1], d[c0 + 2]],
        centre: +lum(c0).toFixed(1),
        // 取样必须走对角线。从交叉点垂直或水平走出去，走的是网格线本身 —— 量到的
        // 「棋盘」其实是线色（木 rgb(61,41,20)、日 rgb(107,83,68)），差了一百多级。
        board: +lum(at(Math.round(step * 0.72), -Math.round(step * 0.72))).toFixed(1),
      };
    }, { pad, step });
    // 轮廓找的是最大梯度像素，抗锯齿会让它落在真边内 1–2 个像素，所以余量按像素
    // 给（2.5px），不按比例 —— 比例余量在小棋盘上会松到放过 0.40 那次倒退。
    const want = geo.stoneR * step;
    if (Math.abs(r.edge - want) > 2.5) {
      bad.push(theme + ":预览半径 " + r.edge + "px ≠ STONE_R×step " + want.toFixed(1) +
               "（" + (r.edge / step).toFixed(3) + "×step）");
    }
    const [R, G, B] = r.rgb;
    if (Math.max(R, G, B) - Math.min(R, G, B) > 14) {
      bad.push(theme + ":预览带色相 rgb(" + R + "," + G + "," + B + ") 极差 " + (Math.max(R, G, B) - Math.min(R, G, B)));
    }
    if (Math.abs(r.centre - r.board) < 25) {
      bad.push(theme + ":预览与棋盘几乎同亮 " + r.centre + " vs " + r.board);
    }
    if (r.bleed > 8) bad.push(theme + ":网格线仍从预览里透出 Δ" + r.bleed);
    if (page.__errors.length) bad.push(theme + ":errs " + page.__errors.join("|"));
    await page.close();
  }
  report("S 落子预览与真棋子同径、无色偏、盖住网格",
    bad.length === 0, JSON.stringify({ bad }));
}

// T 侧栏那行元信息不能把分隔点甩成孤行。
// 原来是 4 段文字 + 3 个 <span class="sep"> 共 7 个平级 flex 子元素。243px 放不下
// 一行，flex-wrap 就在它必须断的地方断 —— 实测中英两版都是三个点一起换到第 2 行，
// 「· · ·」孤零零挂在中间。现在分隔点是后一项的 ::before，根本不是元素，排版层面
// 就不可能被甩出去；并且这一行只剩两个子元素：对局状态，和存档状态。
{
  const bad = [];
  for (const lang of ["zh", "en"]) {
    const page = await newPage();
    if (lang === "en") {
      await page.evaluate(() => document.querySelector('button[data-lang="en"]').click());
      await page.waitForTimeout(400);
    }
    // newPage() 把 storageSet 换成了空函数（防止卸载时的自动存档把 clear 撤销），
    // 那样存档提示会显示「存档失败」。这里换回真货，测的才是它最长的那个形态。
    await page.evaluate(() => {
      window.GobanHost.storageSet = function (k, v) {
        try { localStorage.setItem(k, v); return true; } catch (_) { return false; }
      };
    });
    // 先落一子，让存档提示带上时间戳（它最长的形态）
    await page.evaluate(() => {
      const c = document.getElementById("board"); const b = c.getBoundingClientRect();
      const g = window.GobanDraw.geometry(); const sc = b.width / g.w;
      c.dispatchEvent(new MouseEvent("click", { bubbles: true,
        clientX: b.x + (g.pad + 7 * g.step) * sc, clientY: b.y + (g.pad + 7 * g.step) * sc }));
    });
    await page.waitForTimeout(1400);
    const r = await page.evaluate(() => {
      const m = document.querySelector(".side-meta");
      const mb = m.getBoundingClientRect();
      const kids = [...m.querySelectorAll(":scope > .meta-stats > *, :scope > :not(.meta-stats)")];
      const rows = {};
      for (const k of kids) {
        const b = k.getBoundingClientRect();
        const key = Math.round(b.top);
        (rows[key] = rows[key] || []).push((k.textContent || "").trim());
      }
      return {
        sepEls: m.querySelectorAll(".sep").length,
        rows: Object.keys(rows).sort((a, b) => a - b).map((k) => rows[k]),
        over: +(Math.max(...kids.map((k) => k.getBoundingClientRect().right)) - mb.right).toFixed(1),
        hint: (document.getElementById("save-hint").textContent || "").trim(),
      };
    });
    if (r.sepEls) bad.push(lang + ":分隔点又成了元素 ×" + r.sepEls);
    const empty = r.rows.filter((row) => row.every((t) => t === ""));
    if (empty.length) bad.push(lang + ":有 " + empty.length + " 行只剩分隔点");
    if (r.over > 0.5) bad.push(lang + ":内容溢出 " + r.over + "px");
    if (!/\d/.test(r.hint)) bad.push(lang + ":存档提示没带时间戳 " + JSON.stringify(r.hint));
    if (page.__errors.length) bad.push(lang + ":errs " + page.__errors.join("|"));
    await page.close();
  }
  report("T 侧栏元信息行不会把分隔点甩成孤行，也不溢出",
    bad.length === 0, JSON.stringify({ bad }));
}

// U 侧栏滚动区的边缘要淡出，而且只在那一侧真有内容时淡出。
// 没有淡出时，滚动区就是一条硬横线，把正好落在边界上的那一行拦腰切断 —— 默认窗口下
// 被切的是「复制 / 导出 / 导入」，四个主题里都是从字的中间切过去。反过来，已经滚到底
// 了还继续压暗最后一行，那才是拿装饰盖住问题。所以两头都要断言。
{
  const bad = [];
  const page = await newPage();
  // 落几手，让棋谱区长出内容，滚动区确实溢出
  const click = clicker(page);
  for (const [r, c] of [[7, 7], [6, 8], [8, 6]]) { await click(r, c); await page.waitForTimeout(1300); }
  const read = () => page.evaluate(() => {
    const el = document.getElementById("side-scroll");
    const mask = getComputedStyle(el).maskImage || getComputedStyle(el).webkitMaskImage;
    // 末两个色标：… #000 <bottomStop>, transparent 100%
    const m = /rgb\(0, 0, 0\)\s+(calc\(100% - (\d+)px\)|100%)/.exec(mask);
    const top = /rgb\(0, 0, 0\)\s+(\d+)px/.exec(mask);
    return {
      above: el.dataset.above, below: el.dataset.below,
      scrollable: el.scrollHeight - el.clientHeight,
      scrollTop: Math.round(el.scrollTop),
      fadeBot: m ? (m[2] ? +m[2] : 0) : null,
      fadeTop: top ? +top[1] : null,
      hasMask: mask !== "none",
    };
  });
  const top0 = await read();
  if (!top0.hasMask) bad.push("顶部:没有遮罩");
  if (top0.scrollable <= 1) bad.push("滚动区没有溢出，这条闸门测不到东西（溢出 " + top0.scrollable + "px）");
  if (top0.below !== "1" || !top0.fadeBot) bad.push("顶部:下方有内容却没淡出 " + JSON.stringify(top0));
  if (top0.above !== "0" || top0.fadeTop) bad.push("顶部:上方没内容却淡出了 " + JSON.stringify(top0));

  await page.evaluate(() => {
    const el = document.getElementById("side-scroll");
    el.scrollTop = el.scrollHeight;
  });
  await page.waitForTimeout(250);
  const bot = await read();
  if (bot.scrollTop === 0) bad.push("底部:没滚动成功");
  if (bot.below !== "0" || bot.fadeBot) bad.push("底部:已到底还在压暗最后一行 " + JSON.stringify(bot));
  if (bot.above !== "1" || !bot.fadeTop) bad.push("底部:上方有内容却没淡出 " + JSON.stringify(bot));
  if (page.__errors.length) bad.push("errs " + page.__errors.join("|"));
  report("U 侧栏滚动区两端按需淡出（到底就不再压暗）",
    bad.length === 0, JSON.stringify({ bad }));
  await page.close();
}

// V 去掉 color-mix 之后，界面必须还在。
// 这套回归跑在 Chromium，而应用跑 WKWebView / WebView2，且发出去的 Info.plist 写着
// LSMinimumSystemVersion 11.0（SDK 打包器写死，app.zon 改不了）。样式表用了 37 处
// color-mix，老 WebKit 不认这个函数时整条声明作废。在 v1.37 的样式表上模拟这一点：
// 侧栏、toast、swap2 条、badge、主题选中态五处背景直接算成 rgba(0,0,0,0)，开关的
// 「开」退回「关」的颜色，棋谱行退回按钮的 UA 黑字压在近黑面板上。单测那两道闸门
// 守的是源码形态，这一道守的是渲染结果。
{
  const bad = [];
  NOMIX = true;
  try {
    const page = await newPage();
    const click = clicker(page);
    await click(7, 7);
    await page.waitForTimeout(1400);
    const r = await page.evaluate(() => {
      const opaque = (c) => !/rgba\(0, 0, 0, 0\)|transparent/.test(c);
      const lum = (c) => {
        const m = c.match(/[\d.]+/g);
        return m ? 0.2126 * +m[0] + 0.7152 * +m[1] + 0.0722 * +m[2] : null;
      };
      const out = { surfaces: [], text: [] };
      for (const [sel, label] of [[".side", "侧栏"], [".toast", "toast"],
                                  [".swap2-bar", "swap2 条"], [".badge", "badge"],
                                  [".theme-row button.active", "主题选中态"],
                                  ['.switch[aria-pressed="true"]', "开关开启态"]]) {
        const el = document.querySelector(sel);
        if (!el) { out.surfaces.push([label, "缺元素"]); continue; }
        out.surfaces.push([label, getComputedStyle(el).backgroundColor,
                           opaque(getComputedStyle(el).backgroundColor)]);
      }
      // 文字必须仍然读得出来：拿它和所在面板的亮度差说话
      const panel = lum(getComputedStyle(document.querySelector(".side")).backgroundColor);
      for (const [sel, label] of [[".move-list button", "棋谱行"]]) {
        const el = document.querySelector(sel);
        if (!el) { out.text.push([label, "缺元素"]); continue; }
        const c = getComputedStyle(el).color;
        out.text.push([label, c, Math.abs(lum(c) - panel)]);
      }
      return out;
    });
    for (const [label, val, ok] of r.surfaces) {
      if (ok !== true) bad.push(label + " 背景 " + val);
    }
    for (const [label, val, sep] of r.text) {
      if (!(sep > 30)) bad.push(label + " 文字 " + val + " 与面板亮度差仅 " + sep);
    }
    if (page.__errors.length) bad.push("errs " + page.__errors.join("|"));
    await page.close();
  } finally {
    NOMIX = false;
  }
  report("V 引擎不支持 color-mix 时界面不塌（表面不透明、文字仍可读）",
    bad.length === 0, JSON.stringify({ bad }));
}

// W 布局要有余量，不能刚好放得下。
// 这套回归在容器里渲染中文用的是 WenQuanYi Zen Hei —— macOS 装的是苹方、Windows
// 装的是微软雅黑，两个平台都没有这个字体。所以「在 100% 下正好放得下」证明不了
// 发布版应用放得下。把字号推到 125% 再断言同样的性质，才是能跨字体成立的那条。
{
  const bad = [];
  for (const scale of [1.0, 1.25]) {
    for (const lang of ["zh", "en"]) {
      const page = await newPage();
      if (lang === "en") {
        await page.evaluate(() => document.querySelector('button[data-lang="en"]').click());
        await page.waitForTimeout(350);
      }
      if (scale !== 1) {
        await page.addStyleTag({ content:
          `body,.side,.modal,.chrome{font-size:${Math.round(14 * scale)}px}` +
          `.side-meta,.setting-row,.tool-btn,.text-link,.pill button{font-size:${Math.round(12 * scale)}px}` });
      }
      await page.waitForTimeout(350);
      const r = await page.evaluate(() => {
        const H = innerHeight, W = innerWidth;
        const foot = [...document.querySelectorAll(".side-foot .text-link")];
        const out = foot.filter((e) => {
          const b = e.getBoundingClientRect();
          return !(b.width > 0 && b.height > 0 && b.top >= 0 && b.bottom <= H + 0.5 &&
                   b.left >= 0 && b.right <= W + 0.5);
        }).map((e) => e.textContent.trim());
        const m = document.querySelector(".side-meta");
        const mb = m.getBoundingClientRect();
        const kids = [...m.querySelectorAll(":scope > .meta-stats > *, :scope > :not(.meta-stats)")];
        const rows = {};
        for (const k of kids) {
          const b = k.getBoundingClientRect();
          (rows[Math.round(b.top)] = rows[Math.round(b.top)] || []).push((k.textContent || "").trim());
        }
        return {
          footOut: out,
          metaOver: +(Math.max(...kids.map((k) => k.getBoundingClientRect().right)) - mb.right).toFixed(1),
          dotOnly: Object.values(rows).filter((v) => v.every((t) => t === "")).length,
        };
      });
      const tag = Math.round(scale * 100) + "%" + lang;
      if (r.footOut.length) bad.push(tag + ":脚栏出视口 " + r.footOut.join(","));
      if (r.metaOver > 0.5) bad.push(tag + ":元信息溢出 " + r.metaOver + "px");
      if (r.dotOnly) bad.push(tag + ":有 " + r.dotOnly + " 行只剩分隔点");
      if (page.__errors.length) bad.push(tag + ":errs " + page.__errors.join("|"));
      await page.close();
    }
  }
  report("W 文字放大到 125% 布局仍不塌（跨字体的那条性质）",
    bad.length === 0, JSON.stringify({ bad }));
}

// X 记住这套回归到底在拿什么字体量。
// 容器换一次基础镜像，全仓库的文字像素数字就会集体平移，而没有任何东西会出声。
// 这一条把它钉住：字体变了就报红，逼人重新量而不是继续引用旧数字。
{
  const bad = [];
  const page = await newPage();
  const cdp = await ctx.newCDPSession(page);
  await cdp.send("DOM.enable");
  await cdp.send("CSS.enable");
  const { root } = await cdp.send("DOM.getDocument");
  const { nodeId } = await cdp.send("DOM.querySelector", { nodeId: root.nodeId, selector: ".brand" });
  const { fonts } = await cdp.send("CSS.getPlatformFontsForNode", { nodeId });
  const used = fonts.map((f) => f.familyName).sort();
  // 已知的量测字体。换了就必须改这里，顺便重新审一遍受影响的数字。
  const KNOWN = ["WenQuanYi Zen Hei"];
  if (used.join(",") !== KNOWN.join(",")) {
    bad.push("量测字体变了：" + JSON.stringify(used) + " ≠ " + JSON.stringify(KNOWN));
  }
  await page.close();
  report("X 量测字体仍是已记录的那一个（换了就重新量）",
    bad.length === 0, JSON.stringify({ used, bad }));
}

// Y 练习/每日的棋盘必须和主棋盘同一个画家。
// 它此前自带一份 drawBoard():pad = w*0.04 / step = (w-2pad)/14 得出 13.44 与 22.08
// 两个小数(30 条线全在半像素上,正是 v1.35 在主棋盘修掉的缺陷)、半径 0.42(全应用
// 第四个各写各的值)、纯色圆片无渐变阴影与自适应边缘、没有星位也没有盘面,而且不封
// dpr 上限。于是 v1.35–v1.37 的每一次改进都停在弹层边缘,而 练习 + 每日 是一整个模式。
{
  const bad = [];
  for (const theme of ["wood", "night", "day"]) {
    const page = await newPage();
    await page.evaluate((t) => document.querySelector('[data-theme="' + t + '"]').click(), theme);
    await page.waitForTimeout(250);
    await page.evaluate(() => document.getElementById("open-practice").click());
    await page.waitForTimeout(700);
    const r = await page.evaluate(() => {
      const cv = document.getElementById("practice-board");
      const D = window.GobanDraw;
      const p = D.pitchFor(cv.width);
      const g = cv.getContext("2d");
      // 盘面中央偏上的一格中心 —— 避开交叉点(网格线)也避开棋子密集区
      const px = (x, y) => { const d = g.getImageData(x, y, 1, 1).data; return [d[0], d[1], d[2], d[3]]; };
      const probe = px(Math.round(p.pad + 1.5 * p.step), Math.round(p.pad + 1.5 * p.step));
      // 格距不能拿 pitchFor 重算来断言 —— 那是同义反复,practice.js 怎么写它都返回
      // 整数(闸门 R 第一版栽过一模一样的坑)。要量的是渲染结果:共享规则说竖线在
      // x = pad + k*step,那里就必须真有一条线,而两侧 4px 处必须没有。
      const lum = (c) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
      const y = Math.round(p.pad + 1.5 * p.step);      // 两条横线之间,避开交叉点
      const lx = Math.round(p.pad + 3 * p.step);
      const onLine = lum(px(lx, y));
      const offL = lum(px(lx - 4, y)), offR = lum(px(lx + 4, y));
      return {
        bmp: cv.width, box: cv.clientWidth,
        ratio: +(cv.width / cv.clientWidth).toFixed(4),
        want: Math.min(window.devicePixelRatio || 1, 2),
        lineDelta: +Math.abs(onLine - (offL + offR) / 2).toFixed(1),
        sideSpread: +Math.abs(offL - offR).toFixed(1),
        step: p.step, pad: p.pad, r: D.STONE_R, boardPx: probe,
      };
    });
    const tag = theme;
    // 线在共享规则说的位置上,且两侧是干净盘面(否则说明它按自己那套小数格距在画)
    if (!(r.lineDelta > 12)) bad.push(tag + ":共享格距处没有网格线 Δ" + r.lineDelta);
    if (r.sideSpread > 10) bad.push(tag + ":线两侧不对称 Δ" + r.sideSpread + "（线不在该在的地方）");
    if (Math.abs(r.ratio - r.want) > 0.005) bad.push(tag + ":位图比 " + r.ratio + " ≠ " + r.want);
    if (r.r !== 0.46) bad.push(tag + ":STONE_R 变了 " + r.r);
    // 画布必须真的画满一块盘 —— 透明就说明它又变回了「面板上的几个圆片」
    if (r.boardPx[3] < 250) bad.push(tag + ":盘面没画满 alpha=" + r.boardPx[3]);
    if (page.__errors.length) bad.push(tag + ":errs " + page.__errors.join("|"));
    await page.close();
  }
  report("Y 练习棋盘与主棋盘同一画家（整数格距 / dpr 封顶 / 有盘面）",
    bad.length === 0, JSON.stringify({ bad }));
}

// Z 弹层里「关闭」不该比它旁边的破坏性动作更重。
// 六个弹层中只有统计把「关闭」提成主按钮,而它旁边的「清空」是不可逆地删掉全部
// 对局统计,却用普通按钮 —— 分量正好装反。空态时它还照样可点,会弹确认框问你要不要
// 清空一个空的东西。
{
  const bad = [];
  const page = await newPage();
  const opens = { slots: "sgf-slots", review: "sgf-review", practice: "open-practice", stats: "open-stats" };
  for (const [name, id] of Object.entries(opens)) {
    await page.evaluate((i) => document.getElementById(i).click(), id);
    await page.waitForTimeout(400);
    const r = await page.evaluate(() => {
      const m = [...document.querySelectorAll(".modal-bg")].find((e) => e.classList.contains("show"));
      if (!m) return null;
      const box = m.querySelector(".modal");
      const btns = [...box.querySelectorAll("button")].filter((b) => b.offsetParent !== null);
      return btns.map((b) => ({ txt: (b.textContent || "").trim(), cls: b.className, dis: b.disabled }));
    });
    if (!r) { bad.push(name + ":没打开"); continue; }
    for (const b of r) {
      if (/关闭|Close/.test(b.txt) && /\bprimary\b/.test(b.cls)) {
        bad.push(name + ":「" + b.txt + "」是主按钮");
      }
      if (/清空|清除|Clear/.test(b.txt) && !/danger/.test(b.cls)) {
        bad.push(name + ":破坏性动作「" + b.txt + "」没有 danger 标记（" + b.cls + "）");
      }
    }
    if (name === "stats") {
      const c = r.find((b) => /清空|Clear/.test(b.txt));
      if (c && !c.dis) bad.push("stats:零对局时「清空」仍可点");
    }
    await page.keyboard.press("Escape");
    await page.waitForTimeout(250);
  }
  if (page.__errors.length) bad.push("errs " + page.__errors.join("|"));
  await page.close();
  report("Z 弹层的「关闭」不抢主按钮，破坏性动作有 danger 且空态禁用",
    bad.length === 0, JSON.stringify({ bad }));
}

console.log("---");
const allOk = results.every((r) => r.ok);
console.log(allOk ? "CROSS_ALL_OK" : "CROSS_FAIL (" + results.filter((r) => !r.ok).map((r) => r.name).join("; ") + ")");
await browser.close();
server.close();
process.exit(allOk ? 0 : 1);
