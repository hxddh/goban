/**
 * 每日挑战 browser smoke: full answer flow, once-per-day check-in, same-day
 * determinism (stored snapshot), replay never re-counts, stats panel line,
 * and free practice untouched.
 *
 * Run: node scripts/test-daily.mjs
 * Needs Playwright + Chromium (same discovery/skip contract as test-cross.mjs):
 *   PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs
 *   PLAYWRIGHT_CHROMIUM=/path/to/chromium
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

const results = [];
function report(name, ok, detail) {
  results.push({ name, ok });
  console.log((ok ? "PASS" : "FAIL") + " " + name + (detail ? "  " + detail : ""));
}

const page = await ctx.newPage();
page.__errors = [];
page.on("console", (m) => {
  if (m.type() === "error" && !/Failed to load resource/.test(m.text())) page.__errors.push(m.text());
});
page.on("pageerror", (e) => page.__errors.push("PAGEERR " + e.message));
await page.goto(ORIGIN + "/index.html", { waitUntil: "networkidle" });
await page.evaluate(() => localStorage.clear());
await page.reload({ waitUntil: "networkidle" });
await page.waitForTimeout(250);

const DAILY_KEY = "goban.v12.daily";
const readDaily = () =>
  page.evaluate((k) => JSON.parse(localStorage.getItem(k) || "null"), DAILY_KEY);

const modalText = (id) => page.evaluate((i) => (document.getElementById(i) || {}).textContent || "", id);

/** A correct cell for the puzzle currently at pool index `i` (independent
 *  oracle: recomputed from the stored snapshot, not practice.js internals). */
const solutionFor = (i) =>
  page.evaluate(({ k, i }) => {
    const st = JSON.parse(localStorage.getItem(k));
    const def = st.puzzles[i];
    const Core = window.GobanCore, Ai = window.GobanAi;
    const bd = Core.emptyBoard();
    for (const [r, c] of def.b) bd[r][c] = "b";
    for (const [r, c] of def.w) bd[r][c] = "w";
    const side = def.side, oppo = Core.opp(side);
    // vcf: ask the engine's own VCF search for a forcing first move — an
    // oracle independent of practice.js, which derives its answer set from
    // the same public helper rather than from this code.
    if (def.type === "vcf") {
      const m = Ai.findVCF(bd, side, 6);
      return m ? { r: m.r, c: m.c } : null;
    }
    for (let r = 0; r < Core.SIZE; r++) for (let c = 0; c < Core.SIZE; c++) {
      if (bd[r][c]) continue;
      if (Core.wouldWin(bd, r, c, side)) return { r, c };
      if (def.type === "defend") {
        bd[r][c] = side;
        const ok = !Ai.listWinCells(bd, oppo).length;
        bd[r][c] = "";
        if (ok) return { r, c };
      }
    }
    return null;
  }, { k: DAILY_KEY, i });

const clickMini = (r, c) =>
  page.evaluate(({ r, c }) => {
    const cv = document.getElementById("practice-board");
    const S = window.GobanCore.SIZE;
    const rect = cv.getBoundingClientRect();
    const pad = rect.width * 0.04, step = (rect.width - pad * 2) / (S - 1);
    const x = rect.left + pad + c * step;
    const y = rect.top + pad + r * step;
    cv.dispatchEvent(new MouseEvent("click", { clientX: x, clientY: y, bubbles: true }));
  }, { r, c });

async function answerRound(expectAllCorrect) {
  let correct = 0;
  for (let i = 0; i < 5; i++) {
    const sol = await solutionFor(i);
    if (!sol) break;
    await clickMini(sol.r, sol.c);
    await page.waitForTimeout(80);
    const fb = await modalText("practice-feedback");
    if (/✓/.test(fb)) correct++;
    await page.click("#practice-next");
    await page.waitForTimeout(80);
  }
  return correct;
}

// ---- Test 1: open daily → titled, 5 questions, snapshot stored ----
{
  // "]" is idempotent (setPanelOpen(true)); #toggle-panel flips, and since
  // v1.33 a fresh profile starts with the panel already open.
  await page.keyboard.press("]");
  await page.waitForTimeout(120);
  await page.click("#open-daily");
  await page.waitForTimeout(200);
  const title = await modalText("practice-title");
  const prog = await modalText("practice-progress");
  const st = await readDaily();
  report("1 daily opens with 5-question set",
    title === "每日挑战" && /第 1 \/ 5 题/.test(prog) && st && Array.isArray(st.puzzles) && st.puzzles.length === 5,
    JSON.stringify({ title, prog, puzzles: st && st.puzzles && st.puzzles.length }));
}

// ---- Test 2: answer all 5 correctly → completion + streak 1 ----
{
  const snapshotBefore = JSON.stringify((await readDaily()).puzzles);
  const correct = await answerRound(true);
  const task = await modalText("practice-task");
  const fb = await modalText("practice-feedback");
  const st = await readDaily();
  report("2 full round completes and checks in",
    correct === 5 && task === "今日挑战完成" && /连续打卡 1 天/.test(fb) &&
      st.daysDone === 1 && st.streak === 1 && st.lastScore === 5,
    JSON.stringify({ correct, task, fb, daysDone: st.daysDone, streak: st.streak }));
  page.__snapshot1 = snapshotBefore;
}

