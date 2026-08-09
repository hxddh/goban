/**
 * Minimal Node tests for core + sgf (no DOM).
 * Run: node scripts/test-game.mjs
 */
import fs from "fs";
import os from "os";
import path from "path";
import vm from "vm";
import { execFileSync } from "child_process";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");
// REAL clocks: a Date.now-based performance shim once masked a clock-domain
// bug that hung the engine only in browsers.
const ctx = { console, Date, performance };
ctx.globalThis = ctx;
ctx.window = ctx;
vm.createContext(ctx);

function load(rel) {
  const code = fs.readFileSync(path.join(root, rel), "utf8");
  vm.runInContext(code, ctx, { filename: rel });
}

load("src/web/js/version.js");
load("src/web/js/i18n.js");
load("src/web/js/core.js");
load("src/web/js/sgf.js");
load("src/web/js/ai.js");
load("src/web/js/ai2.js");
load("src/web/js/state.js");

const Core = ctx.GobanCore;
const Sgf = ctx.GobanSgf;
const Ai = ctx.GobanAi;
const Ai2 = ctx.GobanAi2;
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

// sgf FF4 orientation: "aa" is the TOP-left corner (col, row from top)
{
  assert(Sgf.sgfCoord(0, 0) === "aa", "sgfCoord top-left aa");
  assert(Sgf.sgfCoord(14, 14) === "oo", "sgfCoord bottom-right oo");
  assert(Sgf.sgfCoord(0, 14) === "oa", "sgfCoord top-right oa");
  const p0 = Sgf.parseSgfCoord("aa");
  assert(p0 && p0.r === 0 && p0.c === 0, "parse aa = top-left");
  const p1 = Sgf.parseSgfCoord("ao");
  assert(p1 && p1.r === 14 && p1.c === 0, "parse ao = bottom-left");
}

// sgf: AB[] setup props and comment text must not read as moves
{
  const r = Sgf.parseSgf("(;FF[4]SZ[15]AB[hh]C[try B[ii] later];B[aa];W[bb])");
  assert(!r.error && r.history.length === 2, "AB/comment not moves " + JSON.stringify(r));
  assert(r.history[0].r === 0 && r.history[0].c === 0, "first move aa");
  assert(r.history[1].r === 1 && r.history[1].c === 1, "second move bb");
  const esc = Sgf.parseSgf("(;FF[4]SZ[15];B[aa]C[escaped \\] B[cc] more];W[bb])");
  assert(!esc.error && esc.history.length === 2, "escaped ] in comment " + JSON.stringify(esc));
}

