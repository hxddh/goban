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
import path from "path";
import http from "http";
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
  console.log("SKIP: playwright not found at " + PW_MODULE + " (set PLAYWRIGHT_MODULE)");
  process.exit(0);
}

const MIME = { ".html": "text/html", ".css": "text/css", ".js": "text/javascript" };
const server = http.createServer((req, res) => {
  const urlPath = decodeURIComponent((req.url || "/").split("?")[0]);
  const rel = urlPath === "/" ? "index.html" : urlPath.replace(/^\/+/, "");
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

async function dismissConfirm(page) {
  if (await page.evaluate(() => document.getElementById("confirm-modal").classList.contains("show"))) {
    await page.click("#confirm-ok");
    await page.waitForTimeout(120);
  }
}

async function enableSwap2Pvp(page) {
  await page.click("#toggle-panel").catch(() => {});
  await page.waitForTimeout(80);
  await page.click('button[data-mode="pvp"]');
  await page.waitForTimeout(100);
  await dismissConfirm(page);
  await page.click('button[data-opening="swap2"]');
  await page.waitForTimeout(120);
  await dismissConfirm(page);
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
  await page.click("#toggle-panel").catch(() => {});
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
  await page.click("#toggle-panel").catch(() => {});
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

console.log("---");
const allOk = results.every((r) => r.ok);
console.log(allOk ? "CROSS_ALL_OK" : "CROSS_FAIL (" + results.filter((r) => !r.ok).map((r) => r.name).join("; ") + ")");
await browser.close();
server.close();
process.exit(allOk ? 0 : 1);