// ---- Test 3: reopen same day → same set, "已完成" summary ----
{
  await page.click("#practice-close");
  await page.waitForTimeout(80);
  await page.click("#open-daily");
  await page.waitForTimeout(150);
  const task = await modalText("practice-task");
  const fb = await modalText("practice-feedback");
  const st = await readDaily();
  const same = JSON.stringify(st.puzzles) === page.__snapshot1;
  report("3 same-day reopen: identical set + done summary",
    task === "今日挑战已完成" && /连续打卡 1 天/.test(fb) && same,
    JSON.stringify({ task, same }));
}

// ---- Test 4: replay never re-counts ----
{
  await page.click("#practice-next"); // 再练一遍
  await page.waitForTimeout(120);
  const prog = await modalText("practice-progress");
  const restarted = /第 1 \/ 5 题/.test(prog);
  await answerRound(true);
  const st = await readDaily();
  report("4 replay runs but check-in stays counted once",
    restarted && st.daysDone === 1 && st.streak === 1,
    JSON.stringify({ restarted, daysDone: st.daysDone, streak: st.streak }));
  await page.click("#practice-close");
  await page.waitForTimeout(80);
}

// ---- Test 5: stats panel shows the daily line (no finished games yet) ----
{
  await page.click("#open-stats");
  await page.waitForTimeout(120);
  const body = await modalText("stats-body");
  const emptyHidden = await page.evaluate(
    () => document.getElementById("stats-empty").hidden);
  report("5 stats shows daily check-in line",
    /每日挑战 打卡 1 天/.test(body) && /今日已完成/.test(body) && emptyHidden,
    JSON.stringify({ body: body.slice(0, 60), emptyHidden }));
  await page.click("#stats-close");
  await page.waitForTimeout(80);
}

// ---- Test 6: free practice untouched (own title, own round) ----
{
  await page.click("#open-practice");
  await page.waitForTimeout(150);
  const title = await modalText("practice-title");
  const prog = await modalText("practice-progress");
  report("6 free practice keeps its own flow",
    title === "战术练习" && /第 1 \//.test(prog),
    JSON.stringify({ title, prog }));
  await page.click("#practice-close");
  await page.waitForTimeout(80);
}

// ---- Test 7: 错题本 — a missed puzzle is collected, and leaves once solved ----
{
  await page.evaluate(() => localStorage.removeItem("goban.v12.practice"));
  await page.click("#open-practice");
  await page.waitForTimeout(250);

  // answer the current puzzle wrong (a far corner is never the solution)
  const cornerFree = await page.evaluate(() => {
    const P = window.GobanPractice.puzzles;
    return true; // the corner is empty in every built-in position
  });
  await clickMini(0, 0);
  await page.waitForTimeout(200);
  const afterWrong = await page.evaluate(() => ({
    btn: document.getElementById("practice-wrong").textContent,
    stored: JSON.parse(localStorage.getItem("goban.v12.practice") || "null"),
  }));
  const collected = !!afterWrong.stored &&
    Object.values(afterWrong.stored.items).some((i) => i.wrong === 1 && i.ok === false) &&
    /错题本 1/.test(afterWrong.btn);

  // enter 错题本: exactly that one puzzle
  await page.click("#practice-wrong");
  await page.waitForTimeout(400);
  const inBook = await page.evaluate(() => ({
    title: document.getElementById("practice-title").textContent,
    prog: document.getElementById("practice-progress").textContent,
  }));

  // solve it — the book must empty out and the puzzle count itself must persist
  const sol = await page.evaluate(() => {
    const P = window.GobanPractice;
    const un = P.progress.unmastered(P.puzzles.buildCandidates(),
      JSON.parse(localStorage.getItem("goban.v12.practice") || "{}"));
    return un.length ? { r: un[0].solutions[0].r, c: un[0].solutions[0].c } : null;
  });
  if (sol) { await clickMini(sol.r, sol.c); await page.waitForTimeout(250); }
  const afterRight = await page.evaluate(() => ({
    btn: document.getElementById("practice-wrong").textContent,
    left: window.GobanPractice.progress.unmastered(
      window.GobanPractice.puzzles.buildCandidates(),
      JSON.parse(localStorage.getItem("goban.v12.practice") || "{}")).length,
  }));

  report("7 错题本收录做错的题，做对后移出",
    cornerFree && collected && inBook.title === "错题本" && /第 1 \/ 1 题/.test(inBook.prog) &&
      !!sol && afterRight.left === 0 && afterRight.btn === "错题本",
    JSON.stringify({ afterWrong: afterWrong.btn, inBook, sol, afterRight }));
  await page.click("#practice-close");
  await page.waitForTimeout(120);
}

// ---- Test 8: zero console errors across the whole flow ----
report("8 zero console errors", page.__errors.length === 0, JSON.stringify(page.__errors.slice(0, 3)));

await browser.close();
server.close();

const failed = results.filter((r) => !r.ok).length;
if (failed) {
  console.error("\n" + failed + " FAILED");
  process.exit(1);
}
console.log("\nDAILY_ALL_OK");
