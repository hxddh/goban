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

/** Clicks the intersection where the product actually draws it.
 *
 *  This used to carry its own `pad = w * 0.045, step = (w - 2pad)/(S-1)` —
 *  the fractional formula v1.35 replaced with the integer pitch in
 *  `GobanDraw.pitchFor`. It never misclicked (measured: worst 3.08 bitmap px
 *  at w=1576, 3.0% of a cell, well inside cellAt's 0.52·step tolerance), but a
 *  harness that models geometry with a rule the product no longer has drifts
 *  silently the next time that rule moves. Ask the product instead. */
function clicker(page) {
  return (r, c) =>
    page.evaluate(({ r, c }) => {
      const cv = document.getElementById("board");
      const rect = cv.getBoundingClientRect();
      const g = window.GobanDraw.pitchFor(cv.width);
      const scale = rect.width / cv.width;   // #board has no border: rect == content box
      const x = rect.left + (g.pad + c * g.step) * scale;
      const y = rect.top + (g.pad + r * g.step) * scale;
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

/** A page whose Web Audio is a recorder: every scheduled node lands in
 *  `window.__audio` as {node, freq}. Sound is otherwise unobservable from a
 *  browser test — and it was unobserved, which is how 「电脑赢棋时应用奏凯歌」
 *  survived to v1.41. The fake must be installed before the page's scripts
 *  run, so this cannot reuse newPage()'s already-navigated page. */
const AUDIO_RECORDER = `
window.__audio = [];
// setValueAtTime must write .value — a real AudioParam's .value reflects the
// scheduled value. The first version left it a no-op, and every note read 0:
// the gate went red on a correct product because audio.js schedules pitch with
// setValueAtTime rather than assigning .value. Ramps stay no-ops on purpose —
// what we assert is the note a voice *starts* on.
class GParam { constructor(){ this.value = 0; }
  setValueAtTime(v){ this.value = v; return this; }
  exponentialRampToValueAtTime(){ return this; } }
class GNode {
  constructor(kind){ this.kind = kind; this.gain = new GParam();
    this.frequency = new GParam(); this.Q = new GParam(); }
  connect(){ return this; } disconnect(){}
  start(){ window.__audio.push({ node: this.kind, freq: this.frequency.value }); }
  stop(){}
}
window.AudioContext = window.webkitAudioContext = class {
  constructor(){ this.state = 'running'; this.currentTime = 0;
    this.sampleRate = 48000; this.destination = {}; }
  resume(){}
  createBuffer(c, n){ return { getChannelData: () => new Float32Array(n) }; }
  createBufferSource(){ return new GNode('noise'); }
  createBiquadFilter(){ return new GNode('filter'); }
  createGain(){ return new GNode('gain'); }
  createOscillator(){ return new GNode('osc'); }
};
`;

async function newAudioPage() {
  const page = await ctx.newPage();
  page.__errors = [];
  page.on("console", (m) => {
    if (m.type() === "error" && !/Failed to load resource/.test(m.text())) page.__errors.push(m.text());
  });
  page.on("pageerror", (e) => page.__errors.push("PAGEERR " + e.message));
  await page.addInitScript(AUDIO_RECORDER);
  await page.goto(ORIGIN + "/index.html", { waitUntil: "networkidle" });
  await page.evaluate(() => {
    if (window.GobanHost) window.GobanHost.storageSet = function () {};
    localStorage.clear();
  });
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForTimeout(250);
  return page;
}

/** Pitched notes only — the stone clack's noise/body carry no melodic info. */
const notes = (audio) =>
  audio.filter((a) => a.node === "osc" && a.freq > 0).map((a) => Math.round(a.freq * 100) / 100);

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

// ---- Test AA: 一局结束的声音跟着结果走（赢 / 输 / 和 三条各不相同）----
// 到 v1.41 为止这三种情况共用同一段上行大调琶音 —— 电脑赢棋时应用也在庆祝。
// 判定读的是实际排进音频图的频率，不是源码里写了什么。
{
  const bad = [];
  const heard = {};

  // 1) 人赢：黑(人) 已有四子，人点第五子
  {
    const page = await newAudioPage();
    await openPanel(page);
    await page.click('button[data-diff="easy"]').catch(() => {});
    await page.waitForTimeout(100);
    await page.evaluate(() => navigator.clipboard.writeText(
      "(;FF[4]GM[1]SZ[15];B[dh];W[aa];B[eh];W[ac];B[fh];W[ae];B[gh];W[ag])"));
    await page.click("#sgf-paste"); await page.waitForTimeout(350);
    await dismissConfirm(page); await page.waitForTimeout(250);
    await page.evaluate(() => {
      const b = [...document.querySelectorAll("button")].find((x) => /续下|Resume/.test(x.textContent));
      if (b) b.click();
    });
    await page.waitForTimeout(250);
    await page.evaluate(() => { window.__audio.length = 0; });
    await clicker(page)(7, 7);
    await page.waitForTimeout(700);
    const r = await page.evaluate(() => ({
      status: document.getElementById("status").textContent,
      audio: window.__audio,
    }));
    heard.win = { status: r.status, notes: notes(r.audio) };
    if (page.__errors.length) bad.push("win errs " + page.__errors.join("|"));
    await page.close();
  }

  // 2) 电脑赢：白(电脑) 已有四子，点「续下」让它走
  {
    const page = await newAudioPage();
    await openPanel(page);
    await page.click('button[data-diff="easy"]').catch(() => {});
    await page.waitForTimeout(100);
    await page.evaluate(() => navigator.clipboard.writeText(
      "(;FF[4]GM[1]SZ[15];B[aa];W[dh];B[ac];W[eh];B[ae];W[fh];B[ag];W[gh];B[ai])"));
    await page.click("#sgf-paste"); await page.waitForTimeout(350);
    await dismissConfirm(page); await page.waitForTimeout(250);
    await page.evaluate(() => {
      window.__audio.length = 0;                       // 先清空再点：easy 档 30ms，
      const b = [...document.querySelectorAll("button")].find((x) => /续下|Resume/.test(x.textContent));
      if (b) b.click();                                 // 电脑会在下一个 await 之前就落子
    });
    await page.waitForTimeout(2500);
    const r = await page.evaluate(() => ({
      status: document.getElementById("status").textContent,
      audio: window.__audio,
    }));
    heard.loss = { status: r.status, notes: notes(r.audio) };
    if (page.__errors.length) bad.push("loss errs " + page.__errors.join("|"));
    await page.close();
  }

  // 3) 和局：对弈模式下按 (r+2c)%4 着色落满全盘。该着色全盘最长同色连线为 2，
  //    黑 113 / 白 112 恰好能黑先交替落完 —— 和局此前没有任何测试走到过。
  {
    const page = await newAudioPage();
    await openPanel(page);
    await page.click('button[data-mode="pvp"]');
    await page.waitForTimeout(100);
    await dismissConfirm(page);
    await page.waitForTimeout(150);
    const r = await page.evaluate(async () => {
      const cv = document.getElementById("board");
      const g = window.GobanDraw.pitchFor(cv.width);
      const rect = cv.getBoundingClientRect();
      const s = rect.width / cv.width;
      const hit = (r, c) => cv.dispatchEvent(new MouseEvent("click", {
        clientX: rect.left + (g.pad + c * g.step) * s,
        clientY: rect.top + (g.pad + r * g.step) * s, bubbles: true }));
      const B = [], W = [];
      for (let rr = 0; rr < 15; rr++) for (let cc = 0; cc < 15; cc++) {
        ((rr + 2 * cc) % 4 < 2 ? B : W).push([rr, cc]);
      }
      for (let i = 0; i < B.length; i++) {
        hit(B[i][0], B[i][1]);
        if (i === B.length - 2) window.__audio.length = 0;   // 只留最后一手起的声音
        if (W[i]) hit(W[i][0], W[i][1]);
        if (i % 20 === 0) await new Promise((z) => setTimeout(z, 0));
      }
      await new Promise((z) => setTimeout(z, 400));
      return { status: document.getElementById("status").textContent,
               moves: document.getElementById("replay-pos").textContent,
               audio: window.__audio };
    });
    heard.draw = { status: r.status, moves: r.moves, notes: notes(r.audio) };
    if (!/平局|Draw/.test(r.status)) bad.push("没走到和局：" + r.status + " " + r.moves);
    if (page.__errors.length) bad.push("draw errs " + page.__errors.join("|"));
    await page.close();
  }

  const has = (arr, f) => arr.some((x) => Math.abs(x - f) < 0.01);
  // 赢：上行，含最高音 C6
  if (!has(heard.win.notes || [], 1046.5)) bad.push("人赢没听到上行琶音顶音 1046.5");
  // 输：下行，且不许出现赢的顶音
  if (!has(heard.loss.notes || [], 261.63)) bad.push("电脑赢没听到下行落点 261.63");
  if (has(heard.loss.notes || [], 1046.5)) bad.push("电脑赢时仍在奏胜利琶音（听到 1046.5）");
  // 和：既不是赢也不是输。比的是**旋律**——落子声的木体音(黑 250 / 白 340)要先
  // 剔掉，否则三条各自带着不同的落子前缀，字符串一比就都「不同」，反证时和局那
  // 两条查不出来（第一版就是这样，反证只红了两条该红的里的两条）。
  const melody = (a) => (a || []).filter((f) => f !== 250 && f !== 340);
  const j = (a) => JSON.stringify(melody(a));
  if (j(heard.draw.notes) === j(heard.win.notes)) bad.push("和局与赢棋的旋律一样");
  if (j(heard.draw.notes) === j(heard.loss.notes)) bad.push("和局与输棋的旋律一样");
  if (j(heard.win.notes) === j(heard.loss.notes)) bad.push("赢和输的旋律一样");

  report("AA 一局结束的声音跟着结果走（赢/输/和 三条互不相同）",
    bad.length === 0, JSON.stringify({ bad, heard }));
}

// ---- Test AB: 练习 / 每日答题不再静音，且答对答错听得出区别 ----
// v1.41 之前 practice.js 对 GobanAudio 的引用数是 0：主棋盘落一子排 4 个音频
// 节点，练习棋盘排 0 个，而那次点击确实落地（错题本 +1、画布 160 个像素变化）。
{
  const bad = [];
  const page = await newAudioPage();
  await openPanel(page);
  await page.evaluate(() => {
    const b = [...document.querySelectorAll("button")].find((x) => /^练习$|^Practice$/.test(x.textContent.trim()));
    if (b) b.click();
  });
  await page.waitForTimeout(700);
  const r = await page.evaluate(async () => {
    const cv = document.getElementById("practice-board");
    if (!cv) return { err: "没有练习棋盘" };
    const rect = cv.getBoundingClientRect();
    const bs = (rect.width - cv.clientWidth) / 2;
    const scale = cv.clientWidth / cv.width;
    const g = window.GobanDraw.pitchFor(cv.width);
    const hit = (r, c) => cv.dispatchEvent(new MouseEvent("click", {
      clientX: rect.left + bs + (g.pad + c * g.step) * scale,
      clientY: rect.top + bs + (g.pad + r * g.step) * scale, bubbles: true }));
    const wrongBtn = () => (document.body.innerText.match(/错题本 ?\d*/) || [])[0] || "";
    const before = wrongBtn();
    window.__audio.length = 0;
    hit(0, 0);                                  // 角上：任何题型都不会是解
    await new Promise((z) => setTimeout(z, 350));
    const wrongAudio = window.__audio.slice();
    const registered = wrongBtn() !== before;   // 证明这一点确实被判成了答错
    // 答对那一半：practice.js 不把当前题暴露出来，浏览器侧拿不到正确解，所以
    // 「答对听起来不一样」只能在模块层证明 —— 这一条测的是 playAnswer 两个分支
    // 排出的音频图不同，不是应用把 good 传对了。后者由上面那半（答错走到了
    // 下行动机）加源码闸门（practice.js 必须引用 GobanAudio）一起守。
    window.__audio.length = 0;
    window.GobanAudio.playAnswer(true);
    const rightAudio = window.__audio.slice();
    return { wrongAudio, rightAudio, registered };
  });
  if (r.err) bad.push(r.err);
  else {
    if (!r.registered) bad.push("那一点没有被判成答错，这条测的不是答题");
    if (!r.wrongAudio.length) bad.push("练习答题仍然静音（0 个音频节点）");
    const nW = notes(r.wrongAudio), nR = notes(r.rightAudio);
    if (!nW.some((f) => Math.abs(f - 329.63) < 0.01)) {
      bad.push("答错没听到下行动机（329.63）：" + JSON.stringify(nW));
    }
    if (JSON.stringify(nW) === JSON.stringify(nR)) bad.push("答对和答错听起来一样");
  }
  if (page.__errors.length) bad.push("errs " + page.__errors.join("|"));
  await page.close();
  report("AB 练习/每日答题不再静音（答错走到下行动机，答对与答错不同）",
    bad.length === 0, JSON.stringify({ bad }));
}

// ---- Test AC: 运动语言只有一套（按运行时计算值，不是读样式表）----
// 收敛前实测 130 个过渡属性实例跑在 6 种时长上，缓动两条：应用自己的
// cubic-bezier(0.22,1,0.36,1) 用了 63 次，浏览器默认的 ease 用了 67 次 —— 一多半
// 动效根本没在用这个应用的曲线，且 18 个元素在同一条规则里混着用（顶栏按钮的
// background/transform 走自定义曲线而 opacity 走默认；#board-wrap 的 width/height
// 走 .28s 自定义而 background/box-shadow 走 .25s 默认）。两条曲线逐点最大差 37.9
// 个百分点。源码闸门只看得见写法，看不见 var() 代换之后的计算值 —— 这一条兜那个。
{
  const bad = [];
  const page = await newPage();
  const r = await page.evaluate(() => {
    // 顶层逗号切分：cubic-bezier(0.22, 1, 0.36, 1) 里的逗号不算。
    // 第一版拿 String.split(",") 切，把一条曲线切成四段，报出「5 种缓动」。
    const split = (s) => {
      const out = []; let d = 0, cur = "";
      for (const ch of String(s)) {
        if (ch === "(") d++; else if (ch === ")") d--;
        if (ch === "," && d === 0) { out.push(cur.trim()); cur = ""; } else cur += ch;
      }
      if (cur.trim()) out.push(cur.trim());
      return out;
    };
    const durs = {}, eases = {}, byEl = new Map();
    let total = 0;
    for (const el of document.querySelectorAll("body *")) {
      const cs = getComputedStyle(el);
      const props = split(cs.transitionProperty || "");
      const ds = split(cs.transitionDuration || "");
      const fns = split(cs.transitionTimingFunction || "");
      for (let i = 0; i < props.length; i++) {
        const d = ds[i % ds.length], f = fns[i % fns.length];
        if (!d || d === "0s") continue;
        total++; durs[d] = (durs[d] || 0) + 1; eases[f] = (eases[f] || 0) + 1;
        const key = el.id ? "#" + el.id : "." + String(el.className).split(" ")[0];
        if (!byEl.has(key)) byEl.set(key, new Set());
        byEl.get(key).add(f);
      }
    }
    const mixed = [...byEl.entries()].filter(([, v]) => v.size > 1).map(([k]) => k);
    // 两个思考指示器同时在屏上（显示条件都是 aiThinking && result === "play"），
    // 周期不同就永远错拍：1.2s 与 1.1s 的最小公倍数是 13.2 秒。
    const pill = document.getElementById("status"), dot = document.getElementById("think-dot");
    pill.classList.add("thinking"); dot.hidden = false;
    const pulse = {
      pill: { d: getComputedStyle(pill).animationDuration, f: getComputedStyle(pill).animationTimingFunction },
      dot: { d: getComputedStyle(dot).animationDuration, f: getComputedStyle(dot).animationTimingFunction },
    };
    pill.classList.remove("thinking"); dot.hidden = true;
    return { total, durs, eases, mixed, pulse };
  });
  const easeKeys = Object.keys(r.eases);
  const durKeys = Object.keys(r.durs);
  if (r.total < 50) bad.push("只采到 " + r.total + " 个过渡实例，探针没测到东西");
  if (easeKeys.length !== 1) bad.push("过渡缓动不止一条：" + JSON.stringify(r.eases));
  else if (!/cubic-bezier\(0\.22, 1, 0\.36, 1\)/.test(easeKeys[0])) {
    bad.push("过渡缓动不是 --ease：" + easeKeys[0]);
  }
  if (durKeys.length > 3) bad.push("过渡时长超过三档：" + JSON.stringify(r.durs));
  if (r.mixed.length) bad.push("同一元素混用多条曲线：" + r.mixed.slice(0, 4).join(", "));
  if (r.pulse.pill.d !== r.pulse.dot.d) {
    bad.push("两个思考脉动周期不同：" + r.pulse.pill.d + " vs " + r.pulse.dot.d);
  }
  if (r.pulse.pill.f !== r.pulse.dot.f) {
    bad.push("两个思考脉动曲线不同：" + r.pulse.pill.f + " vs " + r.pulse.dot.f);
  }
  if (page.__errors.length) bad.push("errs " + page.__errors.join("|"));
  await page.close();
  report("AC 运动语言只有一套（过渡一条曲线 · 三档时长 · 脉动同周期）",
    bad.length === 0,
    JSON.stringify({ bad, 实例: r.total, 时长: r.durs, 缓动: r.eases, 脉动: r.pulse }));
}

// ---- Test AD: 设置行的控件边缘，中英各只有一条 ----
// 改之前控件右对齐、自然宽度：右边缘齐在一列，**左边缘中英各六个位置**（v1.44 实测，
// 相对行左缘：中文 77/93/126/141/148/157，英文 46/57/96/122/144/148）。人眼扫的是左缘。
// v1.34 量过并留在路线图；这一版的解是把行拆成「标签列 + 控件列」，控件列宽是个
// token（`--ctl-w`），分段控件占满它 —— 宽度与文案长度无关，所以换语言、加选项都不会
// 让它重新参差。开关是固定尺寸，停在控件列的右端。
// 这条闸门真正守的是**跨语言同宽**：同宽才证明宽度由 token 定。反证拿掉那个 token
// （`1fr var(--ctl-w)` → `1fr auto`），立刻报出中文 5 个 / 英文 6 个左边缘。
// 试过「标签在上、控件在下」：对齐同样干净，但侧栏内容 740 → 869px，900 高的窗口
// 设置区会从「不用滚」变成「要滚」——那是退化，没做。
{
  const bad = [];
  const seen = {};
  const page = await newPage();
  await openPanel(page);
  for (const lang of ["zh", "en"]) {
    if (lang === "en") {
      await page.evaluate(() => {
        const b = [...document.querySelectorAll("button")].find((x) => /^EN$/.test(x.textContent.trim()));
        if (b) b.click();
      });
      await page.waitForTimeout(450);
    }
    const r = await page.evaluate(() => {
      const rows = [...document.querySelectorAll(".setting-row")]
        .filter((x) => x.getBoundingClientRect().width > 0);
      const pills = [], switches = [], wrapped = [];
      for (const row of rows) {
        const k = row.querySelector(".setting-k");
        if (k) {
          const lh = parseFloat(getComputedStyle(k).lineHeight) || 18;
          if (k.getBoundingClientRect().height > lh * 1.6) wrapped.push(k.textContent.trim());
        }
        const p = row.querySelector(".pill");
        if (p) { const b = p.getBoundingClientRect(); pills.push([Math.round(b.left), Math.round(b.right)]); }
        const s = row.querySelector(".switch");
        if (s) { const b = s.getBoundingClientRect(); switches.push([Math.round(b.left), Math.round(b.right)]); }
      }
      const rowW = rows.length ? Math.round(rows[0].getBoundingClientRect().width) : 0;
      return { pills, switches, wrapped, rowW, n: rows.length };
    });
    const lefts = [...new Set(r.pills.map((p) => p[0]))];
    const rights = [...new Set(r.pills.map((p) => p[1]))];
    const swLefts = [...new Set(r.switches.map((s) => s[0]))];
    seen[lang] = { 行数: r.n, 行宽: r.rowW, 分段控件左: lefts, 分段控件右: rights, 开关左: swLefts, 折行的标签: r.wrapped };
    if (!r.pills.length) bad.push(lang + ": 一个分段控件都没量到");
    if (lefts.length !== 1) bad.push(lang + ": 分段控件左边缘有 " + lefts.length + " 个位置 " + JSON.stringify(lefts));
    if (rights.length !== 1) bad.push(lang + ": 分段控件右边缘有 " + rights.length + " 个位置 " + JSON.stringify(rights));
    if (swLefts.length > 1) bad.push(lang + ": 开关左边缘有 " + swLefts.length + " 个位置");
    if (r.wrapped.length) bad.push(lang + ": 标签折了行 " + JSON.stringify(r.wrapped));
    const w = lefts.length === 1 && rights.length === 1 ? rights[0] - lefts[0] : 0;
    seen[lang].分段控件宽 = w;
    if (w > r.rowW) bad.push(lang + ": 分段控件宽 " + w + " 超出行宽 " + r.rowW);
  }
  // 宽度跨语言相同,才说明它由 token 定、不由文案长度定 —— 这是这条闸门真正要守的
  // 不变式。改之前控件是右对齐的自然宽度,中英各有 7 个左边缘,且随文案变。
  if (seen.zh && seen.en && seen.zh.分段控件宽 !== seen.en.分段控件宽) {
    bad.push("控件宽度随语言变了：中文 " + seen.zh.分段控件宽 + " / 英文 " + seen.en.分段控件宽);
  }
  if (page.__errors.length) bad.push("errs " + page.__errors.join("|"));
  await page.close();
  report("AD 设置行的控件边缘中英各只有一条（且不由文案长度决定）",
    bad.length === 0, JSON.stringify({ bad, seen }));
}

// ---- Test AE: 焦点由应用自己画，不落回引擎默认 ----
// 改之前整张样式表唯一一条 focus 规则是 .slot-name:focus —— 按钮、分段控件、开关、
// 文字链聚焦时长什么样，完全由引擎默认值决定。v1.32 花一整版把 Tab 可达做起来
// （侧栏 0 → 26 项、主界面 38 个按钮），却没定义过「走到哪里」看不看得出来。
// 这个应用跑 WKWebView / WebView2 而回归跑 Chromium，靠默认值撑住要紧的东西正是
// v1.38 修掉的那类依赖 —— 所以这里断言的是「应用自己声明了」，与默认值长什么样无关。
{
  const bad = [];
  const page = await newPage();
  await openPanel(page);
  const r = await page.evaluate(() => {
    const ids = ["btn-new", "btn-hint", "toggle-panel", "help-btn"];
    const out = [];
    for (const id of ids) {
      const el = document.getElementById(id);
      if (!el || el.disabled) { out.push({ id, skip: "禁用或不存在" }); continue; }
      const before = getComputedStyle(el).outline;
      el.focus();
      const cs = getComputedStyle(el);
      out.push({ id, focused: document.activeElement === el, before,
                 outline: cs.outline, offset: cs.outlineOffset });
      el.blur();
    }
    // 分段控件与色板各取一个
    for (const [sel, name] of [[".setting-row .pill button", "分段控件"],
                               [".theme-row [data-theme]", "色板"]]) {
      const el = document.querySelector(sel);
      if (!el) { out.push({ id: name, skip: "没找到" }); continue; }
      el.focus();
      const cs = getComputedStyle(el);
      out.push({ id: name, focused: document.activeElement === el,
                 outline: cs.outline, offset: cs.outlineOffset });
      el.blur();
    }
    const rules = [];
    for (const sh of document.styleSheets) {
      try { for (const rr of sh.cssRules) if (/:focus-visible/.test(rr.selectorText || "")) rules.push(rr.selectorText); }
      catch (_) {}
    }
    return { out, rules };
  });
  if (!r.rules.length) bad.push("样式表里没有任何 :focus-visible 规则");
  for (const x of r.out) {
    if (x.skip) continue;
    if (!x.focused) { bad.push(x.id + " 没聚焦上"); continue; }
    // outline-style: none 或宽度 0 都算「没画」
    if (/(^|\s)none(\s|$)/.test(x.outline) || /(^|\s)0px(\s|$)/.test(x.outline)) {
      bad.push(x.id + " 聚焦后没有描边：" + x.outline);
    }
    if (x.offset === "0px") bad.push(x.id + " 的 outline-offset 是 0，环会贴死在控件上");
  }
  if (page.__errors.length) bad.push("errs " + page.__errors.join("|"));
  await page.close();
  report("AE 焦点由应用自己画（不落回引擎默认）",
    bad.length === 0, JSON.stringify({ bad, 规则: r.rules, 实测: r.out }));
}

// ---- Test AF: 主题色板认得出来，且没把名字一起藏掉 ----
// 主题那一格从「木/夜/日/本」四个字改成了四块色板 —— 这是为了让控件列宽与语言无关
// （四个字的自然宽 206px > 控件列 161px）。代价是标签不再显示，所以两件事得钉住：
//   一、四块色板**互不相同**，否则「换了个主题」这件事在界面上没有任何痕迹；
//   二、名字只是**视觉上**藏起来（font-size: 0），文本节点和 title 都还在 —— 实测
//      无障碍名中文「木/夜/日/本」、英文「Wood/Night/Day/Paper」，鼠标悬停有 title。
//      把文字换成空元素或 ::before 注入，名字就没了，而屏幕上看不出区别。
// 每块色板画的是**它自己那套主题**的 --board-frame（[data-theme] 按钮内部重新声明
// 了被预览主题的调色板 —— v1.32/v1.34 踩过的那个坑，这里是故意用它）。
{
  const bad = [];
  const page = await newPage();
  await openPanel(page);
  const seen = {};
  for (const lang of ["zh", "en"]) {
    if (lang === "en") {
      await page.evaluate(() => {
        const b = [...document.querySelectorAll("button")].find((x) => /^EN$/.test(x.textContent.trim()));
        if (b) b.click();
      });
      await page.waitForTimeout(450);
    }
    const r = await page.evaluate(() => {
      const bs = [...document.querySelectorAll(".theme-row [data-theme]")];
      return bs.map((x) => {
        const a = getComputedStyle(x, "::after");
        // backgroundImage 在纯色时返回字符串 "none" —— 它是真值,写成
        // `a.backgroundImage || a.backgroundColor` 就永远落不到纯色那一支,
        // 于是一块画着纯色的色板会被判成「没有底色」。四套主题的 --board-frame
        // 眼下都是渐变,但闸门不该把这个巧合写死。
        const img = a.backgroundImage;
        return {
          t: x.dataset.theme,
          name: (x.textContent || "").trim(),
          title: x.getAttribute("title") || "",
          swatch: img && img !== "none" ? img : (a.backgroundColor || ""),
          h: Math.round(parseFloat(a.height) || 0),
          active: x.classList.contains("active"),
        };
      });
    });
    seen[lang] = r;
    if (r.length !== 4) { bad.push(lang + ": 色板数量是 " + r.length + "，不是 4"); continue; }
    for (const x of r) {
      if (!x.name) bad.push(lang + ": " + x.t + " 的文本被删了 —— 无障碍名会变空");
      if (!x.title) bad.push(lang + ": " + x.t + " 没有 title，悬停认不出是哪套主题");
      if (!x.h) bad.push(lang + ": " + x.t + " 的色板高度是 0，等于没画");
      // 透明也算没画:纯色支拿到的是 rgba(0, 0, 0, 0) 而不是 "none"
      if (!x.swatch || x.swatch === "none" || /,\s*0\)$/.test(x.swatch)) {
        bad.push(lang + ": " + x.t + " 没有底色（" + x.swatch + "）");
      }
    }
    const uniq = new Set(r.map((x) => x.swatch));
    if (uniq.size !== r.length) {
      bad.push(lang + ": 四块色板只有 " + uniq.size + " 种颜色 —— 认不出选的是哪一套");
    }
    if (r.filter((x) => x.active).length !== 1) {
      bad.push(lang + ": 选中态有 " + r.filter((x) => x.active).length + " 个");
    }
  }
  if (page.__errors.length) bad.push("errs " + page.__errors.join("|"));
  await page.close();
  report("AF 主题色板互不相同，且名字只是视觉上藏起来",
    bad.length === 0, JSON.stringify({ bad, seen }));
}

// ---- Test AG: 统计表的数字表头压在它标注的那列数字上 ----
// 改之前每个数字表头都坐在它所标注的数字**左边 18–32px**（中文 +23/+23/+23/+29.9，
// 英文 +20.6/+18.1/+19.1/+31.7）。样式表里其实早就写着修正
// —— `.stats-table td.num, .stats-table th.num { text-align: right }` ——
// 但表头是 i18n 里一整条 HTML 串，没人给它 class="num"，所以 `th.num` 运行时命中 0 个。
//
// 而右对齐之后仍差一个齐整的 8px，根因更深：`.modal td { padding: 8px 0 }` 与
// `.stats-table th, .stats-table td { padding: 4px 8px }` **特异度相同**（0,1,1），
// 前者写在后面就赢了。那条规则是给帮助弹层的「按键 → 说明」表写的，统计表只是碰巧
// 也住在弹层里，于是连 `.modal td:first-child { width: 42% }`（按键列的宽）、强调色、
// 等宽 12px 一起继承了过来。已按来源收窄成 `.keys-table`。
//
// 这条闸门断言的是最终那件事：**表头文字的右缘与该列数字的右缘重合**，中英都要。
{
  const bad = [];
  const seen = {};
  const page = await newPage();
  await page.evaluate(() => {
    const S = window.GobanStats;
    let t = 1700000000000;
    for (const d of ["easy", "normal", "hard", "extreme"]) {
      for (let i = 0; i < 5; i++) {
        S.record({ mode: "ai", difficulty: d, humanColor: "b",
          result: i % 3 === 0 ? "b" : (i % 3 === 1 ? "w" : "draw"),
          moves: 40, durationMs: 123456, endedAt: t++ });
      }
    }
  });
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForTimeout(300);
  for (const lang of ["zh", "en"]) {
    if (lang === "en") {
      await openPanel(page);
      await page.evaluate(() => {
        const b = [...document.querySelectorAll("button")].find((x) => /^EN$/.test(x.textContent.trim()));
        if (b) b.click();
      });
      await page.waitForTimeout(450);
    }
    await page.evaluate(() => { const x = document.getElementById("open-stats"); if (x) x.click(); });
    await page.waitForTimeout(500);
    const r = await page.evaluate(() => {
      const tb = document.querySelector(".stats-table");
      if (!tb) return { err: "没有 .stats-table" };
      const rows = [...tb.querySelectorAll("tr")];
      const head = rows[0] ? [...rows[0].querySelectorAll("th")] : [];
      const dataRow = rows.find((x) => x.querySelector("td"));
      const cells = dataRow ? [...dataRow.querySelectorAll("td")] : [];
      // 量「墨迹」而不是单元格盒子:盒子相同而内边距不同,正是上一版看不见的那 8px
      const ink = (el) => { const rg = document.createRange(); rg.selectNodeContents(el); return rg.getBoundingClientRect(); };
      const cols = head.map((h, i) => {
        const c = cells[i];
        if (!c) return { i, 表头: h.textContent.trim(), 缺: true };
        return {
          i, 表头: h.textContent.trim(), 值: c.textContent.trim(),
          数字列: h.classList.contains("num"),
          右缘差: Math.round((ink(c).right - ink(h).right) * 10) / 10,
          左缘差: Math.round((ink(c).left - ink(h).left) * 10) / 10,
        };
      });
      return {
        cols,
        表头行高: Math.round(rows[0].getBoundingClientRect().height * 10) / 10,
        数据行高: Math.round(dataRow.getBoundingClientRect().height * 10) / 10,
        th内边距: head[0] ? getComputedStyle(head[0]).padding : null,
        td内边距: cells[0] ? getComputedStyle(cells[0]).padding : null,
      };
    });
    seen[lang] = r;
    if (r.err) { bad.push(lang + ": " + r.err); continue; }
    const nums = r.cols.filter((c) => c.数字列);
    if (nums.length < 3) bad.push(lang + ": 只找到 " + nums.length + " 个数字列表头（class=num 掉了？）");
    for (const c of nums) {
      if (c.缺) { bad.push(lang + ": 第 " + c.i + " 列没有对应的数据格"); continue; }
      if (Math.abs(c.右缘差) > 1) {
        bad.push(lang + ": 表头「" + c.表头 + "」的右缘与它标注的「" + c.值 + "」差 " + c.右缘差 + "px");
      }
    }
    // 内边距一致 —— 上一版 th 是 4px 8px、td 被 .modal td 改成 8px 0
    if (r.th内边距 !== r.td内边距) {
      bad.push(lang + ": th/td 内边距不一致 " + r.th内边距 + " vs " + r.td内边距);
    }
    if (Math.abs(r.表头行高 - r.数据行高) > 2) {
      bad.push(lang + ": 表头行 " + r.表头行高 + " 与数据行 " + r.数据行高 + " 高度差太大");
    }
    await page.evaluate(() => {
      const c = [...document.querySelectorAll(".modal-bg button")].find((x) => /close|关闭/i.test(x.textContent) || x.id === "stats-close");
      if (c) c.click();
    });
    await page.waitForTimeout(300);
  }
  if (page.__errors.length) bad.push("errs " + page.__errors.join("|"));
  await page.close();
  report("AG 统计表的数字表头压在它标注的那列数字上", bad.length === 0, JSON.stringify({ bad, seen }));
}

// ---- Test AH: 存档行的两个按钮跟随语言 ----
// 「读取」「删除」原本是 innerHTML 里的中文字面量，英文界面下原样是中文（实测
// lang=en、存档名正确地是 "Game 08-04 00:34"，按钮却写着「读取」「删除」）。
// 单测那道「不许有中文字面量」的闸门只认双引号，这两行是单引号，于是没响。
{
  const bad = [];
  const seen = {};
  const page = await newPage();
  await page.evaluate(() => {
    const cv = document.getElementById("board");
    const rect = cv.getBoundingClientRect();
    const g = window.GobanDraw.pitchFor(cv.width);
    const s = rect.width / cv.width;
    cv.dispatchEvent(new MouseEvent("click", {
      clientX: rect.left + (g.pad + 7 * g.step) * s,
      clientY: rect.top + (g.pad + 7 * g.step) * s, bubbles: true }));
  });
  await page.waitForTimeout(250);
  for (const lang of ["zh", "en"]) {
    if (lang === "en") {
      await openPanel(page);
      await page.evaluate(() => {
        const b = [...document.querySelectorAll("button")].find((x) => /^EN$/.test(x.textContent.trim()));
        if (b) b.click();
      });
      await page.waitForTimeout(450);
    }
    await page.evaluate(() => { const x = document.getElementById("sgf-slots"); if (x) x.click(); });
    await page.waitForTimeout(350);
    if (lang === "zh") {
      await page.evaluate(() => { const x = document.getElementById("slot-save-current"); if (x) x.click(); });
      await page.waitForTimeout(450);
      await dismissConfirm(page);
      await page.waitForTimeout(250);
    }
    const r = await page.evaluate(() => {
      const rows = [...document.querySelectorAll(".slot-row")];
      const cjk = [];
      const modal = document.getElementById("slots-modal");
      if (modal) {
        const walk = document.createTreeWalker(modal, NodeFilter.SHOW_TEXT);
        let n;
        while ((n = walk.nextNode())) {
          const txt = (n.nodeValue || "").trim();
          if (!txt || !/[\u4e00-\u9fa5]/.test(txt)) continue;
          const el = n.parentElement;
          if (el && el.getBoundingClientRect().width > 0) cjk.push(txt.slice(0, 16));
        }
      }
      return {
        行数: rows.length,
        按钮: rows.map((x) => [...x.querySelectorAll(".slot-ops button")].map((y) => y.textContent.trim())),
        弹层里可见的中文: [...new Set(cjk)],
      };
    });
    seen[lang] = r;
    if (!r.行数) { bad.push(lang + ": 一条存档都没量到"); continue; }
    const flat = r.按钮.flat();
    if (flat.length !== 2 * r.行数) bad.push(lang + ": 每行应有 2 个按钮，实得 " + JSON.stringify(r.按钮));
    for (const label of flat) {
      const zhLabel = /[\u4e00-\u9fa5]/.test(label);
      if (lang === "en" && zhLabel) bad.push("英文界面下按钮仍是中文：" + label);
      if (lang === "zh" && !zhLabel) bad.push("中文界面下按钮不是中文：" + label);
    }
    if (lang === "en" && r.弹层里可见的中文.length) {
      bad.push("英文存档弹层里还有可见中文：" + JSON.stringify(r.弹层里可见的中文));
    }
    await page.evaluate(() => { const x = document.getElementById("slots-close"); if (x) x.click(); });
    await page.waitForTimeout(250);
  }
  if (page.__errors.length) bad.push("errs " + page.__errors.join("|"));
  await page.close();
  report("AH 存档行的两个按钮跟随语言", bad.length === 0, JSON.stringify({ bad, seen }));
}

// ---- Test AI: 帮助弹层里写的快捷键，一条条按下去都得真的管用 ----
// 那张表是写给用户的 13 条承诺，而在此之前**没有任何测试按过其中任何一个键**。
// 一个失效的快捷键不会报错，它只是什么都不发生 —— 帮助页于是开始说谎，而这正是
// v1.43 里 SGF `RE` 字段的形状：没人读的东西，错了也没人发现。
// 这里按的是真键盘事件（page.keyboard），不是直接调处理函数 —— 调函数只能证明函数
// 还在，证明不了它还挂在键上。
{
  const bad = [];
  const seen = {};
  const press = async (page, key, ms) => { await page.keyboard.press(key); await page.waitForTimeout(ms || 300); };
  const moveCount = (page) => page.evaluate(() => document.querySelectorAll("#move-list button").length);
  const curMove = (page) => page.evaluate(() => {
    const el = document.querySelector("#move-list button.cur");
    return el ? el.textContent.trim() : null;
  });
  const okConfirm = async (page) => {
    await page.evaluate(() => {
      const ok = document.getElementById("confirm-ok");
      const m = document.getElementById("confirm-modal");
      if (ok && m && m.classList.contains("show")) ok.click();
    });
    await page.waitForTimeout(250);
  };
  const toPvp = async (page) => {
    await openPanel(page);
    await page.evaluate(() => { const x = document.querySelector('button[data-mode="pvp"]'); if (x) x.click(); });
    await page.waitForTimeout(200);
    await okConfirm(page);
  };

  // ① 点击交叉点落子 + 悬停有预览
  {
    const page = await newPage();
    const click = clicker(page);
    await toPvp(page);
    await click(7, 7); await page.waitForTimeout(250);
    seen["①落子"] = await moveCount(page);
    if (seen["①落子"] !== 1) bad.push("点击交叉点没落子（手数 " + seen["①落子"] + "）");
    const hov = await page.evaluate(() => {
      const cv = document.getElementById("board");
      const rect = cv.getBoundingClientRect();
      const g = window.GobanDraw.pitchFor(cv.width);
      const s = rect.width / cv.width;
      const grab = () => { const c2 = document.createElement("canvas");
        c2.width = cv.width; c2.height = cv.height;
        c2.getContext("2d").drawImage(cv, 0, 0); return c2.toDataURL().length; };
      const before = grab();
      cv.dispatchEvent(new MouseEvent("mousemove", {
        clientX: rect.left + (g.pad + 5 * g.step) * s,
        clientY: rect.top + (g.pad + 5 * g.step) * s, bubbles: true }));
      return new Promise((res) => setTimeout(() => res({ before, after: grab() }), 180));
    });
    seen["①悬停预览"] = hov;
    if (hov.before === hov.after) bad.push("悬停没有预览（画布指纹没变）");
    await page.close();
  }
  // ② H 提示：给提示但不代你落子
  {
    const page = await newPage();
    const click = clicker(page);
    await toPvp(page);
    await click(7, 7); await page.waitForTimeout(250);
    const before = await moveCount(page);
    await press(page, "h", 700);
    const after = await moveCount(page);
    seen["②H"] = { 前: before, 后: after };
    if (after !== before) bad.push("H 之后手数从 " + before + " 变成 " + after + "（提示不该代下）");
    await page.close();
  }
  // ③④ ← → / Home / End
  {
    const page = await newPage();
    const click = clicker(page);
    await toPvp(page);
    for (const [r, c] of [[7, 7], [8, 8], [7, 8], [8, 7], [6, 6]]) { await click(r, c); await page.waitForTimeout(120); }
    const start = await curMove(page);
    await press(page, "ArrowLeft"); const l1 = await curMove(page);
    await press(page, "ArrowLeft"); const l2 = await curMove(page);
    await press(page, "ArrowRight"); const r1 = await curMove(page);
    await press(page, "Home"); const home = await curMove(page);
    await press(page, "End"); const end = await curMove(page);
    const last = await page.evaluate(() => {
      const all = [...document.querySelectorAll("#move-list button")];
      return all.length ? all[all.length - 1].textContent.trim() : null;
    });
    seen["③④"] = { 起: start, 左1: l1, 左2: l2, 右1: r1, Home: home, End: end, 末手: last };
    if (!(l1 && l1 !== start)) bad.push("← 没有回退（" + start + " → " + l1 + "）");
    if (!(l2 && l2 !== l1)) bad.push("← 第二次没有再退（" + l1 + " → " + l2 + "）");
    if (r1 !== l1) bad.push("→ 没有前进回 " + l1 + "（得到 " + r1 + "）");
    // 判据不能只写「Home 与 End 不同」：摘掉 Home 那一条之后按键变成空操作，光标
    // 停在原处，跟 End 仍然不同 —— 反证因此没打响。得各自钉死落点。
    if (home !== null) bad.push("Home 没有回到开局（当前手是 " + home + "，应为无当前手）");
    if (end !== last) bad.push("End 没有到最后一手（到了 " + end + "，末手是 " + last + "）");
    await page.close();
  }
  // ⑤ Z / ⌘Z 悔棋
  {
    const page = await newPage();
    const click = clicker(page);
    await toPvp(page);
    for (const [r, c] of [[7, 7], [8, 8], [7, 8]]) { await click(r, c); await page.waitForTimeout(120); }
    const n0 = await moveCount(page);
    await press(page, "z", 350); const n1 = await moveCount(page);
    await press(page, "Control+z", 350); const n2 = await moveCount(page);
    seen["⑤悔棋"] = [n0, n1, n2];
    if (n1 !== n0 - 1) bad.push("Z 没悔棋（" + n0 + " → " + n1 + "）");
    if (n2 !== n1 - 1) bad.push("⌘Z/Ctrl+Z 没悔棋（" + n1 + " → " + n2 + "）");
    await page.close();
  }
  // ⑥ N 新局
  {
    const page = await newPage();
    const click = clicker(page);
    await toPvp(page);
    for (const [r, c] of [[7, 7], [8, 8]]) { await click(r, c); await page.waitForTimeout(120); }
    const n0 = await moveCount(page);
    await press(page, "n", 350);
    await okConfirm(page);
    const n1 = await moveCount(page);
    seen["⑥新局"] = [n0, n1];
    if (!(n0 > 0 && n1 === 0)) bad.push("N 没开新局（" + n0 + " → " + n1 + "）");
    await page.close();
  }
  // ⑦ [ ] 侧栏
  {
    const page = await newPage();
    const isOpen = () => page.evaluate(() => {
      const a = document.getElementById("app"); return a ? a.classList.contains("panel-open") : null;
    });
    await press(page, "]", 350); const o1 = await isOpen();
    await press(page, "[", 350); const o2 = await isOpen();
    seen["⑦侧栏"] = { "]": o1, "[": o2 };
    if (o1 !== true) bad.push("] 没有展开侧栏");
    if (o2 !== false) bad.push("[ 没有收起侧栏");
    await page.close();
  }
  // ⑧ ⌘1 / ⌘2 模式
  {
    const page = await newPage();
    const mode = () => page.evaluate(() => {
      const b = document.querySelector("button[data-mode].active"); return b ? b.dataset.mode : null;
    });
    await press(page, "Control+1", 300); await okConfirm(page); const m1 = await mode();
    await press(page, "Control+2", 300); await okConfirm(page); const m2 = await mode();
    seen["⑧模式"] = { "⌘1": m1, "⌘2": m2 };
    if (m1 !== "pvp") bad.push("⌘1 没切到双人（得到 " + m1 + "）");
    if (m2 !== "ai") bad.push("⌘2 没切到人机（得到 " + m2 + "）");
    await page.close();
  }
  // ⑪⑬ ? 打开说明 · Esc 关弹层 / 收侧栏
  {
    const page = await newPage();
    await press(page, "?", 400);
    const shown = await page.evaluate(() => {
      const m = document.getElementById("help-modal"); return m ? m.classList.contains("show") : null;
    });
    await press(page, "Escape", 400);
    const closed = await page.evaluate(() => {
      const m = document.getElementById("help-modal"); return m ? !m.classList.contains("show") : null;
    });
    await press(page, "]", 300);
    await press(page, "Escape", 400);
    const panel = await page.evaluate(() => {
      const a = document.getElementById("app"); return a ? a.classList.contains("panel-open") : null;
    });
    seen["⑪⑬"] = { "?打开": shown, "Esc关掉": closed, "Esc后侧栏": panel };
    if (shown !== true) bad.push("? 没有打开说明");
    if (closed !== true) bad.push("Esc 没有关掉说明");
    if (panel !== false) bad.push("Esc 没有收起侧栏");
    await page.close();
  }
  report("AI 帮助里写的快捷键逐个按下去都管用", bad.length === 0, JSON.stringify({ bad, seen }));
}

// ---- Test AJ: 四套主题下的文字都得达 AA ----
// v1.32 花一整版把浅色主题的文字对比度做到 4.5:1，此后加了主题色板、焦点环、
// keys-table…… 而**没有任何闸门守着**它。这条补上，四套主题各算一遍。
//
// 写这条探针时我连踩四个坑，判据里都留了痕：
//   一、底色可能是 `color(srgb r g b / a)` 这种新拼法，只认 rgb()/rgba() 会把它当
//       透明，于是一路穿到页面底色 —— 执子徽标因此被误报成 1.02。
//   二、底色可能根本是渐变（background-image），算不出单一颜色 —— 「新局」按钮是
//       linear-gradient，同样被误报成白字压近白底。这类元素**取像素**判，不硬算。
//   三、取像素时不能拿盒子里最暗/最亮的那一个：圆角之外是页面底色，会把 8.58 的
//       按钮报成 1.18。取盒内像素的**中位色**。
//   四、跳过的元素必须报出数量。只报「0 处不合格」而不报「算过几个」，闸门可以在
//       什么都没测的情况下永远绿。
{
  const bad = [];
  const seen = {};
  const page = await newPage();
  await page.evaluate(() => {
    const S = window.GobanStats;
    let t = 1700000000000;
    for (const d of ["easy", "normal", "hard", "extreme"]) {
      for (let i = 0; i < 5; i++) {
        S.record({ mode: "ai", difficulty: d, humanColor: "b",
          result: i % 3 === 0 ? "b" : (i % 3 === 1 ? "w" : "draw"),
          moves: 40, durationMs: 99000, endedAt: t++ });
      }
    }
    for (let i = 0; i < 3; i++) S.record({ mode: "pvp", result: "b", moves: 30, durationMs: 60000, endedAt: t++ });
  });
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForTimeout(300);
  await openPanel(page);

  const computed = () => page.evaluate(() => {
    const lum = (r, g, b) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
      return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
    // 坑一:两种拼法都要认
    const parse = (s) => {
      if (!s) return null;
      const c = s.match(/color\(srgb\s+([^)]+)\)/);
      if (c) { const t = c[1].replace("/", " ").split(/\s+/).filter(Boolean).map(Number);
        return { r: t[0] * 255, g: t[1] * 255, b: t[2] * 255, a: t.length > 3 ? t[3] : 1 }; }
      const m = s.match(/rgba?\(([^)]+)\)/);
      if (!m) return null;
      const a = m[1].split(",").map((x) => parseFloat(x));
      return { r: a[0], g: a[1], b: a[2], a: a.length > 3 ? a[3] : 1 };
    };
    const over = (fg, bg) => ({ r: fg.r * fg.a + bg.r * (1 - fg.a), g: fg.g * fg.a + bg.g * (1 - fg.a),
      b: fg.b * fg.a + bg.b * (1 - fg.a), a: 1 });
    const pageBg = parse(getComputedStyle(document.body).backgroundColor) || { r: 255, g: 255, b: 255, a: 1 };
    // 坑二:祖先链上有渐变就算不出单一底色,交给取像素那一路
    const bgOf = (el) => {
      let cur = el, acc = null;
      while (cur && cur !== document.documentElement) {
        const cs = getComputedStyle(cur);
        if (cs.backgroundImage && cs.backgroundImage !== "none") return { gradient: true };
        const c = parse(cs.backgroundColor);
        if (c && c.a > 0) acc = acc ? over(acc, c) : c;
        if (acc && acc.a >= 0.999) return acc;
        cur = cur.parentElement;
      }
      return acc ? over(acc, pageBg) : pageBg;
    };
    const out = []; let checked = 0, onGradient = 0;
    for (const el of document.querySelectorAll("*")) {
      if (![...el.childNodes].some((n) => n.nodeType === 3 && n.nodeValue.trim())) continue;
      const r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) continue;
      const cs = getComputedStyle(el);
      if (cs.visibility === "hidden" || cs.display === "none" || parseFloat(cs.opacity) === 0) continue;
      let anc = el.parentElement, skip = false;
      while (anc) { const a = getComputedStyle(anc);
        if (a.display === "none" || a.visibility === "hidden" || parseFloat(a.opacity) === 0) { skip = true; break; }
        anc = anc.parentElement; }
      if (skip) continue;
      const fg = parse(cs.color); if (!fg) continue;
      const bg = bgOf(el);
      if (bg.gradient) { onGradient++; continue; }
      checked++;
      const eff = fg.a < 1 ? over(fg, bg) : fg;
      const L1 = lum(eff.r, eff.g, eff.b), L2 = lum(bg.r, bg.g, bg.b);
      const ratio = (Math.max(L1, L2) + 0.05) / (Math.min(L1, L2) + 0.05);
      const px = parseFloat(cs.fontSize), wt = parseInt(cs.fontWeight, 10) || 400;
      const need = (px >= 24 || (px >= 18.66 && wt >= 700)) ? 3.0 : 4.5;
      if (ratio < need) {
        out.push({ 文本: el.textContent.trim().slice(0, 16),
          元素: el.id ? "#" + el.id : (el.className ? "." + String(el.className).split(" ")[0] : el.tagName),
          比值: Math.round(ratio * 100) / 100, 需要: need });
      }
    }
    return { out, checked, onGradient };
  });

  // 渐变上的那些:拍一张「文字透明」的图，取盒内中位色当底
  const pixel = async () => {
    const targets = await page.evaluate(() => {
      const onGrad = (el) => { let c = el; while (c && c !== document.documentElement) {
        const cs = getComputedStyle(c); if (cs.backgroundImage && cs.backgroundImage !== "none") return true;
        c = c.parentElement; } return false; };
      const out = [];
      [...document.querySelectorAll("*")].forEach((el, i) => {
        if (![...el.childNodes].some((n) => n.nodeType === 3 && n.nodeValue.trim())) return;
        const r = el.getBoundingClientRect();
        if (r.width <= 0 || r.height <= 0) return;
        const cs = getComputedStyle(el);
        if (cs.visibility === "hidden" || cs.display === "none" || parseFloat(cs.opacity) === 0) return;
        if (!onGrad(el)) return;
        el.setAttribute("data-cprobe", String(i));
        out.push({ key: String(i), 文本: el.textContent.trim().slice(0, 16),
          元素: el.id ? "#" + el.id : (el.className ? "." + String(el.className).split(" ")[0] : el.tagName),
          前景: cs.color, 字号: parseFloat(cs.fontSize), 粗细: parseInt(cs.fontWeight, 10) || 400 });
      });
      return out;
    });
    await page.evaluate(() => {
      const st = document.createElement("style"); st.id = "cprobe-style";
      st.textContent = "[data-cprobe]{color:transparent !important;text-shadow:none !important;}";
      document.head.appendChild(st);
    });
    await page.waitForTimeout(220);
    const shot = (await page.screenshot()).toString("base64");
    const res = await page.evaluate(async ({ shot, targets }) => {
      const img = new Image(); img.src = "data:image/png;base64," + shot; await img.decode();
      const cv = document.createElement("canvas"); cv.width = img.width; cv.height = img.height;
      const ctx = cv.getContext("2d"); ctx.drawImage(img, 0, 0);
      const lum = (r, g, b) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
        return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
      const dpr = img.width / innerWidth;
      const out = [];
      for (const t of targets) {
        const el = document.querySelector('[data-cprobe="' + t.key + '"]'); if (!el) continue;
        const r = el.getBoundingClientRect();
        const d = ctx.getImageData(Math.max(0, Math.round(r.left * dpr)), Math.max(0, Math.round(r.top * dpr)),
          Math.max(1, Math.round(r.width * dpr)), Math.max(1, Math.round(r.height * dpr))).data;
        const px = []; for (let i = 0; i < d.length; i += 4) px.push([d[i], d[i + 1], d[i + 2]]);
        // 坑三:取中位,不取最暗/最亮 —— 圆角之外是页面底色
        px.sort((a, b) => lum(a[0], a[1], a[2]) - lum(b[0], b[1], b[2]));
        const mid = px[Math.floor(px.length / 2)];
        const fg = (t.前景.match(/[\d.]+/g) || [0, 0, 0]).map(Number);
        const L1 = lum(fg[0], fg[1], fg[2]), L2 = lum(mid[0], mid[1], mid[2]);
        const ratio = (Math.max(L1, L2) + 0.05) / (Math.min(L1, L2) + 0.05);
        const need = (t.字号 >= 24 || (t.字号 >= 18.66 && t.粗细 >= 700)) ? 3.0 : 4.5;
        out.push({ 文本: t.文本, 元素: t.元素, 比值: Math.round(ratio * 100) / 100, 需要: need,
          底色: "rgb(" + mid[0] + ", " + mid[1] + ", " + mid[2] + ")" });
      }
      return out;
    }, { shot, targets });
    await page.evaluate(() => {
      const st = document.getElementById("cprobe-style"); if (st) st.remove();
      document.querySelectorAll("[data-cprobe]").forEach((e) => e.removeAttribute("data-cprobe"));
    });
    return res;
  };

  for (const th of ["wood", "night", "day", "notebook"]) {
    await page.evaluate((t) => { const x = document.querySelector('.theme-row [data-theme="' + t + '"]'); if (x) x.click(); }, th);
    await page.waitForTimeout(400);
    const c1 = await computed();
    const px = await pixel();
    // 弹层里还有近百个文字元素(统计表、每日行、总计行)——不开弹层只能算到 55 个,
    // 下面那条覆盖判据就是这么把第一版拦下来的。
    await page.evaluate(() => { const x = document.getElementById("open-stats"); if (x) x.click(); });
    await page.waitForTimeout(500);
    const c2 = await computed();
    await page.evaluate(() => { const x = document.getElementById("stats-close"); if (x) x.click(); });
    await page.waitForTimeout(300);
    const c = { checked: c1.checked + c2.checked, out: [...c1.out, ...c2.out] };
    const pxBad = px.filter((x) => x.比值 < x.需要);
    seen[th] = { 算过: c.checked, 其中弹层: c2.checked, 取像素: px.length,
                 算出来不合格: c.out, 像素判不合格: pxBad };
    // 坑四:覆盖数太少 = 闸门什么都没测
    if (c.checked < 80) bad.push(th + ": 只算了 " + c.checked + " 个文字元素，覆盖太少，这条闸门等于没测");
    if (px.length < 3) bad.push(th + ": 渐变上只量到 " + px.length + " 个，取像素那一路没生效");
    for (const x of c.out) bad.push(th + ": 「" + x.文本 + "」(" + x.元素 + ") 对比度 " + x.比值 + " < " + x.需要);
    for (const x of pxBad) bad.push(th + ": 渐变上「" + x.文本 + "」(" + x.元素 + ") 对比度 " + x.比值 + " < " + x.需要);
  }
  if (page.__errors.length) bad.push("errs " + page.__errors.join("|"));
  await page.close();
  report("AJ 四套主题的文字都达 AA", bad.length === 0, JSON.stringify({ bad, seen }));
}

console.log("---");
const allOk = results.every((r) => r.ok);
console.log(allOk ? "CROSS_ALL_OK" : "CROSS_FAIL (" + results.filter((r) => !r.ok).map((r) => r.name).join("; ") + ")");
await browser.close();
server.close();
process.exit(allOk ? 0 : 1);