// sgf: local-time filename shape
{
  const name = Sgf.fileNameFromDate(new Date(2026, 0, 2, 3, 4, 5).getTime());
  assert(name === "goban-20260102030405.sgf", "local filename " + name);
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

// import with a five MID-history (non-standard SGF continued past a win) must
// register as finished, not "playable" — a full-board scan, not last-move only
{
  const hist = [
    { r: 7, c: 0 }, { r: 0, c: 0 },
    { r: 7, c: 1 }, { r: 0, c: 1 },
    { r: 7, c: 2 }, { r: 0, c: 2 },
    { r: 7, c: 3 }, { r: 0, c: 3 },
    { r: 7, c: 4 },                 // black five at move 9
    { r: 5, c: 5 }, { r: 8, c: 8 }, // stray continuation
  ];
  const r = State.sessionFromHistory(hist, { mode: "ai", humanColor: "b" });
  assert(r.ok, "mid-win import ok");
  assert(r.session.result === "b", "mid-win detected as black win, got " + r.session.result);
  assert(r.session.importPaused === false, "mid-win not resumable");
  assert(!State.canContinuePlay(r.session), "no 续下 on decided position");
  // save/restore path must use the same full-board scan (last-move-only
  // would see white at 8,8 and wrongly reopen the game as "play")
  const board = Core.boardAfter(hist, hist.length);
  const outcome = State.resultFromBoard(board);
  assert(outcome.result === "b", "resultFromBoard mid-win for applySnapshot");
  assert(outcome.winLine && outcome.winLine.length >= 5, "resultFromBoard winLine");
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
  // The stamp used to be a hand-kept literal inside sgf.js and silently
  // drifted: v1.26.0 exported 棋谱 claiming 1.25.3. It now reads version.js,
  // which v1.30 also shows in the help dialog — so one bump feeds the
  // installer, the 棋谱 stamp and the UI, and this ties all three to app.zon.
  const appZon = fs.readFileSync(path.join(root, "app.zon"), "utf8");
  const appVersion = (appZon.match(/\.version\s*=\s*"([^"]+)"/) || [])[1];
  assert(!!appVersion, "app.zon version readable");
  assert(ctx.GOBAN_VERSION === appVersion,
    "version.js matches app.zon (" + appVersion + "), got " + ctx.GOBAN_VERSION);
  assert(text.includes("AP[Goban:" + appVersion + "]"),
    "SGF AP version matches app.zon (" + appVersion + "), got " +
      (text.match(/AP\[[^\]]*\]/) || ["none"])[0]);
  assert(!/AP\[Goban:\d/.test(fs.readFileSync(path.join(root, "src/web/js/sgf.js"), "utf8")),
    "sgf.js no longer hard-codes a version");
}

// sgf comment annotations (复盘 3.0): per-move C[] + root comment, ] escaped,
// and the result re-parses cleanly (comments ignored on import)
{
  const hist = [{ r: 7, c: 7 }, { r: 7, c: 8 }, { r: 8, c: 8 }];
  const text = Sgf.buildSgf({
    history: hist,
    result: "play",
    mode: "pvp",
    humanColor: "b",
    originalStartedAt: Date.UTC(2026, 0, 1),
    comments: { 1: "失着 · 漏防 [x]" },
    rootComment: "复盘评注 · 失着 黑0 白1",
  });
  assert(text.includes("C[复盘评注 · 失着 黑0 白1]"), "SGF root comment");
  assert(text.includes("\\]"), "SGF ] escaped in comment");
  const parsed = Sgf.parseSgf(text);
  assert(!parsed.error && parsed.history.length === 3, "annotated SGF re-parses: " + (parsed.error || ""));
  assert(parsed.history.every((p, i) => p.r === hist[i].r && p.c === hist[i].c), "annotated coords intact");
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

// forcedMove is strictly forced: a mere opponent live-two (potential live3)
// must NOT trigger a hard pre-block — that passivity drew won games (v1.17).
{
  const b = Core.emptyBoard();
  b[7][6] = b[7][7] = "b"; // black live two only
  b[2][2] = "w";
  assert(Ai.forcedMove(b, "w") == null, "no forced pre-block vs live two");
  // …but an existing live three still forces a block (extensions = compound4)
  const b2 = Core.emptyBoard();
  b2[7][5] = b2[7][6] = b2[7][7] = "b";
  b2[2][2] = "w";
  const f = Ai.forcedMove(b2, "w");
  assert(f && f.r === 7 && (f.c === 4 || f.c === 8), "live3 still forced " + JSON.stringify(f));
}

// C2: exports, block open four, take win, center opening
{
  assert(Ai2 && typeof Ai2.aiMove === "function", "GobanAi2 exports aiMove");
  const b = Core.emptyBoard();
  for (let c = 0; c < 4; c++) b[7][c] = "b";
  b[0][0] = "w";
  b[1][0] = "w";
  const blk = Ai2.aiMove({ board: b, side: "w", difficulty: "hard", timeMs: 300 });
  assert(blk && blk.r === 7 && blk.c === 4, "C2 blocks four " + JSON.stringify(blk));
  const b2 = Core.emptyBoard();
  for (let c = 0; c < 4; c++) b2[5][c] = "w";
  b2[0][0] = "b";
  const win = Ai2.aiMove({ board: b2, side: "w", difficulty: "hard", timeMs: 100 });
  assert(win && win.r === 5 && win.c === 4, "C2 takes win " + JSON.stringify(win));
  const b3 = Core.emptyBoard();
  const open = Ai2.aiMove({ board: b3, side: "b", difficulty: "extreme", timeMs: 50 });
  assert(open && open.r === 7 && open.c === 7, "C2 opening center " + JSON.stringify(open));
}

// real-clock budget adherence: a tactical midgame C2 move must respect its
// wall budget (guards the clock-domain hang class; generous grace for CI load)
{
  const b = Core.emptyBoard();
  const seq = [[7,7],[6,8],[8,6],[5,7],[9,5],[6,6],[9,8],[9,6],[10,5],[6,5],[8,8],[6,7]];
  seq.forEach((p, i) => { b[p[0]][p[1]] = i % 2 === 0 ? "b" : "w"; });
  const t0 = Date.now();
  const m = Ai2.aiMove({ board: b, side: "b", difficulty: "hard", timeMs: 300 });
  const dt = Date.now() - t0;
  assert(m && !b[m.r][m.c], "C2 budget move legal " + JSON.stringify(m));
  assert(dt < 5000, "C2 respects wall budget: " + dt + "ms for 300ms");
}

// findVCF exists
{
  assert(typeof Ai.findVCF === "function" && typeof Ai.findVCT === "function", "C1 exports VCF/VCT");
}

// C1.c: profile budgets (longer hard thinks)
{
  const pFast = Ai.profileFor("hard", { think: "fast" });
  const pDeep = Ai.profileFor("hard", { think: "deep" });
  const pNorm = Ai.profileFor("hard", { think: "normal" });
  assert(pFast.budgetMs === 800, "fast budget " + pFast.budgetMs);
  assert(pDeep.budgetMs === 3500, "deep budget " + pDeep.budgetMs);
  assert(pNorm.budgetMs === 2000, "normal hard budget " + pNorm.budgetMs);
  assert(pNorm.vctDepth >= 6 && pNorm.abDepth >= 7, "hard depths");
}

// C1.c: forced hierarchy
{
  // Black vertical will make four at 8,7 — white must stop that (tier ≥ four)
  const b = Core.emptyBoard();
  b[7][6] = b[7][7] = b[7][8] = "b";
  b[5][7] = b[6][7] = "b";
  b[0][0] = b[0][1] = b[0][2] = b[1][0] = b[2][0] = "w";
  const stop = Ai.aiMove({ board: b, side: "w", difficulty: "hard", timeMs: 200 });
  // Prefer stop black four-maker (8,7/4,7) or own rush-four (0,3/0,4)
  const okStop =
    stop &&
    ((stop.r === 8 && stop.c === 7) ||
      (stop.r === 4 && stop.c === 7) ||
      (stop.r === 0 && (stop.c === 3 || stop.c === 4)));
  assert(okStop, "tactical force " + JSON.stringify(stop));

  // pure live3 block: white has NO rush4 of its own (scattered stones)
  const b2 = Core.emptyBoard();
  b2[7][6] = b2[7][7] = b2[7][8] = "b";
  b2[0][0] = b2[2][4] = b2[14][14] = "w";
  const blk = Ai.aiMove({ board: b2, side: "w", difficulty: "hard", timeMs: 300 });
  assert(blk && blk.r === 7 && (blk.c === 5 || blk.c === 9), "force live3 block " + JSON.stringify(blk));

  // white own rush-four when black has only a weak shape
  const b3 = Core.emptyBoard();
  b3[0][0] = b3[0][1] = b3[0][2] = "w";
  b3[10][10] = "b";
  const rf = Ai.aiMove({ board: b3, side: "w", difficulty: "hard", timeMs: 150 });
  assert(rf && rf.r === 0 && (rf.c === 3 || rf.c === 4), "own rush4 " + JSON.stringify(rf));
}

// C1.b: block live three ends (white to move)
{
  const b = Core.emptyBoard();
  b[7][5] = b[7][6] = b[7][7] = "b";
  b[0][0] = b[1][0] = "w";
  const m = Ai.aiMove({ board: b, side: "w", difficulty: "hard", timeMs: 350 });
  assert(m && m.r === 7 && (m.c === 4 || m.c === 8), "block live3 " + JSON.stringify(m));
}

// C1.b: TT search returns legal empty cell midgame
{
  const b = Core.emptyBoard();
  const seq = [
    [7, 7],
    [7, 8],
    [8, 7],
    [8, 8],
    [6, 7],
    [6, 8],
    [9, 7],
    [5, 5],
  ];
  seq.forEach((p, i) => {
    b[p[0]][p[1]] = i % 2 === 0 ? "b" : "w";
  });
  const m = Ai.aiMove({ board: b, side: "b", difficulty: "hard", timeMs: 400 });
  assert(m && !b[m.r][m.c], "TT search legal " + JSON.stringify(m));
}

// P0: pattern table — live three / rush four flags
{
  const b = Core.emptyBoard();
  b[7][5] = b[7][6] = b[7][7] = "b";
  // white to place end of open three → should be live4 or rush4 for black at ends
  const end = Ai.analyzePlace(b, 7, 4, "b");
  assert(end.live4 >= 1 || end.rush4 >= 1 || end.live3 >= 1 || end.winCells >= 1, "pattern live/rush on open3 end " + JSON.stringify(end));

  // double live3 seed: horizontal three + vertical two-ready
  const b2 = Core.emptyBoard();
  b2[7][5] = b2[7][6] = b2[7][7] = "b";
  b2[5][7] = b2[6][7] = "b";
  // play 8,7 may create strong compound for black
  const mid = Ai.analyzePlace(b2, 8, 7, "b");
  assert(mid.tier >= 2 || mid.compound >= 1, "compound seed " + JSON.stringify(mid));
}

// P0: mustDefendPoints finds live3 ends
{
  const b = Core.emptyBoard();
  b[7][5] = b[7][6] = b[7][7] = "b";
  b[0][0] = "w";
  const pts = Ai.mustDefendPoints(b, "b");
  assert(pts.length >= 1, "mustDefend nonempty");
  const hasEnd = pts.some((p) => p.r === 7 && (p.c === 4 || p.c === 8));
  assert(hasEnd, "mustDefend includes open3 ends " + JSON.stringify(pts.slice(0, 5)));
}

// P0: double-live3 style attack preferred for black
{
  const b = Core.emptyBoard();
  // classic: build toward dual threats
  b[7][3] = b[7][4] = b[7][5] = "b";
  b[5][7] = b[6][7] = b[8][7] = "b";
  b[0][0] = b[0][1] = b[1][0] = "w";
  const m = Ai.aiMove({ board: b, side: "b", difficulty: "hard", timeMs: 400 });
  assert(m, "P0 attack moves");
  b[m.r][m.c] = "b";
  const after = Ai.analyzePlace(b, m.r, m.c, "b"); // already placed — re-analyze empty neighbor threat
  // ensure move is tactical on/near the structures
  const tactical =
    (m.r === 7 || m.c === 7) ||
    Ai.listWinCells(b, "b").length >= 1;
  assert(tactical, "P0 dual-ish tactical " + JSON.stringify(m));
  b[m.r][m.c] = "";
}

// --- 每日挑战: pure daily helpers from practice.js (no DOM touched) ---
load("src/web/js/practice.js");
const Practice = ctx.GobanPractice;

// deterministic date-seeded pick
{
  const cands = [];
  for (let i = 0; i < 9; i++) cands.push({ id: i });
  const a = Practice.daily.pickForDate(cands, "2026-07-23", 5);
  const b = Practice.daily.pickForDate(cands, "2026-07-23", 5);
  assert(JSON.stringify(a) === JSON.stringify(b), "daily pick deterministic for same date");
  assert(a.length === 5, "daily pick returns 5");
  assert(a.every((p) => cands.includes(p)), "daily pick is a subset of candidates");
  assert(new Set(a.map((p) => p.id)).size === 5, "daily pick has no duplicates");
  const c = Practice.daily.pickForDate(cands, "2026-07-24", 5);
  assert(JSON.stringify(a) !== JSON.stringify(c), "different date picks differently");
  const few = Practice.daily.pickForDate(cands.slice(0, 3), "2026-07-23", 5);
  assert(few.length === 3, "daily pick caps at pool size");
}

// --- 题库:130 道内建题,每一道都得真的有解 ---
//
// 这个模式整整 130 道题,而在此之前**没有任何测试碰过题面本身** —— 只有上面那组用
// 合成池(9 个 {id} 假题)测选取逻辑的用例。一道无解的题在界面上不会报错,它只是
// 永远判你答错:v1.43 的 SGF `RE` 字段是同一形状 —— 没人读的东西,错了也没人发现。
//
// 判据取自产品自己的两个纯函数(boardOf / solutionsFor),不另写一份解题器 ——
// 另写一份就是同义反复的近亲:两边都错的时候它照样绿。
{
  const { BUILTINS, boardOf, solutionsFor } = Practice.puzzles;
  const SIZE = 15;
  const bad = [];
  const kinds = {};
  for (let i = 0; i < BUILTINS.length; i++) {
    const q = BUILTINS[i];
    kinds[q.type] = (kinds[q.type] || 0) + 1;
    let board, sols;
    try {
      board = boardOf(q);
      sols = solutionsFor(board, q.side, q.type);
    } catch (e) {
      bad.push("#" + i + " 抛异常 " + e.message);
      continue;
    }
    if (!sols || !sols.length) { bad.push("#" + i + " (" + q.type + ") 无解"); continue; }
    for (const s of sols) {
      const r = s.r, c = s.c;
      if (!(r >= 0 && r < SIZE && c >= 0 && c < SIZE)) { bad.push("#" + i + " 解越界 " + r + "," + c); continue; }
      if (board[r][c]) bad.push("#" + i + " 解落在已有子上 " + r + "," + c);
    }
  }
  assert(bad.length === 0, "every builtin puzzle has a real solution (" + bad.slice(0, 3).join(" | ") + ")");
  assert(BUILTINS.length === 130, "puzzle bank is 130 (got " + BUILTINS.length + ")");
  assert(kinds.win1 === 50 && kinds.defend === 45 && kinds.vcf === 35,
    "puzzle mix stays 50/45/35 (got " + JSON.stringify(kinds) + ")");

  // 反证:把一道 win1 的成五点堵掉,它就该报无解。
  // 直接改 BUILTINS 会污染后面的用例,所以复制一份改。
  {
    const q = BUILTINS.find((x) => x.type === "win1");
    const board = boardOf(q);
    const sols = solutionsFor(board, q.side, q.type);
    const blocked = {
      type: q.type, side: q.side,
      b: q.b.slice(), w: q.w.slice(),
    };
    // 把所有解点都填上对方的子 —— 于是这道题不再有成五点
    const other = q.side === "b" ? "w" : "b";
    for (const s of sols) blocked[other].push([s.r, s.c]);
    const after = solutionsFor(boardOf(blocked), blocked.side, blocked.type);
    assert(sols.length > 0 && (!after || after.length === 0),
      "negative control: blocking every solution makes the puzzle unsolvable");
  }
}

// --- 每日挑战跑在**真题库**上,而不只是合成池 ---
// 上面那组用 9 个 {id} 假题验了选取算法;这里验它接到 130 道真题上之后,
// 同一天可重现、不同天真的换题。
{
  const pool = Practice.puzzles.BUILTINS;
  const idx = (sel) => sel.map((q) => pool.indexOf(q)).join(",");
  const days = ["2026-08-01", "2026-08-02", "2026-08-03", "2026-08-04",
                "2026-08-05", "2026-08-06", "2026-09-15", "2027-01-01"];
  const picks = days.map((d) => idx(Practice.daily.pickForDate(pool, d, 5)));
  assert(picks.every((p) => p.split(",").length === 5), "daily over the real bank picks 5");
  assert(idx(Practice.daily.pickForDate(pool, "2026-08-04", 5)) === picks[3],
    "daily over the real bank is repeatable for the same date");
  assert(new Set(picks).size === days.length,
    "daily over the real bank differs every day (" + new Set(picks).size + "/" + days.length + ")");
  assert(picks.every((p) => new Set(p.split(",")).size === 5),
    "daily over the real bank never repeats a puzzle within one day");
}

// check-in streak state machine
{
  let st = Practice.daily.advanceDaily(null, "2026-07-23", 4, 5);
  assert(st.streak === 1 && st.daysDone === 1 && st.bestStreak === 1, "first completion starts streak");
  const replay = Practice.daily.advanceDaily(st, "2026-07-23", 5, 5);
  assert(replay.streak === 1 && replay.daysDone === 1 && replay.lastScore === 4,
    "same-day replay never re-counts");
  st = Practice.daily.advanceDaily(st, "2026-07-24", 3, 5);
  assert(st.streak === 2 && st.bestStreak === 2 && st.daysDone === 2, "next day extends streak");
  st = Practice.daily.advanceDaily(st, "2026-07-27", 5, 5);
  assert(st.streak === 1 && st.bestStreak === 2 && st.daysDone === 3, "gap resets streak, keeps best");
  assert(Practice.daily.prevDayStr("2026-03-01") === "2026-02-28", "prevDay crosses month");
  assert(Practice.daily.prevDayStr("2026-01-01") === "2025-12-31", "prevDay crosses year");
}

// slots: persist must surface Host.storageSet failure (quota) — not always true
{
  load("src/web/js/host.js");
  // Replace storage with a quota-failing stub BEFORE loading slots
  let sets = 0;
  ctx.GobanHost.storageGet = () => "[]";
  ctx.GobanHost.storageSet = () => {
    sets++;
    return false; // quota / security — Host never throws
  };
  load("src/web/js/slots.js");
  const Slots = ctx.GobanSlots;
  const ok = Slots.add({ history: [{ r: 7, c: 7 }], result: "play", savedAt: Date.now() });
  assert(ok === false, "Slots.add reports false when storageSet fails");
  assert(sets >= 1, "Slots.add attempted a write");
}

// SGF: main line only — branches / multi-game collections must not stitch
{
  const branched = Sgf.parseSgf(
    "(;FF[4]SZ[15];B[aa];W[bb](;B[cc];W[dd])(;B[ee];W[ff]))"
  );
  assert(!branched.error, "branched sgf parses");
  assert(branched.history.length === 4, "branched takes first variation only (got " +
    branched.history.length + ")");
  assert(
    branched.history[2].r === 2 && branched.history[2].c === 2 &&
    branched.history[3].r === 3 && branched.history[3].c === 3,
    "branched first path is aa bb cc dd"
  );
  const twoGames = Sgf.parseSgf(
    "(;FF[4]SZ[15];B[aa];W[bb])(;FF[4]SZ[15];B[cc];W[dd])"
  );
  assert(!twoGames.error, "collection parses");
  assert(twoGames.history.length === 2, "collection takes first game only");
}

// mid-history five: last-move winLineAt misses; resultFromBoard catches
{
  function coord(r, c) {
    return String.fromCharCode(97 + c) + String.fromCharCode(97 + r);
  }
  const seq = [
    [7, 0, "b"], [8, 0, "w"], [7, 1, "b"], [8, 1, "w"], [7, 2, "b"],
    [8, 2, "w"], [7, 3, "b"], [8, 3, "w"], [7, 4, "b"], // black wins
    [0, 0, "w"], // continues after win
  ];
  let sgf = "(;SZ[15]";
  for (const [r, c, color] of seq) {
    sgf += ";" + (color === "b" ? "B" : "W") + "[" + coord(r, c) + "]";
  }
  sgf += ")";
  const parsed = Sgf.parseSgf(sgf);
  assert(parsed.history.length === 10, "mid-win continue length");
  assert(Core.winLineAt(parsed.history, parsed.history.length) === null,
    "winLineAt(end) null when last move is not the five");
  assert(Core.winLineAt(parsed.history, 9) != null, "winLineAt(9) finds black five");
  const board = Core.emptyBoard();
  parsed.history.forEach((m, i) => {
    board[m.r][m.c] = i % 2 === 0 ? "b" : "w";
  });
  const outcome = State.resultFromBoard(board);
  assert(outcome.result === "b" && outcome.winLine, "resultFromBoard finds mid-win");
}

// ---- 连珠禁手 ------------------------------------------------------------
// 判定进的是 core.js —— 引擎(ai.js / ai2.js)也从这里加载,所以这条闸门先钉住
// 一件事:findWin 的行为一个字没变。引擎的强度全建立在它上面,而 v1.53 之前
// 那四条确定性断言(b/23 · b/21 · w/32 · deep 4 shallow 2)就是拿它当地基的。
//
// 反证是两个方向的,这是 v1.49 立下的规矩:
//   「黑六连不算胜」要配「自由式下算胜」和「白六连在禁手下照样算胜」,
//   「这些点是禁手」要配「这些点不是禁手」。
// 少哪一半,闸门都会在把判定写死成常量的实现下照样绿。
{
  const mk = (cells) => {
    const b = Core.emptyBoard();
    for (const [col, list] of Object.entries(cells)) for (const [r, c] of list) b[r][c] = col;
    return b;
  };

  // ① findWin 没变:拿旧实现逐点比对随机盘面
  function oldFindWin(board, r, c, color) {
    const S = 15;
    for (const [dr, dc] of [[0, 1], [1, 0], [1, 1], [1, -1]]) {
      const a = Core.countDir(board, r, c, dr, dc, color);
      const b2 = Core.countDir(board, r, c, -dr, -dc, color);
      if (1 + a + b2 >= 5) {
        const line = [{ r, c }];
        let rr = r + dr, cc = c + dc;
        while (rr >= 0 && rr < S && cc >= 0 && cc < S && board[rr][cc] === color) { line.push({ r: rr, c: cc }); rr += dr; cc += dc; }
        rr = r - dr; cc = c - dc;
        while (rr >= 0 && rr < S && cc >= 0 && cc < S && board[rr][cc] === color) { line.push({ r: rr, c: cc }); rr -= dr; cc -= dc; }
        return line;
      }
    }
    return null;
  }
  let seed = 12345 >>> 0;
  const rng = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
  let compared = 0, drifted = 0;
  for (let g = 0; g < 200; g++) {
    const b = Core.emptyBoard();
    for (let k = 0; k < 60; k++) {
      const r = Math.floor(rng() * 15), c = Math.floor(rng() * 15);
      if (b[r][c]) continue;
      b[r][c] = k % 2 ? "w" : "b";
      for (const col of ["b", "w"]) {
        compared++;
        if (JSON.stringify(oldFindWin(b, r, c, col)) !== JSON.stringify(Core.findWin(b, r, c, col))) drifted++;
      }
    }
  }
  assert(compared > 10000, "findWin 比对样本够大(" + compared + " 次)");
  assert(drifted === 0, "findWin 的行为与 v1.53 逐点一致(" + compared + " 次比对,0 处不同)");
  // 反证:比对确实分得出不同的实现
  assert(JSON.stringify(oldFindWin(mk({ b: [[7, 3], [7, 4], [7, 5], [7, 6]] }), 7, 7, "b")) !==
    JSON.stringify(Core.findWinRule(mk({ b: [[7, 3], [7, 4], [7, 5], [7, 6], [7, 8]] }), 7, 7, "b", true)),
    "反证:比对不是恒等式(六连处两版给出不同结果)");

  // ② 禁手判定 —— 该禁的
  const forb = [
    ["长连", mk({ b: [[7, 2], [7, 3], [7, 4], [7, 6], [7, 7]] }), 7, 5, "overline"],
    ["双四", mk({ b: [[7, 4], [7, 5], [7, 6], [4, 7], [5, 7], [6, 7]] }), 7, 7, "double4"],
    ["双三", mk({ b: [[7, 5], [7, 6], [5, 7], [6, 7]] }), 7, 7, "double3"],
  ];
  for (const [name, bd, r, c, why] of forb) {
    assert(Core.renjuForbidden(bd, r, c) === why, "禁手:" + name + " 判为 " + why);
  }
  // ③ 反证 —— 不该禁的。少了这一半,`return "double3"` 也能过上面三条
  const okMoves = [
    ["空盘天元", mk({}), 7, 7],
    ["成五优先", mk({ b: [[7, 3], [7, 4], [7, 5], [7, 6]] }), 7, 7],
    ["五连压长连", mk({ b: [[7, 3], [7, 4], [7, 5], [7, 6], [3, 7], [4, 7], [5, 7], [6, 7], [8, 7]] }), 7, 7],
    ["单活三", mk({ b: [[7, 5], [7, 6]] }), 7, 7],
    ["眠三不算三", mk({ b: [[7, 5], [7, 6], [5, 7], [6, 7]], w: [[7, 4], [7, 8]] }), 7, 7],
    ["白方同形", mk({ w: [[7, 5], [7, 6], [5, 7], [6, 7]] }), 7, 7],
    ["已有子", mk({ b: [[7, 7]] }), 7, 7],
    // v1.54 首版的误判(Codex 评审逮到的):两条各自的四离落子点三格,天元碰都碰不到,
    // 却被算成双四 —— 因为判据量的是「过补进去那个空点的连子」,而那条五不含落子点。
    // 这一条与下面「碰不到就不算」那组,守的是同一件事:**误判会拦掉一手合法棋**。
    ["两条四都够不着", mk({ b: [[7, 0], [7, 1], [7, 2], [7, 3], [0, 7], [1, 7], [2, 7], [3, 7]] }), 7, 7],
    ["两条三都够不着", mk({ b: [[7, 1], [7, 2], [1, 7], [2, 7]] }), 7, 7],
    ["斜向两条四都够不着", mk({ b: [[0, 0], [1, 1], [2, 2], [3, 3], [0, 14], [1, 13], [2, 12], [3, 11]] }), 7, 7],
  ];
  for (const [name, bd, r, c] of okMoves) {
    assert(Core.renjuForbidden(bd, r, c) === null, "不禁:" + name);
  }

  // ④ 每一种 why 都真能出现,而且中英两本字典里都有话说 —— renju.blocked.* 是
  //    运行时拼出来的键,dead-key 闸门放行了它们,这里把那个洞补上
  const reasons = new Set(forb.map((x) => x[4]));
  assert(reasons.size === 3, "三种禁手原因都构造得出(" + [...reasons].join(",") + ")");
  const i18nSrc = fs.readFileSync(path.join(root, "src/web/js/i18n.js"), "utf8");
  const zhBlock = i18nSrc.slice(i18nSrc.indexOf("zh:"), i18nSrc.indexOf("en:"));
  const enBlock = i18nSrc.slice(i18nSrc.indexOf("en:"));
  for (const why of reasons) {
    const key = '"renju.blocked.' + why + '"';
    assert(zhBlock.includes(key) && enBlock.includes(key), "两本字典都有 " + key);
  }

  // ⑤ 全盘标点:该出现的点出现了,该干净的盘是干净的
  // 够不着的两条四:全盘一个禁手点都不该有(首版实测标出 (7,7) 一个)
  assert(Core.renjuForbiddenPoints(
    mk({ b: [[7, 0], [7, 1], [7, 2], [7, 3], [0, 7], [1, 7], [2, 7], [3, 7]] })).length === 0,
    "反证:两条够不着的四不该在盘上标出任何禁手点");
  const pts = Core.renjuForbiddenPoints(mk({ b: [[7, 5], [7, 6], [5, 7], [6, 7]] }));
  assert(pts.length === 1 && pts[0].r === 7 && pts[0].c === 7 && pts[0].why === "double3",
    "全盘标点找到那一个双三点(实得 " + JSON.stringify(pts) + ")");
  assert(Core.renjuForbiddenPoints(Core.emptyBoard()).length === 0, "反证:空盘没有禁手点");

  // ⑥ 规则版胜负 —— 四个方向都要,否则「黑永远不赢」也能过
  const six = mk({ b: [[7, 2], [7, 3], [7, 4], [7, 5], [7, 6], [7, 7]] });
  assert((Core.findWinRule(six, 7, 7, "b", false) || []).length === 6, "自由式:黑六连算胜");
  assert(Core.findWinRule(six, 7, 7, "b", true) === null, "禁手式:黑六连不算胜");
  const sixW = mk({ w: [[7, 2], [7, 3], [7, 4], [7, 5], [7, 6], [7, 7]] });
  assert((Core.findWinRule(sixW, 7, 7, "w", true) || []).length === 6, "禁手式:白六连照样算胜");
  const five = mk({ b: [[7, 3], [7, 4], [7, 5], [7, 6], [7, 7]] });
  assert((Core.findWinRule(five, 7, 7, "b", true) || []).length === 5, "禁手式:黑恰好五算胜");
  // 一个方向六、另一个方向五:不能因为先撞上六就说没赢
  const both = mk({ b: [[7, 2], [7, 3], [7, 4], [7, 5], [7, 6], [7, 7], [3, 7], [4, 7], [5, 7], [6, 7]] });
  assert((Core.findWinRule(both, 7, 7, "b", true) || []).length === 5, "禁手式:六与五并存时认出那条五");

  // ⑦ 规则要一路传到静态盘面判定 —— 这是导入/存档恢复走的那条路
  assert(State.resultFromBoard(six, false).result === "b", "resultFromBoard 自由式:黑六连是黑胜");
  assert(State.resultFromBoard(six, true).result === "play", "resultFromBoard 禁手式:黑六连不决出胜负");
  assert(State.resultFromBoard(sixW, true).result === "w", "反证:白六连在禁手式下仍是白胜");
  assert(Core.winLineAt([{ r: 7, c: 2 }, { r: 0, c: 0 }, { r: 7, c: 3 }, { r: 0, c: 1 },
    { r: 7, c: 4 }, { r: 0, c: 2 }, { r: 7, c: 5 }, { r: 0, c: 3 },
    { r: 7, c: 6 }, { r: 0, c: 4 }, { r: 7, c: 7 }], 11, true) === null,
    "winLineAt 认规则:黑第六子在禁手式下不判胜");

  // ⑧ SGF 写 RU[] —— 两档各写各的,且解析器不被自己写的东西噎住
  for (const [rule, want] of [["renju", "RU[Renju]"], ["free", "RU[Gomoku]"], [undefined, "RU[Gomoku]"]]) {
    const text = Sgf.buildSgf({ history: [{ r: 7, c: 7 }], result: "play", mode: "pvp", originalStartedAt: Date.now(), ruleSet: rule });
    assert(text.includes(want), "SGF ruleSet=" + rule + " 写出 " + want);
    assert(!Sgf.parseSgf(text).error, "SGF ruleSet=" + rule + " 自己解析得回来");
  }
  assert(!Sgf.buildSgf({ history: [{ r: 7, c: 7 }], result: "play", mode: "pvp", originalStartedAt: Date.now(), ruleSet: "renju" }).includes("RU[Gomoku]"),
    "反证:禁手档不会同时写出 RU[Gomoku]");

  // ⑨ 禁手标记在四套主题上都看得见。判据是 WCAG 1.4.11 的图形对象门槛 3:1
  //    —— 它不是文字,但它是一句规则声明,看不清等于没说。第一版四套全不合格
  //    (1.75 / 2.36 / 1.90 / 2.43),是截图先看出来的,数字是后补的。
  //    上界同样要守:标记比星位还重就成了棋子,而它是注记。
  {
    const drawSrc = fs.readFileSync(path.join(root, "src/web/js/draw.js"), "utf8");
    const themes = [...drawSrc.matchAll(/^    (\w+): \{$/gm)].map((m) => m[1]);
    const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
    const lum = ([r, g, b]) => {
      const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
      return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
    };
    const ratio = (a2, b2) => {
      const l1 = lum(a2), l2 = lum(b2);
      return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
    };
    const grab = (theme, key) => {
      const blk = drawSrc.slice(drawSrc.indexOf("    " + theme + ": {"));
      const m = blk.slice(0, blk.indexOf("\n    },")).match(new RegExp(key + ':\\s*"([^"]+)"'));
      return m ? m[1] : null;
    };
    let checked = 0;
    const bad = [];
    for (const th of themes) {
      const forbid = grab(th, "forbid");
      if (!forbid) { bad.push(th + " 没有 forbid 颜色"); continue; }
      const bgHex = grab(th, "paper") || grab(th, "boardMid");
      const starHex = grab(th, "star") || grab(th, "pencil");
      const p2 = forbid.match(/rgba?\(([^)]+)\)/)[1].split(",").map(Number);
      const alpha = p2[3] === undefined ? 1 : p2[3];
      const bg = hex(bgHex);
      const comp = p2.slice(0, 3).map((v, i) => Math.round(v * alpha + bg[i] * (1 - alpha)));
      const r2 = ratio(comp, bg);
      const rStar = ratio(hex(starHex), bg);
      checked++;
      if (r2 < 3) bad.push(th + " 禁手标记只有 " + r2.toFixed(2) + ":1");
      if (r2 > rStar) bad.push(th + " 禁手标记(" + r2.toFixed(2) + ")比星位(" + rStar.toFixed(2) + ")还重");
    }
    assert(checked === 4, "四套主题都量到了(" + checked + ")");
    assert(bad.length === 0, "禁手标记四套主题都过 3:1 且不重过星位 (" + bad.join("; ") + ")");
    // 反证:把 wood 换回第一版那个色,这条闸门必须报
    const weak = [150, 58, 44].map((v, i) => Math.round(v * 0.5 + hex("#d4a574")[i] * 0.5));
    assert(ratio(weak, hex("#d4a574")) < 3, "反证:第一版的 wood 标记色确实不合格(" +
      ratio(weak, hex("#d4a574")).toFixed(2) + ":1)");
  }

  // ⑩ 成本:判定挂在每一手上,不能把落子拖慢。基准是困难档 2000ms 的预算。
  {
    const bd = Core.emptyBoard();
    let turn = "b", s2 = 7 >>> 0;
    const rng2 = () => ((s2 = (s2 * 1664525 + 1013904223) >>> 0) / 4294967296);
    for (let k = 0; k < 40; k++) {
      const m = Ai2.aiMove({ board: bd, side: turn, difficulty: "normal", nodeBudget: 1200, vary: true, rng: rng2 });
      if (!m || bd[m.r][m.c]) break;
      bd[m.r][m.c] = turn; turn = Core.opp(turn);
    }
    Core.renjuForbiddenPoints(bd);
    const t0 = performance.now();
    for (let i = 0; i < 50; i++) Core.renjuForbiddenPoints(bd);
    const ms = (performance.now() - t0) / 50;
    assert(ms < 60, "全盘标点在 60ms 以内(实测 " + ms.toFixed(1) + "ms,每落一手算一次)");
  }
}

// stats: unrecordByEndedAt removes the matching entry (undo-after-win)
{
  load("src/web/js/host.js");
  const store = { "goban.v12.stats": "[]" };
  ctx.GobanHost.storageGet = (k) => (k in store ? store[k] : null);
  ctx.GobanHost.storageSet = (k, v) => {
    store[k] = v;
    return true;
  };
  ctx.GobanHost.storageRemove = (k) => {
    delete store[k];
  };
  load("src/web/js/stats.js");
  const Stats = ctx.GobanStats;
  const endedAt = 1_700_000_000_000;
  Stats.record({
    mode: "ai",
    difficulty: "normal",
    humanColor: "b",
    result: "b",
    moves: 9,
    durationMs: 1000,
    endedAt,
  });
  Stats.record({
    mode: "ai",
    difficulty: "normal",
    humanColor: "b",
    result: "w",
    moves: 12,
    durationMs: 2000,
    endedAt: endedAt + 1,
  });
  assert(Stats.aggregate().games === 2, "two stats recorded");
  assert(Stats.unrecordByEndedAt(endedAt) === true, "unrecord win entry");
  const a = Stats.aggregate();
  assert(a.games === 1, "one stats entry remains");
  assert(a.ai.normal.l === 1 && a.ai.normal.w === 0, "remaining entry is the loss");
  assert(Stats.unrecordByEndedAt(endedAt) === false, "already removed");

  // ---- 累计量不许因为明细被截断而缩水 ----
  //
  // 到 v1.43 为止面板上每个数字都是从那份**上限 200 条**的对局列表现算的,于是从第
  // 201 局起它悄悄变成「最近 200 局」,却仍然读作「一共」。有一个数字比停滞更糟:
  // 实测 12 连胜之后再输 200 局,「最佳连胜」读出 12 → 12 → **0** —— 那 12 局被挤出
  // 了存储。会遗忘的记录比没有记录更坏。
  //
  // 这条闸门跑在**超过上限**的规模上;判据是「列表已经装不下了,而累计量还对」。
  const S2 = ctx.GobanStats;
  ctx.GobanHost.storageRemove("goban.v12.stats");
  ctx.GobanHost.storageRemove("goban.v12.totals");
  const mk = (result, at) => ({
    mode: "ai", difficulty: "hard", humanColor: "b", result: result,
    moves: 50, durationMs: 60000, endedAt: at,
  });
  for (let i = 0; i < 12; i++) S2.record(mk("b", 2_000_000 + i));   // 12 连胜
  const peak = S2.aggregate();
  for (let i = 0; i < 200; i++) S2.record(mk("w", 3_000_000 + i));  // 再输 200 局
  const after = S2.aggregate();
  const listLen = JSON.parse(ctx.GobanHost.storageGet("goban.v12.stats")).length;
  assert(peak.bestStreak === 12, "12 连胜记到了 (" + peak.bestStreak + ")");
  assert(listLen === 200, "对局明细仍按上限截断 (" + listLen + " 条)");
  assert(after.bestStreak === 12,
    "最佳连胜不因明细被截断而倒退 (" + after.bestStreak + ")");
  assert(after.games === 212, "总局数继续累加 (" + after.games + ")");
  assert(after.totalMoves === 212 * 50, "总手数继续累加 (" + after.totalMoves + ")");
  assert(after.ai.hard.w === 12 && after.ai.hard.l === 200,
    "分难度胜负也是一辈子的账 (" + after.ai.hard.w + "/" + after.ai.hard.l + ")");
  {
    // 反证:拿 v1.43 那套「从列表现算」的算法跑同一份存储,应当报出 0。
    const arr = JSON.parse(ctx.GobanHost.storageGet("goban.v12.stats"));
    let run = 0, best = 0;
    for (const e of arr) {
      if (e.mode !== "ai") continue;
      if (e.result === e.humanColor) { run++; if (run > best) best = run; } else run = 0;
    }
    assert(best === 0, "反证:从截断后的列表现算,最佳连胜确实是 0 (" + best + ")");
    assert(arr.length === 200 && arr.length !== after.games,
      "反证:列表长度 " + arr.length + " 不等于真实局数 " + after.games);
  }
  // 撤回一局要把累计量减回去 —— 否则赢了再悔棋,总数就永远多一局。
  ctx.GobanHost.storageRemove("goban.v12.stats");
  ctx.GobanHost.storageRemove("goban.v12.totals");
  for (let i = 0; i < 3; i++) S2.record(mk("b", 4_000_000 + i));
  assert(S2.unrecordByEndedAt(4_000_002) === true, "撤回最新那局");
  const back = S2.aggregate();
  assert(back.games === 2 && back.totalMoves === 100 && back.curStreak === 2 &&
         back.ai.hard.w === 2, "撤回把局数/手数/当前连胜/胜场都减了回去");
  assert(back.bestStreak === 3,
    "最佳连胜是高水位,撤回不下调 (" + back.bestStreak + ")");
  ctx.GobanHost.storageRemove("goban.v12.stats");
  ctx.GobanHost.storageRemove("goban.v12.totals");

  // ---- 「清空」的可用状态要跟对局数走 ----
  // v1.39 修掉了「零对局时照样可点」,判据却写成 hasAny(= 有对局 **或** 有每日打卡)。
  // 于是「做过每日挑战、一局没下完」这个很常见的状态下按钮又活了:实测点下去、确认,
  // 正文一个字不变 —— clear() 根本不碰每日打卡。
  const statsSrc = fs.readFileSync(path.join(root, "src/web/js/stats.js"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  assert(/clearBtn\.disabled\s*=\s*a\.games\s*===\s*0/.test(statsSrc),
    "「清空」按不按得动只看对局数");
  assert(!/clearBtn\.disabled\s*=\s*!hasAny/.test(statsSrc),
    "不再拿 hasAny 当「清空」的判据（它把每日打卡也算了进去）");
  {
    const scan = (js) => /clearBtn\.disabled\s*=\s*!hasAny/.test(js);
    assert(scan("if (clearBtn) clearBtn.disabled = !hasAny;"), "清空闸门认得出 v1.43 那种判据");
    assert(!scan("if (clearBtn) clearBtn.disabled = a.games === 0;"), "清空闸门放过新判据");
  }
}

// --- 终局要把本局用时结算进去 (v1.45) ---
//
// nowElapsed() 在 result !== "play" 时直接返回 elapsedBaseMs,所以两行的先后要紧:
// 必须先累加、再置终局。反着写(v1.9 起就是反的)等于把本局用时整个丢掉 —— 实测一盘
// 走了 00:09 的棋,终局时钟跳回 00:00、统计记 durationMs = 0,于是「总时长」从来都是 0。
// 我在 v1.44 把这几个数改成累计量时没发现,因为探针里的 durationMs 是我自己造的。
{
  const appSrc = fs.readFileSync(path.join(root, "src/web/js/app.js"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  // 每个「置终局」的地方,elapsedBaseMs 的结算都必须排在它前面
  const ends = [...appSrc.matchAll(/result = (?:turn|"draw");/g)].map((m) => m.index);
  assert(ends.length === 2, "两处终局赋值都在 (" + ends.length + ")");
  const bad = ends.filter((i) => {
    const before = appSrc.slice(Math.max(0, i - 200), i);
    return !/elapsedBaseMs = nowElapsed\(\);[\s\S]{0,80}$/.test(before);
  });
  assert(bad.length === 0,
    "本局用时在置终局之前就结算了（" + bad.length + " 处没有）");
  {
    const scan = (js) => {
      const e = [...js.matchAll(/result = (?:turn|"draw");/g)].map((m) => m.index);
      return e.filter((i) => !/elapsedBaseMs = nowElapsed\(\);[\s\S]{0,80}$/
        .test(js.slice(Math.max(0, i - 200), i))).length;
    };
    assert(scan('result = turn;\n  elapsedBaseMs = nowElapsed();') === 1,
      "用时闸门认得出 v1.44 那个顺序（先置终局，用时就丢了）");
    assert(scan('elapsedBaseMs = nowElapsed();\n  startedAt = Date.now();\n  result = turn;') === 0,
      "用时闸门放过正确顺序");
  }
}

// --- 题库: every built-in must be solvable, and deep enough for 每日挑战 ---
{
  const Pz = Practice.puzzles;
  const N = Pz.BUILTINS.length;
  // At 8 built-ins the daily set re-served 3 of every 5 puzzles the next day.
  assert(N >= 40, "builtin puzzle bank has 40+ positions (" + N + ")");

  const broken = [];
  const byType = {};
  for (let i = 0; i < N; i++) {
    const def = Pz.BUILTINS[i];
    byType[def.type] = (byType[def.type] || 0) + 1;
    const board = Pz.boardOf(def);
    // no stone may sit twice, and the position must not be already won
    const stones = def.b.length + def.w.length;
    let placed = 0;
    for (let r = 0; r < 15; r++) for (let c = 0; c < 15; c++) if (board[r][c]) placed++;
    if (placed !== stones) { broken.push(i + ":重叠落点"); continue; }
    if (!Pz.makePuzzle(board, def.side, def.type, "内置")) broken.push(i + ":无解");
  }
  assert(broken.length === 0, "every builtin puzzle validates (" + broken.join(",") + ")");
  assert(byType.win1 > 0 && byType.defend > 0 && byType.vcf > 0,
    "bank covers all three types " + JSON.stringify(byType));

  // 每日挑战 must not keep re-serving the same handful: measure the real
  // day-over-day overlap the built-in bank produces over a month.
  const ids = Array.from({ length: N }, (_, i) => i);
  const days = [];
  for (let i = 0; i < 30; i++) {
    const d = new Date(2026, 0, 1 + i);
    const p = (n) => (n < 10 ? "0" + n : "" + n);
    days.push(d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()));
  }
  const picks = days.map((day) => Practice.daily.pickForDate(ids, day, 5));
  let overlap = 0;
  for (let i = 1; i < picks.length; i++) {
    overlap += picks[i].filter((x) => picks[i - 1].includes(x)).length;
  }
  const avg = overlap / (picks.length - 1);
  assert(avg <= 1, "daily set repeats ≤1 of 5 from the previous day (" + avg.toFixed(2) + ")");
}

// --- vcf puzzles: the solution must really force a win by continuous fours ---
{
  const Pz = Practice.puzzles;
  const vcfDefs = Pz.BUILTINS.filter((d) => d.type === "vcf");
  assert(vcfDefs.length >= 5, "bank has vcf puzzles (" + vcfDefs.length + ")");

  let checked = 0;
  const bad = [];
  for (const def of vcfDefs.slice(0, 6)) {
    const board = Pz.boardOf(def);
    const side = def.side, oppo = Core.opp(side);
    // A vcf position must not offer an immediate five to either side —
    // otherwise the objectively winning click is not in the solution set.
    if (Ai.listWinCells(board, side).length) { bad.push("有一步成五"); continue; }
    if (Ai.listWinCells(board, oppo).length) { bad.push("对方有一步成五"); continue; }
    const sol = Pz.solutionsFor(board, side, "vcf");
    if (!sol.length) { bad.push("无解"); continue; }
    for (const s of sol) {
      board[s.r][s.c] = side;
      const mine = Ai.listWinCells(board, side);
      const theirs = Ai.listWinCells(board, oppo);
      // the move must create a four (or two) and hand the opponent nothing
      if (!mine.length || theirs.length) bad.push("非强制手 " + s.r + "," + s.c);
      board[s.r][s.c] = "";
      checked++;
    }
  }
  assert(bad.length === 0, "vcf solutions are forcing fours (" + bad.slice(0, 4).join("; ") + ")");
  assert(checked > 0, "vcf solutions actually checked (" + checked + ")");

  // A cell that merely completes five is a win1 answer, never a vcf answer.
  const b2 = Core.emptyBoard();
  for (let c = 3; c <= 6; c++) b2[7][c] = "b";
  const vcfSol = Pz.solutionsFor(b2, "b", "vcf");
  assert(vcfSol.every((s) => !Core.wouldWin(b2, s.r, s.c, "b")),
    "vcf never marks an immediate five as its answer");
}

// --- 题库自带解集必须与现场推导完全一致（运行时信任、CI 证明） ---
{
  const Pz = Practice.puzzles;
  const mismatched = [];
  let checked = 0;
  for (const def of Pz.BUILTINS) {
    if (!def.sol) continue;
    const board = Pz.boardOf(def);
    const derived = Pz.solutionsFor(board, def.side, def.type)
      .map((s) => s.r + "," + s.c).sort().join(" ");
    const stored = def.sol.map((s) => s[0] + "," + s[1]).sort().join(" ");
    if (derived !== stored) mismatched.push(def.type + ":" + stored + " ≠ " + derived);
    checked++;
  }
  assert(checked > 0, "题库自带解集的条目存在 (" + checked + ")");
  assert(mismatched.length === 0,
    "自带解集与现场推导一致 (" + mismatched.slice(0, 2).join("; ") + ")");
}

// --- vcf 强制序列: the line shown to the player must really be forced ---
{
  const Pz = Practice.puzzles;
  const vcfDefs = Pz.BUILTINS.filter((d) => d.type === "vcf");
  const bad = [];
  const depths = [];
  for (const def of vcfDefs) {
    const board = Pz.boardOf(def);
    const side = def.side, oppo = Core.opp(side);
    const sols = Pz.solutionsFor(board, side, "vcf");
    for (let si = 0; si < sols.length; si++) {
      const s = sols[si];
      const line = Pz.forcedLine(board, side, s);
      if (!line.length) { bad.push("空序列"); continue; }
      if (line[0].r !== s.r || line[0].c !== s.c) bad.push("首手不符");
      // replay it: every one of my moves must make a four, every reply of
      // theirs must be the only legal answer, and the line must end in a win.
      const bd = board.map((row) => row.slice());
      let endsWon = false;
      for (const mv of line) {
        if (bd[mv.r][mv.c]) { bad.push("重叠落点"); break; }
        bd[mv.r][mv.c] = mv.color;
        if (mv.color === side) {
          if (Core.findWin(bd, mv.r, mv.c, side)) { endsWon = true; break; }
          const mine = Ai.listWinCells(bd, side);
          if (!mine.length) { bad.push("非冲四"); break; }
          if (Ai.listWinCells(bd, oppo).length) { bad.push("对方可抢先成五"); break; }
          if (mine.length >= 2) { endsWon = true; break; } // double four: no reply
        }
      }
      if (!endsWon) bad.push("未走成必胜");
      if (si === 0) depths.push(Pz.lineDepth(line, side)); // one sample per puzzle
    }
  }
  assert(bad.length === 0, "vcf 强制序列可复现且必胜 (" + bad.slice(0, 4).join("; ") + ")");

  // v1.26 shipped 9 of 12 vcf puzzles winnable by one double-four — a much
  // easier exercise than the "continuous fours" the task text promises.
  const deep = depths.filter((d) => d >= 3).length;
  assert(depths.length > 0 && deep >= Math.ceil(depths.length * 0.8),
    "多数 vcf 题需要 ≥3 手连续冲四 (" + deep + "/" + depths.length + ")");
}

// --- 练习进度 / 错题本: pure state machine ---
{
  const Pr = Practice.progress;
  const Pz = Practice.puzzles;
  const cands = Pz.BUILTINS.slice(0, 6).map((d) =>
    Pz.makePuzzle(Pz.boardOf(d), d.side, d.type, "内置")).filter(Boolean);
  assert(cands.length >= 4, "progress fixture built");

  const keys = cands.map((p) => Pr.puzzleKey(p));
  assert(new Set(keys).size === keys.length, "puzzleKey unique per position");
  assert(Pr.puzzleKey(cands[0]) === Pr.puzzleKey(cands[0]), "puzzleKey stable");

  let st = {};
  assert(Pr.unmastered(cands, st).length === 0, "nothing unmastered before answering");
  st = Pr.recordAnswer(st, keys[0], false, "2026-07-25");
  assert(Pr.unmastered(cands, st).length === 1, "a wrong answer enters 错题本");
  st = Pr.recordAnswer(st, keys[0], false, "2026-07-25");
  assert(st.items[keys[0]].wrong === 2 && st.items[keys[0]].n === 2, "counts accumulate");
  st = Pr.recordAnswer(st, keys[0], true, "2026-07-26");
  assert(Pr.unmastered(cands, st).length === 0, "getting it right clears it from 错题本");
  assert(st.items[keys[0]].wrong === 2, "past mistakes stay on the record");
  st = Pr.recordAnswer(st, keys[0], false, "2026-07-27");
  assert(Pr.unmastered(cands, st).length === 1, "missing it again re-enters 错题本");

  st = Pr.recordAnswer(st, keys[1], true, "2026-07-25");
  const sum = Pr.progressSummary(cands, st);
  assert(sum.total === cands.length && sum.seen === 2 && sum.mastered === 1 && sum.wrong === 1,
    "progress summary counts " + JSON.stringify(sum));

  // ordering: never-seen first, unmastered next, mastered last
  const seq = [0.0, 0.0, 0.0, 0.0, 0.0, 0.0];
  let i = 0;
  const rand = () => seq[i++ % seq.length];
  const ordered = Pr.orderPool(cands, st, rand);
  assert(ordered.length === cands.length, "orderPool keeps every puzzle");
  const bandOf = (p) => {
    const it = st.items[Pr.puzzleKey(p)];
    if (!it) return 0;
    return it.wrong > 0 && !it.ok ? 1 : 2;
  };
  const bands = ordered.map(bandOf);
  assert(bands.join("") === bands.slice().sort().join(""), "orderPool bands: 未做 → 错题 → 已掌握");

  // progress store had no ceiling while 统计 caps at 200 and 存档 at 30
  {
    const cap = Pr.capProgress;
    const mk = (n, kind) => {
      const items = {};
      for (let i = 0; i < n; i++) {
        items[kind + i] =
          kind === "wrong" ? { n: 1, wrong: 1, ok: false, last: "2026-01-01" }
          : kind === "fixed" ? { n: 2, wrong: 1, ok: true, last: "2026-01-02" }
          : { n: 1, wrong: 0, ok: true, last: "2026-01-03" };
      }
      return items;
    };
    const under = { items: mk(5, "clean") };
    assert(cap(under, 10) === under, "under the cap the state is untouched");

    const mixed = { items: Object.assign(mk(30, "clean"), mk(6, "wrong"), mk(4, "fixed")) };
    const trimmed = cap(mixed, 10);
    const keys = Object.keys(trimmed.items);
    assert(keys.length === 10, "capped to the limit (" + keys.length + ")");
    assert(keys.filter((k) => k.startsWith("wrong")).length === 6,
      "错题本 survives the trim (" + keys.filter((k) => k.startsWith("wrong")).length + "/6)");
    assert(keys.filter((k) => k.startsWith("fixed")).length === 4,
      "once-missed-now-fixed outrank clean passes");
    assert(keys.filter((k) => k.startsWith("clean")).length === 0,
      "clean passes are what gets dropped");
  }

  // the builtin half of the candidate list is built once and reused now, so a
  // caller writing to a board must not be able to poison every later open
  {
    const first = Pz.buildCandidates();
    const before = first[0].board.map((r) => r.join("")).join("");
    first[0].board[0][0] = "b";
    first[0].board[0][1] = "w";
    const second = Pz.buildCandidates();
    assert(second.length === first.length, "cached bank returns a stable count");
    assert(second[0].board.map((r) => r.join("")).join("") === before,
      "writing to a returned board cannot corrupt the cached bank");
  }
}

// --- whole-app backup / restore (v1.31) ---
{
  load("src/web/js/backup.js");
  const Backup = ctx.GobanBackup;

  const makeStore = (init) => {
    const map = new Map(Object.entries(init || {}));
    return {
      map,
      storageGet: (k) => (map.has(k) ? map.get(k) : null),
      storageSet: (k, v) => { map.set(k, v); return true; },
      storageRemove: (k) => { map.delete(k); },
    };
  };

  const full = {
    "goban.v12.slots": '[{"id":"a","name":"s"}]',
    "goban.v12.stats": '[{"result":"b"}]',
    "goban.v12.daily": '{"streak":3}',
    "goban.v12.practice": '{"items":{"x":{"n":1}}}',
    "goban.v12.lang": "en",
  };
  const src = makeStore(full);
  const text = Backup.serialize(src);
  const round = Backup.inspect(text);
  assert(round.ok, "a fresh backup validates");
  assert(round.keys.length === 5, "every present key is carried (" + round.keys.length + ")");
  assert(!text.includes('"goban.v12.save"'), "keys absent from storage are skipped");
  assert(JSON.parse(text).app === ctx.GOBAN_VERSION, "the backup records the app version");

  // restore onto a machine with different data
  const dst = makeStore({ "goban.v12.stats": '[{"result":"w"}]', "goban.v12.save": "{}" });
  const res = Backup.restore(dst, text);
  assert(res.ok && res.restored === 5, "restore reports what it wrote");
  for (const k of Object.keys(full)) {
    assert(dst.storageGet(k) === full[k], "restored " + k + " byte-for-byte");
  }
  // …and the key the backup did NOT carry is cleared, not left behind: a
  // half-restored profile is worse than either state on its own
  assert(dst.storageGet("goban.v12.save") === null, "keys missing from the backup are cleared");

  // a second round trip is a fixed point
  // \s* matters: JSON.stringify(…, 2) writes `"savedAt": 123`, and a regex
  // without it silently compares the timestamps too — which made this pass
  // only when both calls landed in the same millisecond.
  const noStamp = (j) => j.replace(/"savedAt":\s*\d+/, "");
  assert(noStamp(Backup.serialize(dst)) === noStamp(text), "backup → restore → backup is stable");

  // rejections, and nothing is touched when they happen
  const guard = makeStore(full);
  const before = JSON.stringify([...guard.map]);
  for (const [bad, why] of [
    ["not json at all", "parse"],
    ['{"format":"something-else","data":{}}', "format"],
    ['{"format":"goban-backup","formatVersion":99,"data":{"goban.v12.lang":"en"}}', "version"],
    ['{"format":"goban-backup","formatVersion":1,"data":{}}', "empty"],
    ['{"format":"goban-backup","formatVersion":1,"data":{"evil.key":"x"}}', "empty"],
  ]) {
    const r = Backup.restore(guard, bad);
    assert(!r.ok && r.error === why, "rejects " + why + " (" + (r.error || "accepted!") + ")");
  }
  assert(JSON.stringify([...guard.map]) === before, "a rejected file leaves storage untouched");

  // an older backup is still readable — that is the whole point of a backup
  const oldFile = JSON.stringify({
    format: "goban-backup", formatVersion: 1, app: "1.30.0",
    data: { "goban.v12.lang": "zh" },
  });
  const oldChk = Backup.inspect(oldFile);
  assert(oldChk.ok && oldChk.app === "1.30.0", "a backup from an older app version restores");

  assert(/^goban-backup-\d{14}\.json$/.test(Backup.fileName(Date.UTC(2026, 0, 2, 3, 4, 5))),
    "backup file name is timestamped — got " + Backup.fileName(Date.UTC(2026, 0, 2, 3, 4, 5)));

  // the key list must not drift from what the app actually stores
  const stored = new Set();
  for (const f of fs.readdirSync(path.join(root, "src/web/js"))) {
    if (!f.endsWith(".js")) continue;
    const srcText = fs.readFileSync(path.join(root, "src/web/js", f), "utf8");
    for (const m of srcText.matchAll(/"(goban\.v12\.[a-z]+)"/g)) stored.add(m[1]);
  }
  const missing = [...stored].filter((k) => Backup.KEYS.indexOf(k) < 0);
  assert(missing.length === 0, "backup covers every goban.v12.* key in the app (" + missing.join(",") + ")");
  assert(stored.has("goban.v12.totals"), "v1.44 的累计量确实是一个存储键（不然上面那条闸门什么都没守）");
  {
    const scan = (keys, list) => keys.filter((k) => list.indexOf(k) < 0);
    assert(scan(["goban.v12.totals"], ["goban.v12.stats"]).length === 1,
      "漏键闸门认得出没进备份清单的键");
    assert(scan(["goban.v12.totals"], Backup.KEYS).length === 0,
      "漏键闸门放过已进清单的键");
  }
}

// --- 存档满了不许静默挤掉 (v1.44) ---
//
// add() 是 unshift、persist() 是 slice(0, 30)，所以存第 31 个会删掉第 1 个。实测:
// 列表仍 30 条、最老的从「第1个」变成「第2个」、add() 返回 true、应用 toast「已保存」。
// 这些存档是用户亲手命名的,而这个应用清除存档要确认、恢复备份要确认。
// wouldEvict() 让调用方能先问；这里守的是「它确实报得出那一个」与「app.js 真的问了」。
{
  // slots.js 捕获的是它**加载那一刻**的 GobanHost 对象,而上面那个「配额失败」的用例
  // 给它装的是常量桩 storageGet: () => "[]"。后来 load("host.js") 换了一个新对象,
  // 真实存储装在新对象上,旧的那个仍挂着桩 —— 第一版闸门就跑在这个接了死桩的模块上,
  // 结果 wouldEvict() 永远读到空列表、永远返回 null,断言红得莫名其妙。
  // 这里重新装一次,让模块接上真实存储。
  load("src/web/js/host.js");
  const slotStore = {};
  ctx.GobanHost.storageGet = (k) => (k in slotStore ? slotStore[k] : null);
  ctx.GobanHost.storageSet = (k, v) => { slotStore[k] = String(v); return true; };
  ctx.GobanHost.storageRemove = (k) => { delete slotStore[k]; };
  load("src/web/js/slots.js");
  const Slots = ctx.GobanSlots;
  const snap = (n) => ({ v: 12, history: [{ r: 7, c: 7 }], turn: "w", result: "play",
    mode: "ai", difficulty: "hard", humanColor: "b", savedAt: 1_700_000_000_000 + n, __tag: n });
  assert(Slots.wouldEvict() === null, "空存档不报挤掉");
  for (let i = 1; i < Slots.MAX; i++) Slots.add(snap(i));
  assert(Slots.wouldEvict() === null, "差一个满时仍不报挤掉 (" + (Slots.MAX - 1) + " 个)");
  Slots.add(snap(Slots.MAX));
  const doomed = Slots.wouldEvict();
  assert(doomed && doomed.snap.__tag === 1,
    "满了之后报得出将被挤掉的正是最早那个 (" + (doomed && doomed.snap.__tag) + ")");
  ctx.GobanHost.storageRemove("goban.v12.slots");

  // app.js 必须先问再存 —— 只有 wouldEvict 存在而没人调，等于什么都没修。
  const appNoC2 = fs.readFileSync(path.join(root, "src/web/js/app.js"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  assert(/function saveCurrentAsSlot[\s\S]{0,600}?wouldEvict\(\)[\s\S]{0,400}?confirmNative\(/.test(appNoC2),
    "存档满时先经过确认框");
  {
    const has = (js) => /function saveCurrentAsSlot[\s\S]{0,600}?wouldEvict\(\)[\s\S]{0,400}?confirmNative\(/.test(js);
    assert(has("function saveCurrentAsSlot(){ const d=Slots.wouldEvict(); if(d) await confirmNative(x); }"),
      "确认闸门认得出问过的写法");
    assert(!has("function saveCurrentAsSlot(){ const ok = Slots.add(serialize()); }"),
      "确认闸门认得出 v1.43 那种直接存的写法");
  }
}

// --- review: the advantage curve has to carry information (v1.31) ---
// compute() is pure over injected deps, so it runs here without a DOM.
{
  load("src/web/js/review.js");
  const Review = ctx.GobanReview;

  const coachFacts = (pre, color, played) => {
    if (Core.wouldWin(pre, played.r, played.c, color)) return { grade: "best", text: "胜着" };
    if (Ai.listWinCells(pre, color).length) return { grade: "blunder", text: "错失胜着" };
    const a = pre.map((r) => r.slice());
    a[played.r][played.c] = color;
    if (Ai.listWinCells(a, Core.opp(color)).length) return { grade: "blunder", text: "漏防对手成五" };
    return null;
  };
  let gen = 0;
  const analyze = (hist) => {
    gen++;
    Review.init({
      getHistory: () => hist,
      getGameGen: () => gen,
      getViewIndex: () => 0,
      boardAfter: (n) => Core.boardAfter(hist, n),
      winLineAt: (n) => {
        const p = hist[n - 1];
        return p ? Core.findWin(Core.boardAfter(hist, n), p.r, p.c, (n - 1) % 2 === 0 ? "b" : "w") : null;
      },
      coachFacts,
      evaluateBoard: (b, me) => Ai.evaluateBoard(b, me),
    });
    Review.invalidate();
    return Review.compute();
  };

  // A game where black walks into a lost position: white builds an open row
  // while black answers on the far side of the board.
  const hist = [];
  for (let k = 0; k < 8; k++) {
    hist.push({ r: 0, c: k });        // black, doing nothing useful
    if (k < 7) hist.push({ r: 7, c: 4 + k }); // white, building
  }
  const d = analyze(hist);

  // The curve, measured on a QUIET game — scattered stones, no side with a
  // real shape, so nobody is winning and the curve has to say so. Through
  // v1.30 tanh(raw/1200) pinned anything past a modest advantage to exactly
  // ±1, so consecutive plies differed by 0.000 and the line sat at the rail.
  // (A mirrored build-up is not "level": once both sides own an open four the
  // position really is decided for whoever moves next.)
  const level = [[3, 3], [11, 3], [3, 6], [11, 6], [6, 9], [9, 9], [5, 4], [10, 4]]
    .map(([r, c]) => ({ r, c }));
  const dLevel = analyze(level);
  const distinct = new Set(dLevel.adv.map((v) => v.toFixed(3))).size;
  assert(distinct >= 4, "advantage curve takes several distinct values (" + distinct + "/" + dLevel.adv.length + ")");
  assert(dLevel.adv.every((v) => v >= -1 && v <= 1), "curve stays inside [-1,1]");
  const pinned = dLevel.adv.filter((v) => Math.abs(Math.abs(v) - 1) < 1e-9).length;
  assert(pinned === 0, "a level game never touches the rails (" + pinned + "/" + dLevel.adv.length + ")");
  // The sharpest statement of the v1.30 bug: consecutive plies were identical.
  // Measured across 91 plies of real games, 90 had a delta of exactly 0.000.
  const zeroDeltas = dLevel.adv.slice(1).filter((v, k) => Math.abs(v - dLevel.adv[k]) < 1e-9).length;
  assert(zeroDeltas === 0, "every ply moves the curve (" + zeroDeltas + " frozen of " + (dLevel.adv.length - 1) + ")");

  // …and the case that actually saturated. A live three is a good position,
  // not a won one — tanh(raw/1200) read it as 0.975, one step from the rail,
  // which left no room for the rest of the game to show anything. This is the
  // assertion that fails if the old curve ever comes back.
  const three = [[7, 5], [0, 0], [7, 6], [0, 1]].map(([r, c]) => ({ r, c }));
  const dThree = analyze(three);
  const atThree = dThree.adv[dThree.adv.length - 1];
  assert(atThree > 0.3 && atThree < 0.9,
    "a live three reads as an edge, not a win (" + atThree.toFixed(3) + ")");

  // blunders: at minimum the move that let white finish, and — the point of
  // the change — something earlier than that
  assert(d.blunders.length >= 2, "a lost game flags more than just the losing move (" + d.blunders.length + ")");
  const plies = d.blunders.map((b) => b.i);
  assert(plies.join(",") === plies.slice().sort((a, b) => a - b).join(","),
    "blunders are listed in playing order");
  assert(plies[0] < hist.length - 1, "the first flag is earlier than the final move (" + plies[0] + " of " + hist.length + ")");
  assert(d.summary.b + d.summary.w === d.blunders.length, "summary counts match the list");

  // a decided position still reads as decided
  assert(Math.abs(d.adv[d.adv.length - 1]) > 0.9, "a won game ends at the rail");

  // the cap: a long sloppy game must not paint the curve red
  const longHist = [];
  for (let k = 0; k < 14; k++) {
    longHist.push({ r: 14, c: k });
    longHist.push({ r: 6 + (k % 3), c: k });
  }
  const dl = analyze(longHist);
  assert(dl.blunders.length <= 8, "no more than 8 flags however loose the game (" + dl.blunders.length + ")");
}

// --- engine variety by board symmetry (v1.31) ---
// Through v1.30 the engine was deterministic above 简单: repeating an opening
// replayed the identical game (1 distinct game in 8 at 困难). Variety comes
// from symmetries the position ALREADY has, so the alternative is the same
// move in a mirrored frame and cannot be weaker.
{
  const empty = Core.emptyBoard();
  assert(Ai.stabilizer(empty).length === 8, "empty board has all 8 symmetries");

  const tengen = Core.emptyBoard();
  tengen[7][7] = "b";
  assert(Ai.stabilizer(tengen).length === 8, "a stone on 天元 keeps all 8");
  const orbit = Ai.symmetryOrbit(tengen, { r: 7, c: 6 }).map((m) => m.r + "," + m.c).sort();
  assert(orbit.join(" ") === "6,7 7,6 7,8 8,7",
    "orbit of a 天元 neighbour is the four orthogonals — got " + orbit.join(" "));
  assert(Ai.symmetryOrbit(tengen, { r: 7, c: 6 })[0].r === 7 &&
    Ai.symmetryOrbit(tengen, { r: 7, c: 6 })[0].c === 6,
    "the engine's own choice stays first in the orbit");

  // asymmetric position ⇒ nothing to vary, so play is untouched
  const skew = Core.emptyBoard();
  skew[7][7] = "b"; skew[5][9] = "w"; skew[3][4] = "b";
  assert(Ai.stabilizer(skew).length === 1, "an asymmetric position has only the identity");
  assert(Ai.symmetryOrbit(skew, { r: 8, c: 8 }).length === 1, "…so its orbit is a single move");

  // colours matter: a position that is only symmetric if you ignore colour
  // must NOT be treated as symmetric — the mirrored reply would be a
  // different move for a different player.
  const twoTone = Core.emptyBoard();
  twoTone[7][6] = "b"; twoTone[7][8] = "w";
  assert(!Ai.stabilizer(twoTone).some((f) => {
    const p = f(7, 6);
    return p.r === 7 && p.c === 8;
  }), "a symmetry that swaps colours is not a symmetry");

  // occupied points can never be offered as an alternative
  const filled = Core.emptyBoard();
  filled[7][7] = "b"; filled[6][7] = "w"; filled[8][7] = "w";
  for (const m of Ai.symmetryOrbit(filled, { r: 7, c: 6 })) {
    assert(!filled[m.r][m.c], "orbit never lands on an occupied point");
  }

  // vary:false is the old behaviour, exactly
  const fixed = Ai.varyBySymmetry(tengen, { r: 7, c: 6 }, { vary: false });
  assert(fixed.r === 7 && fixed.c === 6, "vary:false returns the engine's own move");
  // and an rng pinned to 0 also lands on it, which is what keeps the
  // deterministic suites reproducible
  const first = Ai.varyBySymmetry(tengen, { r: 7, c: 6 }, { rng: () => 0 });
  assert(first.r === 7 && first.c === 6, "rng()=0 selects the engine's own move");

  // the whole point: a repeated opening must not replay one game
  {
    const seen = new Set();
    for (let i = 0; i < 12; i++) {
      const b = Core.emptyBoard();
      b[7][7] = "b";
      const m = Ai.aiMove({ board: b, side: "w", difficulty: "normal", nodeBudget: 4000 });
      seen.add(m.r + "," + m.c);
    }
    assert(seen.size > 1, "a repeated opening no longer gives one fixed reply (" + seen.size + " seen)");
  }
}

// --- ui.js: helpers that were unreachable while they lived inside app.js ---
{
  // ui.js reads GobanCore.SIZE at load and otherwise only touches the DOM in
  // functions we do not call here, so it loads fine in the node context.
  load("src/web/js/ui.js");
  const Ui = ctx.GobanUi;
  assert(typeof Ui.formatDuration === "function", "GobanUi loaded");
  assert(Ui.formatDuration(0) === "00:00", "formatDuration zero");
  assert(Ui.formatDuration(59_000) === "00:59", "formatDuration under a minute");
  assert(Ui.formatDuration(60_000) === "01:00", "formatDuration a minute");
  assert(Ui.formatDuration(3_600_000) === "1:00:00", "formatDuration an hour");
  assert(Ui.formatDuration(3_661_000) === "1:01:01", "formatDuration hour+");
  assert(Ui.formatDuration(-5000) === "00:00", "formatDuration clamps negatives");
  const t = new Date(2026, 6, 25, 9, 5).getTime();
  assert(Ui.formatTime(t) === "07-25 09:05", "formatTime local, zero-padded — got " + Ui.formatTime(t));
}

// --- i18n: no user-visible Chinese may bypass the dictionary ---
{
  const I18n = ctx.GobanI18n;
  const zhKeys = Object.keys(I18n.DICT.zh);
  const enKeys = Object.keys(I18n.DICT.en);
  assert(zhKeys.length > 300, "dictionary has the full UI (" + zhKeys.length + " keys)");
  assert(
    zhKeys.filter((k) => !I18n.DICT.en[k]).length === 0 &&
      enKeys.filter((k) => !I18n.DICT.zh[k]).length === 0,
    "zh and en cover exactly the same keys"
  );
  // every {placeholder} in zh must exist in en, or a translated message would
  // silently drop a number
  const holes = [];
  for (const k of zhKeys) {
    const of = (s) => [...new Set(s.match(/\{(\w+)\}/g) || [])].sort().join(",");
    if (of(I18n.DICT.zh[k]) !== of(I18n.DICT.en[k])) holes.push(k);
  }
  assert(holes.length === 0, "placeholders match across languages (" + holes.join(",") + ")");

  // Source scan: the whole point is that adding a Chinese string later without
  // a dictionary entry breaks the build instead of silently shipping half a
  // translation. Comments are exempt; i18n.js is the dictionary itself.
  const CJK = /[\u4e00-\u9fa5]/;
  // The trailing \r matters: a Windows checkout is CRLF, so split("\n") leaves
  // "\u2026// comment\r" and `//.*$` cannot match it \u2014 `.` excludes \r, so the
  // comment survived stripping and three Chinese *comments* were reported as
  // literals. The v1.29.0 windows build failed on exactly that while ubuntu CI
  // stayed green; drop the \r before doing anything line-based.
  const codeOf = (line) =>
    line.replace(/\r$/, "").replace(/\/\/.*$/, "").replace(/^\s*\*.*$/, "");
  assert(!CJK.test(codeOf('  // do not cache as "\u6700\u4f73\u4e00\u624b".\r')),
    "comment stripping survives a CRLF checkout");
  // All three quote styles. Until v1.46 this matched double quotes only, and
  // that is exactly how two Chinese buttons shipped in the English UI: the
  // 存档 rows built 「读取」/「删除」 with innerHTML and *single* quotes, so the
  // gate never saw them \u2014 same content, two spellings, opposite verdicts.
  const litRe = /"[^"\n]*[\u4e00-\u9fa5][^"\n]*"|'[^'\n]*[\u4e00-\u9fa5][^'\n]*'|`[^`\n]*[\u4e00-\u9fa5][^`\n]*`/g;
  const scanLine = (code) => code.match(litRe) || [];
  // The gate's own negative controls: the single-quoted form is the one that
  // shipped, so it is the one that must not be allowed to go quiet again.
  assert(scanLine("x = '\u2265\u8bfb\u53d6'".replace("\u2265", '">')).length === 1,
    "gate sees single-quoted Chinese");
  assert(scanLine('x = ">\u8bfb\u53d6</button>"').length === 1, "gate sees double-quoted Chinese");
  assert(scanLine("x = `\u8bfb\u53d6`").length === 1, "gate sees backticked Chinese");
  assert(scanLine("x = plain + 1").length === 0, "gate stays quiet on Chinese-free code");
  /**
   * Strip comments file-wide, keeping line numbers.
   *
   * `codeOf` above is line-based: it drops `//\u2026` and lines whose first
   * non-space char is `*`. That leaves one-line block comments \u2014 and the
   * moment the literal scan below learned about single quotes it reported
   * practice.js's `/** 'free' (\u7ec3\u4e60) or 'daily' \u2026 *\/` as a shipped string.
   * Prose read as implementation: the fourth time in this repo, so the fix
   * belongs in the stripper.
   *
   * String-aware so a `//` inside a string survives. Regex literals are left
   * alone (not parsed) \u2014 the self-checks below pin the cases that matter.
   */
  function stripComments(text) {
    let out = "", i = 0, quote = null, line = false, block = false;
    while (i < text.length) {
      const c = text[i], d = text[i + 1];
      if (line) { if (c === "\n") { line = false; out += c; } i++; continue; }
      if (block) { if (c === "*" && d === "/") { block = false; i += 2; } else { if (c === "\n") out += c; i++; } continue; }
      if (quote) {
        if (c === "\\") { out += text.slice(i, i + 2); i += 2; continue; }
        if (c === quote) quote = null;
        out += c; i++; continue;
      }
      if (c === "/" && d === "/") { line = true; i += 2; continue; }
      if (c === "/" && d === "*") { block = true; i += 2; continue; }
      if (c === '"' || c === "'" || c === "`") { quote = c; out += c; i++; continue; }
      out += c; i++;
    }
    return out;
  }
  // Self-checks: it must erase comments, keep strings, and not lose line count.
  assert(stripComments("/** 'a' (\u7ec3\u4e60) */\nlet x = 1;").split("\n").length === 2,
    "stripComments keeps line numbering");
  assert(!CJK.test(stripComments("/** 'free' (\u7ec3\u4e60) or 'daily' (\u6bcf\u65e5\u6311\u6218) */")),
    "stripComments erases a one-line block comment");
  assert(CJK.test(stripComments("t('\u8bfb\u53d6');")), "stripComments keeps real string literals");
  assert(stripComments('a = "http://x";').includes("http://x"),
    "stripComments does not treat // inside a string as a comment");

  const offenders = [];
  const jsDir = path.join(root, "src/web/js");
  for (const file of fs.readdirSync(jsDir)) {
    if (!file.endsWith(".js") || file === "i18n.js" || file === "worker-src.js") continue;
    const text = stripComments(fs.readFileSync(path.join(jsDir, file), "utf8"));
    text.split("\n").forEach((line, i) => {
      const code = codeOf(line);
      if (!CJK.test(code)) return;
      // string literals only — a Chinese identifier is impossible here
      for (const lit of scanLine(code)) offenders.push(file + ":" + (i + 1) + " " + lit);
    });
  }
  assert(offenders.length === 0,
    "no Chinese string literals outside the dictionary (" + offenders.slice(0, 3).join(" | ") + ")");

  // index.html: every Chinese text node / title / aria-label must be tagged
  const html = fs.readFileSync(path.join(root, "src/web/index.html"), "utf8");
  const untagged = [];
  for (const m of html.matchAll(/<([a-z0-9]+)([^>]*)>([^<>]*[\u4e00-\u9fa5][^<>]*)</gi)) {
    if (!/data-i18n(=|\s|>)/.test(m[2]) && !/data-i18n-raw/.test(m[2])) {
      untagged.push(m[3].trim().slice(0, 20));
    }
  }
  for (const m of html.matchAll(/<[^>]*\b(title|aria-label)="[^"]*[\u4e00-\u9fa5][^"]*"[^>]*>/gi)) {
    if (!/data-i18n-(title|aria)/.test(m[0])) untagged.push("attr:" + m[1]);
  }
  assert(untagged.length === 0,
    "every Chinese string in index.html is tagged (" + untagged.slice(0, 4).join(" | ") + ")");
}

// --- the worker bundle the PACKAGED app actually runs ---------------------
// index.html loads js/worker-src.js, generated at build time. That file does
// not exist in src/web, so the browser suites 404 it and silently take
// engine.js's fetch fallback — i.e. every test to date has exercised a path
// the shipped app never uses (fetch() is rejected by the zero:// handler).
// This builds the real bundle and boots it the way a Worker would.
{
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "goban-wsrc-"));
  execFileSync(process.execPath, [path.join(root, "scripts/gen-worker-src.mjs"), outDir]);
  const bundle = fs.readFileSync(path.join(outDir, "worker-src.js"), "utf8");

  const holder = { window: {} };
  holder.globalThis = holder;
  vm.createContext(holder);
  vm.runInContext(bundle, holder, { filename: "worker-src.js" });
  const src = holder.window.GOBAN_WORKER_SRC;
  assert(typeof src === "string" && src.length > 1000, "worker bundle generated (" + (src || "").length + " bytes)");

  // In a Worker `self` IS the global, which is how the engine IIFEs find their
  // home — a context where the two differ would pass while the real one fails.
  const w = { console, Date, performance, postMessage() {} };
  w.self = w;
  w.globalThis = w;
  vm.createContext(w);
  vm.runInContext(src, w, { filename: "GOBAN_WORKER_SRC" });

  // Exactly what ai-worker.js's ping reports as `engines`: engine.js treats a
  // false there as a dead worker and degrades to the capped main-thread path.
  assert(!!(w.GobanAi && w.GobanAi2), "bundle boots both engines (what the ping checks)");
  assert(typeof w.GobanAi.aiMove === "function" && typeof w.GobanAi2.aiMove === "function",
    "both engines expose aiMove");
  assert(typeof w.onmessage === "function", "bundle installs the worker message handler");

  // The generator reads its file list out of engine.js rather than keeping a
  // copy; if that read ever silently returns the wrong thing, the assertions
  // above still catch it — this one just names the cause.
  const engineJs = fs.readFileSync(path.join(root, "src/web/js/engine.js"), "utf8");
  const declared = (engineJs.match(/const WORKER_SRC = \[([^\]]*)\]/) || [])[1] || "";
  const wanted = (declared.match(/"([^"]+)"/g) || []).map((s) => s.slice(1, -1).replace(/^js\//, ""));
  assert(wanted.length >= 3 && wanted.every((f) => bundle.includes(f.replace(".js", "")) || src.length > 0),
    "engine.js WORKER_SRC readable (" + wanted.join(",") + ")");

  // A module nobody loads fails silently — version.js would simply leave
  // GOBAN_VERSION undefined, and the 棋谱 stamp would read 0.0.0.
  const html = fs.readFileSync(path.join(root, "src/web/index.html"), "utf8");
  const tagged = new Set([...html.matchAll(/<script src="js\/([^"]+)"/g)].map((m) => m[1]));
  const workerOnly = new Set(wanted);
  const orphans = fs
    .readdirSync(path.join(root, "src/web/js"))
    .filter((f) => f.endsWith(".js") && !tagged.has(f) && !workerOnly.has(f));
  assert(orphans.length === 0, "every js module is loaded by index.html or the worker (" + orphans.join(",") + ")");

  // The mirror image of the orphan gate, and a costlier failure. Deleting a
  // button from index.html leaves `getElementById("collapse").onclick = …`
  // dereferencing null, which throws *during init* — so every handler bound
  // after that line never binds. The app still paints, so it looks fine; it
  // just does nothing. v1.32 shipped this for the length of one sidebar edit.
  // Only unguarded uses count: `const x = getElementById(…); if (x) …` is the
  // established way to mark an element as optional.
  const domIds = new Set([...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));
  const dangling = [];
  for (const f of fs.readdirSync(path.join(root, "src/web/js"))) {
    if (!f.endsWith(".js")) continue;
    const js = fs.readFileSync(path.join(root, "src/web/js", f), "utf8");
    for (const m of js.matchAll(/getElementById\(\s*"([^"]+)"\s*\)\s*\./g)) {
      if (!domIds.has(m[1])) dangling.push(f + " → #" + m[1]);
    }
  }
  assert(dangling.length === 0,
    "every unguarded getElementById target exists in index.html (" + dangling.join(", ") + ")");
  // Every dictionary key must be reachable. v1.32 deleted the sidebar
  // paragraph that read "拖入 .sgf 或粘贴棋谱" — drag-and-drop import kept
  // working (Host.onDropFiles), but the only thing that told anyone it existed
  // was gone, and sgf.dropHint sat in both dictionaries referenced by nobody.
  // A dead string is the fingerprint of a capability that lost its last door.
  const i18nSrc = fs.readFileSync(path.join(root, "src/web/js/i18n.js"), "utf8");
  const zhBlock = i18nSrc.slice(i18nSrc.indexOf("zh:"), i18nSrc.indexOf("en:"));
  const dictKeys = [...zhBlock.matchAll(/^\s*"([a-zA-Z0-9_.]+)":/gm)].map((m) => m[1]);
  let uses = fs.readFileSync(path.join(root, "src/web/index.html"), "utf8");
  for (const f of fs.readdirSync(path.join(root, "src/web/js"))) {
    if (f.endsWith(".js") && f !== "i18n.js") uses += "\n" + fs.readFileSync(path.join(root, "src/web/js", f), "utf8");
  }
  // Keys assembled at runtime (t("diff." + difficulty + ".full")) never appear
  // literally; they are covered by the suites that render those strings.
  // renju.blocked.* is assembled from the reason renjuForbidden returns; the
  // 禁手 gate below asserts every reason it can return has a string in **both**
  // dictionaries, which is the coverage this allowlist would otherwise drop.
  const DYNAMIC = /^(diff|think|coach|status|result|practice\.kind|renju\.blocked)\./;
  const deadKeys = dictKeys.filter((k) => !DYNAMIC.test(k) && !uses.includes('"' + k + '"'));
  const KNOWN_ORPHANS = ["slots.saved", "practice.src.game", "practice.src.builtin"];
  const fresh = deadKeys.filter((k) => !KNOWN_ORPHANS.includes(k));
  assert(fresh.length === 0, "no unreachable i18n strings (" + fresh.join(", ") + ")");
  assert(deadKeys.length <= KNOWN_ORPHANS.length,
    "the known-orphan list does not grow silently (" + deadKeys.join(", ") + ")");

  // ---- Engine-floor gates -------------------------------------------------
  // The browser regression runs in Chromium. The app runs in WKWebView (macOS)
  // and WebView2 (Windows), and its shipped Info.plist declares
  // LSMinimumSystemVersion 11.0 — a floor the SDK's packager hard-codes and
  // app.zon cannot override. Nothing in that suite can see a feature the CSS
  // uses that an older WebKit does not have; these two gates are the only
  // thing standing between the stylesheet and a whole platform generation.
  const cssSrc = fs.readFileSync(path.join(root, "src/web/styles.css"), "utf8");

  /** Declaration blocks, comments stripped: [{ sel, decls: ["prop: value"] }] */
  function cssBlocks(css) {
    const clean = css.replace(/\/\*[\s\S]*?\*\//g, "");
    const out = [];
    let depth = 0, selStart = 0, bodyStart = -1, sel = "";
    for (let i = 0; i < clean.length; i++) {
      if (clean[i] === "{") {
        if (depth === 0) { sel = clean.slice(selStart, i).trim(); bodyStart = i + 1; }
        depth++;
      } else if (clean[i] === "}") {
        depth--;
        if (depth === 0) {
          const body = clean.slice(bodyStart, i);
          // At-rules (@media/@supports) wrap further blocks — recurse instead.
          if (body.includes("{")) out.push(...cssBlocks(body));
          else out.push({ sel, decls: body.split(";").map((d) => d.trim()).filter(Boolean) });
          selStart = i + 1;
        }
      }
    }
    return out;
  }

  // Every color-mix() declaration needs a plain-colour declaration for the same
  // property EARLIER in the same rule. An engine that cannot parse color-mix
  // drops the later declaration and keeps the earlier one; without it the
  // property falls to its initial value. Simulated on the v1.37 stylesheet,
  // that cost five surfaces their background outright — the sidebar, the toast,
  // the swap2 bar, the badge and the theme-picker's selected state all computed
  // to rgba(0,0,0,0) — the switch's ON state became its OFF colour, and the
  // move list fell back to the UA's black button text on a near-black panel.
  const mixNoFallback = [];
  for (const blk of cssBlocks(cssSrc)) {
    const seen = new Set();
    for (const d of blk.decls) {
      const prop = d.slice(0, d.indexOf(":")).trim();
      if (!prop) continue;
      if (/color-mix\(/.test(d)) {
        // Custom properties accept any token sequence, so a preceding
        // declaration cannot shield them — they fail at substitution time and
        // compute to unset. @supports is the only cover; assert it separately.
        if (prop.startsWith("--")) {
          if (!/@supports not \([^{]*color-mix/.test(cssSrc)) {
            mixNoFallback.push(blk.sel + " { " + prop + " } 无 @supports 兜底");
          }
        } else if (!seen.has(prop)) {
          mixNoFallback.push(blk.sel + " { " + prop + " }");
        }
      } else {
        seen.add(prop);
      }
    }
  }
  assert(mixNoFallback.length === 0,
    "每条 color-mix 声明前都有同属性的纯色兜底 (" + mixNoFallback.join(", ") + ")");

  // Properties WebKit only ships prefixed. .side carried -webkit-backdrop-filter
  // from v1.9 while three other backdrop-filter rules — including .modal-bg,
  // the blur behind every dialog — did not: the author knew the prefix was
  // needed and the codebase drifted anyway.
  const PREFIXED = ["backdrop-filter", "user-select", "appearance", "mask-image"];
  const missingPrefix = [];
  for (const blk of cssBlocks(cssSrc)) {
    const props = blk.decls.map((d) => d.slice(0, d.indexOf(":")).trim());
    for (const p of PREFIXED) {
      if (props.includes(p) && !props.includes("-webkit-" + p)) {
        missingPrefix.push(blk.sel + " { " + p + " }");
      }
    }
  }
  assert(missingPrefix.length === 0,
    "WebKit 需要前缀的属性都成对出现 (" + missingPrefix.join(", ") + ")");

  // Negative controls against fabricated source, so they cannot go stale.
  {
    const bad = ".x { background: color-mix(in srgb, red 50%, blue); }";
    const good = ".x { background: red; background: color-mix(in srgb, red 50%, blue); }";
    const scanMix = (css) => cssBlocks(css).flatMap((b) => {
      const seen = new Set(); const hits = [];
      for (const d of b.decls) {
        const prop = d.slice(0, d.indexOf(":")).trim();
        if (/color-mix\(/.test(d)) { if (!seen.has(prop)) hits.push(prop); } else seen.add(prop);
      }
      return hits;
    });
    assert(scanMix(bad).length === 1, "color-mix 闸门认得出没有兜底的声明");
    assert(scanMix(good).length === 0, "color-mix 闸门放过有兜底的声明");
    const scanPre = (css) => cssBlocks(css).flatMap((b) => {
      const props = b.decls.map((d) => d.slice(0, d.indexOf(":")).trim());
      return PREFIXED.filter((p) => props.includes(p) && !props.includes("-webkit-" + p));
    });
    assert(scanPre(".y { backdrop-filter: blur(2px); }").length === 1,
      "前缀闸门认得出漏掉的 -webkit-");
    assert(scanPre(".y { -webkit-backdrop-filter: blur(2px); backdrop-filter: blur(2px); }").length === 0,
      "前缀闸门放过成对出现的声明");
  }

  // 练习棋盘不许自己算格距 —— 渲染和命中判定都必须走 GobanDraw.pitchFor。
  // v1.39.0 只把绘制改成共享规则,onBoardClick 还留着 pad = cssW*0.04 那套小数公式
  // (而且量的是含 1px 边框的边框盒),两者从此对不上:225 个交叉点中心仍判对,但判定
  // 边界相对渲染位置最多偏 1.48 CSS px。改之前两边是同一个错公式、互相抵消,是这次
  // 把它们拆开的 —— 而交叉闸门 Y 只盯渲染,看不见判定。源码层断言才拦得住。
  const pracRaw = fs.readFileSync(path.join(root, "src/web/js/practice.js"), "utf8");
  // 注释里会写出老公式来解释它为什么被换掉 —— 闸门扫的是代码,不是散文。
  const pracSrc = pracRaw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const ownPitch = [...pracSrc.matchAll(/[\w.]+\s*\*\s*0\.04\b/g)].map((m) => m[0]);
  assert(ownPitch.length === 0,
    "练习棋盘不自己算格距 (" + ownPitch.join(", ") + ")");
  assert((pracSrc.match(/pitchFor\(/g) || []).length >= 2,
    "绘制与命中判定都引用 pitchFor（实测 " + (pracSrc.match(/pitchFor\(/g) || []).length + " 处）");
  assert(/function onBoardClick[\s\S]{0,700}pitchFor\(/.test(pracSrc),
    "onBoardClick 用的是共享格距");
  {
    const scanPitch = (js) => [...js.matchAll(/[\w.]+\s*\*\s*0\.04\b/g)].length;
    assert(scanPitch("const pad = cssW * 0.04;") === 1, "自算格距闸门认得出老公式");
    assert(scanPitch("const g = D.pitchFor(px);") === 0, "自算格距闸门放过共享写法");
  }

  // 三块画布同一条 dpr 上限,且不许把 alpha 拼到颜色字符串后面。
  // 复盘曲线是最后一块自成一套的画布:此前 dpr 不封顶(实测 3× 时位图 1008×282,
  // 另两块都封在 2×),面积填充写成 `line + "22"` —— 四个主题的 --accent 恰好都是
  // hex 才没出事,写成 rgb() 或色名就拼出非法值,而 canvas 对非法 fillStyle 是
  // 静默忽略的:填充直接消失,不报任何错。这正是 v1.38 那类「引擎不认就整条丢掉」。
  const revRaw = fs.readFileSync(path.join(root, "src/web/js/review.js"), "utf8");
  const revSrc = revRaw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const concatAlpha = [...revSrc.matchAll(/\+\s*"[0-9a-fA-F]{2}"/g)].map((m) => m[0]);
  assert(concatAlpha.length === 0,
    "复盘曲线不把 alpha 拼到颜色后面 (" + concatAlpha.join(", ") + ")");
  for (const [file, label] of [["review.js", "复盘曲线"], ["practice.js", "练习棋盘"]]) {
    const js = fs.readFileSync(path.join(root, "src/web/js", file), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    if (!/devicePixelRatio/.test(js)) continue;
    assert(/Math\.min\(window\.devicePixelRatio \|\| 1, 2\)/.test(js),
      label + "的 dpr 与主棋盘同一条上限");
  }
  {
    const scan = (js) => [...js.matchAll(/\+\s*"[0-9a-fA-F]{2}"/g)].length;
    assert(scan('g.fillStyle = line + "22";') === 1, "拼接 alpha 闸门认得出老写法");
    assert(scan('g.fillStyle = line; g.globalAlpha = 0.13;') === 0, "拼接 alpha 闸门放过新写法");
  }

  // A stone may be rendered in exactly one place. Three copies of the disc
  // (board / hover preview / 推演 variation) each carried their own radius and
  // their own gradient stops, and they drifted the moment one of them changed:
  // v1.35 raised the board stone from 0.43 to 0.46 and left the other two at
  // 0.40, so for two releases the preview of a stone was 13% smaller than the
  // stone it previewed. Counting the gradient is what makes that structural —
  // a fourth copy cannot be added without this failing.
  const drawSrc = fs.readFileSync(path.join(root, "src/web/js/draw.js"), "utf8");
  const stoneGradients = (js) => (js.match(/createRadialGradient/g) || []).length;
  assert(stoneGradients(drawSrc) === 1,
    "exactly one place renders a stone gradient (found " + stoneGradients(drawSrc) + ")");
  // …and no call site may reinvent the radius as a literal.
  const radiusLits = [...drawSrc.matchAll(/step \* 0\.4\d*/g)].map((m) => m[0]);
  assert(radiusLits.length === 0,
    "no hard-coded stone radius outside STONE_R (" + radiusLits.join(", ") + ")");
  assert(/const STONE_R = 0\.\d+;/.test(drawSrc), "STONE_R is declared as the one radius");

  // ---- 声音：一个声部，且没有一个模式被落下 ----
  //
  // 同 STONE_R 那条一样的形状。playWin 里那六行 oscillator+gain 构造原本写了两遍;
  // 胜/负/和/答题各再抄一份就是六份,而它们一旦漂移就是「同一个应用里两种落子声」。
  // 所以 audio.js 里 createOscillator 只允许出现一次 —— 在 tone() 里。
  // ---- 棋谱的 RE 不许再声称「对手认输」 ----
  //
  // SGF 的 RE 第二段是**赢法**:`+R` = Resign、`+T` = 超时、`+F` = 判负,而 `B+`
  // 就是「黑胜,方式未指定」。这里一直写死 B+R / W+R —— 而这个应用没有认输功能
  // (全 src/ 搜 resign/认输,0 处命中),赢棋只有连五一种。导出的每一份棋谱都在对
  // 别的软件说假话。自己导入自己看不出来:解析器根本不读 RE,结果是从盘面重算的,
  // 所以这个字段唯一的读者在应用之外 —— 也从来没有测试碰过它。
  const sgfSrc = fs.readFileSync(path.join(root, "src/web/js/sgf.js"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const resignish = [...sgfSrc.matchAll(/"[BW]\+[RTF]"/g)].map((m) => m[0]);
  assert(resignish.length === 0,
    "棋谱不声称认输/超时/判负 (" + resignish.join(", ") + ")");
  assert(/"B\+"/.test(sgfSrc) && /"W\+"/.test(sgfSrc), "赢法未指定,写作 B+ / W+");
  {
    const scan = (js) => [...js.matchAll(/"[BW]\+[RTF]"/g)].length;
    assert(scan('result === "b" ? "B+R" : "W+R"') === 2, "认输闸门认得出 +R");
    assert(scan('result === "b" ? "B+" : "W+"') === 0, "认输闸门放过未指定赢法");
  }
  // 绊线:哪天真加了认输,这条会红,提醒把 RE 改回 +R —— 那时 B+R 才是诚实的。
  // 扫的是剥掉注释的代码:sgf.js 那段解释里就写着 "Resign",拿原文扫会把散文当实现
  // (v1.39.1 与 v1.42 的闸门各栽过一次,这是第三次,写的时候就该想到)。
  const srcAll = ["app.js", "sgf.js", "sgfio.js", "core.js", "ui.js"]
    .map((f) => fs.readFileSync(path.join(root, "src/web/js", f), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "")).join("\n");
  assert(!/\bresign/i.test(srcAll),
    "应用确实没有认输功能（有了就得回头把 RE 改回 +R）");

  // ---- 运动:一次性过渡只允许一条曲线,时长只允许定好的档 ----
  //
  // 收敛前实测 130 个过渡属性实例跑在 6 种时长上,缓动两条:应用自己的 --ease 用了
  // 63 次、浏览器默认的 ease 用了 67 次 —— 一多半动效没在用这个应用的曲线,且 18 个
  // 元素在一条规则里混着用。两条曲线逐点最大差 37.9 个百分点。
  // 交叉闸门从渲染侧兜;这里守源码:transition 里不许出现裸时长或裸曲线。
  const cssRaw = fs.readFileSync(path.join(root, "src/web/styles.css"), "utf8");
  const cssNoC = cssRaw.replace(/\/\*[\s\S]*?\*\//g, "");
  const transDecls = [...cssNoC.matchAll(/transition\s*:\s*([^;}]+)/g)].map((m) => m[1]);
  const rawDur = transDecls.filter((d) => /(^|[\s,])\.?\d+(\.\d+)?m?s\b/.test(d));
  assert(rawDur.length === 0,
    "过渡时长一律走 --dur-* (" + rawDur.slice(0, 2).join(" | ") + ")");
  const rawEase = transDecls.filter((d) =>
    /(^|[\s,])(ease|ease-in|ease-out|ease-in-out|linear|cubic-bezier)\b/.test(d));
  assert(rawEase.length === 0,
    "过渡曲线一律走 var(--ease) (" + rawEase.slice(0, 2).join(" | ") + ")");
  // 每个属性都要显式带曲线 —— 漏写就落回浏览器默认的 ease，正是收敛前那 67 次。
  const missingEase = transDecls.filter((d) =>
    d.split(",").some((part) => part.trim() && !/var\(--ease\)/.test(part)));
  assert(missingEase.length === 0,
    "过渡的每个属性都显式带曲线 (" + missingEase.slice(0, 2).join(" | ") + ")");
  // ---- 工具链:版本要有单一真源,且不许停在会被下架的那一档 ----
  //
  // v1.51 收敛前:`node-version: 22` 抄在 6 份工作流里、`version: 0.16.0` 抄在 3 份、
  // `actions/checkout@v4` 抄在 6 份 —— 跟样式表那套散值是同一种病,只是高了一层。
  // 而且不是「不够新」而是有到期日:那三个 v4 动作跑在 Node 20 上,GitHub 从
  // 2026-06-16 起 runner 已默认把 JS 动作切到 Node 24,Node 20 秋天从 runner 移除;
  // Node 22 本身也已于 2026-07-28 EOL。
  //
  // 判据故意不是「必须是最新大版本」—— 那条会在上游发 v8 的当天变红,而那不是这个
  // 仓库的缺陷。这里守的是两件不会随上游漂的事:①版本只许有一处真源;
  // ②不许停在已知会被下架的那一档(固定名单,不联网)。
  {
    const wfDir = path.join(root, ".github/workflows");
    const wfFiles = fs.readdirSync(wfDir).filter((f) => f.endsWith(".yml"));
    const wfs = wfFiles.map((f) => ({ f, t: fs.readFileSync(path.join(wfDir, f), "utf8") }));
    const stripYamlComments = (t) => t.split("\n").map((l) => l.replace(/(^|\s)#.*$/, "$1")).join("\n");

    // 覆盖:扫不到东西的闸门永远是绿的
    const usesLines = wfs.flatMap(({ f, t }) =>
      [...stripYamlComments(t).matchAll(/uses:\s*([^\s@]+)@(\S+)/g)].map((m) => ({ f, action: m[1], ref: m[2] })));
    assert(wfs.length >= 6, "工作流只扫到 " + wfs.length + " 份 —— 覆盖不足");
    assert(usesLines.length >= 10, "只扫到 " + usesLines.length + " 条 uses: —— 覆盖不足");

    // ① 单一真源:node 走 .nvmrc,zig 走 build.zig.zon 的 minimum_zig_version
    const litNode = wfs.filter(({ t }) => /\n\s*node-version:\s*\S/.test(stripYamlComments(t))).map((x) => x.f);
    assert(litNode.length === 0, "node 版本要走 .nvmrc,不许写死 (" + litNode.join(", ") + ")");
    const litZig = wfs.filter(({ t }) => /setup-zig@[^\n]*\n(\s*)with:\n\1\s+version:/.test(stripYamlComments(t))).map((x) => x.f);
    assert(litZig.length === 0, "zig 版本要走 build.zig.zon,不许写死 (" + litZig.join(", ") + ")");
    const nvmrc = fs.readFileSync(path.join(root, ".nvmrc"), "utf8").trim();
    assert(/^\d+$/.test(nvmrc), ".nvmrc 应当只写大版本号,实际是 " + JSON.stringify(nvmrc));
    const nodeMajor = Number(nvmrc);
    // 偶数才是 LTS 线;22 已 EOL(2026-07-28)
    assert(nodeMajor >= 24 && nodeMajor % 2 === 0,
      ".nvmrc 是 Node " + nodeMajor + " —— 要偶数(LTS)且 ≥ 24(22 已于 2026-07-28 EOL)");
    const zigPinned = fs.readFileSync(path.join(root, "build.zig.zon"), "utf8")
      .match(/\.minimum_zig_version\s*=\s*"([^"]+)"/);
    assert(zigPinned, "build.zig.zon 缺 minimum_zig_version —— 省略 setup-zig 的 version 就没有真源了");

    // ② 不许停在已知会被下架的那一档。名单是固定事实,不联网、不随上游发版漂。
    const nodeTwentyEra = { "actions/checkout": 4, "actions/setup-node": 4, "actions/upload-artifact": 4, "actions/download-artifact": 4 };
    const stale = usesLines.filter((u) => {
      const floor = nodeTwentyEra[u.action];
      if (floor == null) return false;
      const m = /^v(\d+)/.exec(u.ref);
      return m && Number(m[1]) <= floor;
    });
    assert(stale.length === 0,
      "这些动作停在跑 Node 20 的大版本上(秋天从 runner 移除):" +
      stale.map((x) => x.f + " " + x.action + "@" + x.ref).slice(0, 3).join(" | "));

    // ③ 同一个动作在所有工作流里必须同一个大版本 —— 参差是漂移的第一步
    const byAction = new Map();
    for (const u of usesLines) {
      const m = /^v(\d+)/.exec(u.ref);
      if (!m) continue;
      if (!byAction.has(u.action)) byAction.set(u.action, new Set());
      byAction.get(u.action).add(m[1]);
    }
    const split = [...byAction.entries()].filter(([, v]) => v.size > 1);
    assert(split.length === 0,
      "同一个动作钉了多个大版本:" + split.map(([a, v]) => a + " → v" + [...v].join(" / v")).join(" | "));

    // 反证:三条判据各自都得报,而正确的形状不许误报
    const fake = (t) => [{ f: "x.yml", t }];
    const litN = (ws) => ws.filter(({ t }) => /\n\s*node-version:\s*\S/.test(stripYamlComments(t))).length;
    assert(litN(fake("jobs:\n  a:\n    steps:\n      - with:\n          node-version: 22\n")) === 1,
      "单一真源闸门认得出写死的 node 版本");
    assert(litN(fake("jobs:\n  a:\n    steps:\n      - with:\n          node-version-file: .nvmrc\n")) === 0,
      "单一真源闸门放过 node-version-file");
    assert(litN(fake("      # node-version: 22 是老写法\n      - uses: x@v7\n")) === 0,
      "单一真源闸门不把注释里的写法当成实现");
    const staleN = (action, ref) => {
      const floor = nodeTwentyEra[action];
      const m = /^v(\d+)/.exec(ref);
      return floor != null && m && Number(m[1]) <= floor ? 1 : 0;
    };
    assert(staleN("actions/checkout", "v4") === 1, "下架名单认得出 checkout@v4");
    assert(staleN("actions/checkout", "v7") === 0, "下架名单放过 checkout@v7");
    assert(staleN("mlugg/setup-zig", "v2") === 0, "下架名单不误伤名单外的动作");
  }

  // ---- 字号与圆角:一律走 token,源码里不许出现裸值 ----
  //
  // v1.50 收敛前实测:样式表里 44 条 font-size 全是字面量、零个 token
  // (13px×17 / 12px×16 / 11px×7 / 16px×3 —— 13 和 12 差 1px,那不是层级,
  // 是 33 次各自为政);圆角明明有 --radius-sm/md/lg,却被绕开 14 次
  // (裸 6px×7 vs var(--radius-sm)×1,裸 10px×7 vs var(--radius-md)×1)。
  // 颜色早就全走 var(--text)/var(--muted) —— 散的只有这两样。
  //
  // 例外只有形状,不含尺度:999px / 50% 是「胶囊」和「圆」,不是圆角档;
  // font-size: 0 是主题色板刻意隐藏文字(v1.45),只此一处。
  {
    const decls = (css, prop) =>
      [...css.matchAll(new RegExp(prop + "\\s*:\\s*([^;}]+)", "g"))].map((m) => m[1].trim());
    const badFs = (css) =>
      decls(css, "font-size").filter((v) => v !== "0" && !/^var\(--fs-[a-z]+\)$/.test(v));
    const badRad = (css) =>
      decls(css, "border-radius").filter(
        (v) => !/^(0|50%|999px|var\(--radius-[a-z]+\)|calc\(var\(--radius-[a-z]+\)[^)]*\)\s*)$/.test(v.trim()));

    const fsAll = decls(cssNoC, "font-size");
    const radAll = decls(cssNoC, "border-radius");
    // 覆盖数:扫不到东西的闸门永远是绿的。这两条比收敛后的实际条数低一档,
    // 只在「选择器被大改 / 扫描器坏掉」时才触发。
    assert(fsAll.length >= 30, "字号闸门只扫到 " + fsAll.length + " 条声明 —— 覆盖不足,这条闸门测不到东西");
    assert(radAll.length >= 15, "圆角闸门只扫到 " + radAll.length + " 条声明 —— 覆盖不足,这条闸门测不到东西");
    assert(badFs(cssNoC).length === 0,
      "字号一律走 var(--fs-*) (" + badFs(cssNoC).slice(0, 3).join(" | ") + ")");
    assert(badRad(cssNoC).length === 0,
      "圆角一律走 var(--radius-*) (" + badRad(cssNoC).slice(0, 3).join(" | ") + ")");

    // 反证:两个方向都得报。裸值要报,token 不许误报,注释里的裸值不算实现
    // —— 最后这条是第五次防同一个坑(散文被当成代码)。
    assert(badFs(".a { font-size: 14px; }").length === 1, "字号闸门认得出裸值");
    assert(badFs(".a { font-size: var(--fs-body); }\n.b { font-size: 0; }").length === 0,
      "字号闸门放过 token 与刻意的 0");
    assert(badFs("/* 收敛前是 font-size: 13px */\n.a { font-size: var(--fs-body); }"
      .replace(/\/\*[\s\S]*?\*\//g, "")).length === 0,
      "字号闸门不把注释里的裸值当成实现");
    assert(badRad(".a { border-radius: 10px; }").length === 1, "圆角闸门认得出裸值");
    assert(badRad(".a { border-radius: var(--radius-md); }\n.b { border-radius: 999px; }\n"
      + ".c { border-radius: 50%; }\n.d { border-radius: calc(var(--radius-sm) - 2px); }").length === 0,
      "圆角闸门放过 token 与形状值");
  }

  {
    const scan = (css) => {
      const ds = [...css.matchAll(/transition\s*:\s*([^;}]+)/g)].map((m) => m[1]);
      return {
        dur: ds.filter((d) => /(^|[\s,])\.?\d+(\.\d+)?m?s\b/.test(d)).length,
        bare: ds.filter((d) => /(^|[\s,])(ease|linear|cubic-bezier)\b/.test(d)).length,
        miss: ds.filter((d) => d.split(",").some((p) => p.trim() && !/var\(--ease\)/.test(p))).length,
      };
    };
    const before = scan("a { transition: background .15s var(--ease), opacity .15s; }");
    assert(before.dur === 1 && before.miss === 1, "运动闸门认得出裸时长与漏写的曲线");
    const beforeBare = scan("a { transition: background .25s ease; }");
    assert(beforeBare.bare === 1, "运动闸门认得出裸曲线");
    const after = scan("a { transition: background var(--dur-ui) var(--ease); }");
    assert(after.dur === 0 && after.bare === 0 && after.miss === 0, "运动闸门放过收敛后的写法");
  }

  const audRaw = fs.readFileSync(path.join(root, "src/web/js/audio.js"), "utf8");
  const audSrc = audRaw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const oscN = (audSrc.match(/createOscillator\(\)/g) || []).length;
  assert(oscN === 1, "audio.js 只有一个声部（createOscillator 实测 " + oscN + " 处）");
  assert(/function tone\(/.test(audSrc), "那个声部叫 tone()");

  // 练习(130 题)+ 每日是一整个模式,而它到 v1.41 为止对 GobanAudio 的引用数是 0:
  // 主棋盘落一子排 4 个音频节点,练习棋盘排 0 个 —— 与 v1.39 那次「练习自带一块
  // 棋盘」同一个形状。扫的是剥掉注释之后的代码:上面那段解释里就写着 GobanAudio,
  // 拿原文扫会把散文当成实现(v1.39.1 的闸门栽过同一个坑)。
  const pracNoC = fs.readFileSync(path.join(root, "src/web/js/practice.js"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  assert(/GobanAudio/.test(pracNoC), "练习模式接着声音（不是只在注释里提到）");
  assert(/playAnswer\(/.test(pracNoC), "答对/答错有听觉反馈");

  // 结束音必须经过 playEndSound —— 它是唯一知道「谁是用户」的地方。新增一种
  // 结束方式而忘了配音,就是 v1.41 之前和局的样子:三种结局里唯一无声的一种。
  const appNoC = fs.readFileSync(path.join(root, "src/web/js/app.js"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const endCalls = [...appNoC.matchAll(/Audio2\.playEnd\(/g)].length;
  assert(/function playEndSound[\s\S]{0,400}?playEnd\("draw"\)[\s\S]{0,200}?playEnd\("loss"\)/.test(appNoC),
    "playEndSound 里赢/输/和三条都在");
  {
    // recordGameEnd() 标记「一局结束了」。除定义处外，每个调用点附近都必须配音。
    const sites = [...appNoC.matchAll(/recordGameEnd\(\);/g)].map((m) => m.index);
    const unvoiced = sites.filter((i) => !/playEndSound\(/.test(appNoC.slice(i, i + 260)));
    assert(sites.length >= 2 && unvoiced.length === 0,
      "每个对局结束点都配了音（" + sites.length + " 处，缺 " + unvoiced.length + " 处）");
    assert(endCalls === 3, "结束音只从 playEndSound 发出（playEnd 调用实测 " + endCalls + " 处）");
  }
  {
    // 反证跑在构造出来的源码上,不会随实现变化失效。
    const cnt = (js) => (js.match(/createOscillator\(\)/g) || []).length;
    assert(cnt("const a=c.createOscillator();\nconst b=c.createOscillator();") === 2,
      "一个声部闸门数得出第二份拷贝");
    const voiced = (js) => {
      const s = [...js.matchAll(/recordGameEnd\(\);/g)].map((m) => m.index);
      return s.filter((i) => !/playEndSound\(/.test(js.slice(i, i + 260))).length;
    };
    assert(voiced("recordGameEnd();\n      sync();") === 1, "结束配音闸门认得出漏配的结局");
    assert(voiced("recordGameEnd();\n      playEndSound(turn);") === 0, "结束配音闸门放过配了音的结局");
    const noC = (js) => js.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    assert(!/GobanAudio/.test(noC("  // 走同一个 GobanAudio,所以开关是一处真源。\n  const x = 1;")),
      "接声音闸门不把注释里的 GobanAudio 当成实现");
  }

  // Negative controls, run against fabricated source so they cannot go stale:
  // the matcher must flag the unguarded form and must not flag the guarded one.
  assert(stoneGradients("a.createRadialGradient(1);\nb.createRadialGradient(2);") === 2,
    "stone-gradient gate counts a second copy of the stone painter");
  assert([...("const rr = step * 0.4;").matchAll(/step \* 0\.4\d*/g)].length === 1,
    "stone-radius gate flags a re-hard-coded radius");
  const scan = (js, ids) =>
    [...js.matchAll(/getElementById\(\s*"([^"]+)"\s*\)\s*\./g)].filter((m) => !ids.has(m[1])).length;
  assert(scan('document.getElementById("gone").onclick = f;', new Set()) === 1,
    "dangling-id gate flags an unguarded reference to a deleted element");
  assert(scan('const e = document.getElementById("gone");\nif (e) e.onclick = f;', new Set()) === 0,
    "dangling-id gate allows the guarded optional-element idiom");

  fs.rmSync(outDir, { recursive: true, force: true });
}

if (failed) {
  console.error("\n" + failed + " failed");
  process.exit(1);
}
console.log("\nall passed");
