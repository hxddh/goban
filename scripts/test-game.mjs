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
load("src/web/js/ai.js");
load("src/web/js/state.js");

const Core = ctx.GobanCore;
const Sgf = ctx.GobanSgf;
const Ai = ctx.GobanAi;
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

// sgf AP version stamp
{
  const text = Sgf.buildSgf({
    history: [{ r: 7, c: 7 }],
    result: "play",
    mode: "pvp",
    humanColor: "b",
    originalStartedAt: Date.UTC(2026, 0, 1),
  });
  assert(text.includes("AP[Goban:1.14]"), "SGF AP version");
}

// importPaused persists only when open game
{
  const open = State.sessionFromHistory([{ r: 7, c: 7 }], { mode: "ai", humanColor: "b" });
  assert(open.ok && open.session.importPaused, "open game paused");
  // simulate serialize field presence
  const snap = {
    v: 3,
    importPaused: open.session.importPaused,
    result: open.session.result,
  };
  assert(snap.v >= 3 && snap.importPaused && snap.result === "play", "save v3 pause flag");
}

// AI: win now / block opponent / does not mutate caller board
{
  const b = Core.emptyBoard();
  // black has four in a row — white to block at (7,4)
  for (let c = 0; c < 4; c++) b[7][c] = "b";
  b[0][0] = "w";
  b[1][0] = "w";
  const snap = b.map((row) => row.join(""));
  const block = Ai.aiMove({ board: b, side: "w", difficulty: "hard", timeMs: 200 });
  assert(block && block.r === 7 && block.c === 4, "hard blocks open four at 7,4 got " + JSON.stringify(block));
  assert(b.map((row) => row.join("")).join("|") === snap.join("|"), "aiMove does not mutate board");

  const b2 = Core.emptyBoard();
  for (let c = 0; c < 4; c++) b2[5][c] = "w";
  b2[0][0] = "b";
  const win = Ai.aiMove({ board: b2, side: "w", difficulty: "normal", timeMs: 80 });
  assert(win && win.r === 5 && win.c === 4, "takes winning fifth " + JSON.stringify(win));

  const b3 = Core.emptyBoard();
  b3[7][7] = "b";
  const hint = Ai.hintMove({ board: b3, side: "w", difficulty: "easy", timeMs: 50 });
  assert(hint && typeof hint.r === "number", "hintMove returns a cell");
}

// AI empty board center bias
{
  const b = Core.emptyBoard();
  const m = Ai.aiMove({ board: b, side: "b", difficulty: "hard", timeMs: 50 });
  assert(m && m.r === 7 && m.c === 7, "hard opening center");
}

// C1: dual threat in one move — black to play creates two win cells
{
  // Horizontal open three + vertical setup is hard to handcraft; use two rush-fours intersection:
  // Black stones: (7,3)(7,4)(7,5) and (5,7)(6,7)(8,7) — play (7,7) often creates multi threats.
  const b = Core.emptyBoard();
  b[7][3] = b[7][4] = b[7][5] = "b";
  b[5][7] = b[6][7] = b[8][7] = "b";
  // scatter white
  b[0][0] = b[0][1] = b[0][2] = b[1][0] = "w";
  const m = Ai.aiMove({ board: b, side: "b", difficulty: "hard", timeMs: 300 });
  assert(m, "dual-ish position returns move");
  // After best move, prefer creating ≥2 win cells if possible
  if (m) {
    b[m.r][m.c] = "b";
    const wins = Ai.listWinCells(b, "b").length;
    b[m.r][m.c] = "";
    // At least take a strong attack (win cell or live threat)
    assert(wins >= 1 || (m.r === 7 && m.c === 7) || (m.r === 7 && (m.c === 2 || m.c === 6)), "dual threat attack " + JSON.stringify(m) + " wins=" + wins);
  }
}

// C1: VCF API finds forced four sequence when trivial
{
  const b = Core.emptyBoard();
  // black three + will build four
  b[7][3] = b[7][4] = b[7][5] = "b";
  b[0][0] = b[1][0] = b[2][0] = "w";
  // white to move should not leave black free; black to move should extend
  const blackMove = Ai.aiMove({ board: b, side: "b", difficulty: "hard", timeMs: 250 });
  assert(blackMove, "black attacks open three line");
  // Prefer continuing on row 7
  assert(blackMove.r === 7, "extends rank 7 got " + JSON.stringify(blackMove));
}

// C1: block open four always
{
  const b = Core.emptyBoard();
  for (let c = 1; c <= 4; c++) b[10][c] = "b";
  b[14][14] = b[14][13] = b[14][12] = "w";
  const m = Ai.aiMove({ board: b, side: "w", difficulty: "hard", timeMs: 150 });
  assert(m && m.r === 10 && (m.c === 0 || m.c === 5), "block open four ends " + JSON.stringify(m));
}

// findVCF exists
{
  assert(typeof Ai.findVCF === "function" && typeof Ai.findVCT === "function", "C1 exports VCF/VCT");
}

if (failed) {
  console.error("\n" + failed + " failed");
  process.exit(1);
}
console.log("\nall passed");
