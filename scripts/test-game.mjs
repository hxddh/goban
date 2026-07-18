/**
 * Minimal Node tests for core + sgf (no DOM).
 * Run: node scripts/test-game.mjs
 */
import fs from "fs";
import path from "path";
import vm from "vm";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");
const ctx = { console };
ctx.globalThis = ctx;
ctx.window = ctx;
vm.createContext(ctx);

function load(rel) {
  const code = fs.readFileSync(path.join(root, rel), "utf8");
  vm.runInContext(code, ctx, { filename: rel });
}

load("src/web/js/core.js");
load("src/web/js/sgf.js");
load("src/web/js/state.js");

const Core = ctx.GobanCore;
const Sgf = ctx.GobanSgf;
const State = ctx.GobanState;

let failed = 0;
function assert(cond, msg) {
  if (!cond) {
    failed++;
    console.error("FAIL:", msg);
  } else {
    console.log("ok:", msg);
  }
}

// core: empty / place win horizontal
{
  const b = Core.emptyBoard();
  assert(b.length === 15 && b[0].length === 15, "board 15x15");
  for (let c = 0; c < 5; c++) b[7][c] = "b";
  const line = Core.findWin(b, 7, 2, "b");
  assert(line && line.length >= 5, "findWin five in a row");
  assert(Core.opp("b") === "w", "opp");
}

// boardAfter
{
  const hist = [
    { r: 7, c: 7 },
    { r: 7, c: 8 },
    { r: 8, c: 7 },
  ];
  const b = Core.boardAfter(hist, 3);
  assert(b[7][7] === "b" && b[7][8] === "w" && b[8][7] === "b", "boardAfter colors");
}

// sgf round-trip
{
  const hist = [];
  // diagonal black win-ish sequence alternating
  for (let i = 0; i < 9; i++) {
    if (i % 2 === 0) hist.push({ r: 7, c: 3 + (i / 2) | 0 });
    else hist.push({ r: 0, c: i });
  }
  const text = Sgf.buildSgf({
    history: hist,
    result: "play",
    mode: "pvp",
    humanColor: "b",
    originalStartedAt: Date.UTC(2026, 0, 1),
  });
  assert(text.includes("GM[4]") && text.includes("SZ[15]"), "buildSgf headers");
  const parsed = Sgf.parseSgf(text);
  assert(!parsed.error, "parse ok: " + (parsed.error || ""));
  assert(parsed.history.length === hist.length, "history length");
  assert(
    parsed.history.every((p, i) => p.r === hist[i].r && p.c === hist[i].c),
    "coords match"
  );
}

// sgf errors
{
  assert(Sgf.parseSgf("").error, "empty error");
  assert(Sgf.parseSgf("hello").error, "not sgf");
  assert(Sgf.parseSgf("(;SZ[19];B[dd])").error.includes("19"), "size mismatch");
}

// state import helper does not imply AI; sets importPaused for continue
{
  const hist = [
    { r: 7, c: 7 },
    { r: 7, c: 8 },
  ];
  const r = State.sessionFromHistory(hist, { mode: "ai", humanColor: "b", gameGen: 3 });
  assert(r.ok, "sessionFromHistory ok");
  assert(r.session.history.length === 2, "hist");
  assert(r.session.aiThinking === false, "no ai thinking");
  assert(r.session.gameGen === 4, "gameGen bump");
  assert(r.session.turn === "b", "next turn black");
  assert(r.session.importPaused === true, "importPaused after open game");
  assert(State.canContinuePlay(r.session), "canContinuePlay");
  State.resumeFromImport(r.session);
  assert(r.session.importPaused === false, "resume clears pause");
  assert(!State.canContinuePlay(r.session), "no continue after resume");
}

// finished import: no continue
{
  const hist = [];
  for (let c = 0; c < 5; c++) {
    hist.push({ r: 7, c }); // black
    if (c < 4) hist.push({ r: 0, c }); // white filler
  }
  // black wins on last move: B at 7,0 7,1 7,2 7,3 7,4 interleaved
  const winHist = [
    { r: 7, c: 0 }, { r: 0, c: 0 },
    { r: 7, c: 1 }, { r: 0, c: 1 },
    { r: 7, c: 2 }, { r: 0, c: 2 },
    { r: 7, c: 3 }, { r: 0, c: 3 },
    { r: 7, c: 4 },
  ];
  const r = State.sessionFromHistory(winHist, { mode: "ai", humanColor: "b" });
  assert(r.ok, "win import ok");
  assert(r.session.result === "b", "import detects black win");
  assert(r.session.importPaused === false, "finished: no pause");
  assert(!State.canContinuePlay(r.session), "no continue on finished");
}

// empty history rejected
{
  const r = State.sessionFromHistory([], {});
  assert(!r.ok && r.error, "empty history rejected");
}

// draw module loads (no canvas needed for THEMES)
load("src/web/js/draw.js");
{
  const Draw = ctx.GobanDraw;
  assert(Draw && Draw.THEMES && Draw.THEMES.wood, "GobanDraw.THEMES");
  assert(Draw.THEMES.notebook && Draw.THEMES.notebook.pencilB, "notebook ink");
  assert(typeof Draw.attach === "function" && typeof Draw.draw === "function", "draw API");
}

if (failed) {
  console.error("\n" + failed + " failed");
  process.exit(1);
}
console.log("\nall passed");
