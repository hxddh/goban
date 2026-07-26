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
  const offenders = [];
  const jsDir = path.join(root, "src/web/js");
  for (const file of fs.readdirSync(jsDir)) {
    if (!file.endsWith(".js") || file === "i18n.js" || file === "worker-src.js") continue;
    const text = fs.readFileSync(path.join(jsDir, file), "utf8");
    text.split("\n").forEach((line, i) => {
      const code = codeOf(line);
      if (!CJK.test(code)) return;
      // string literals only — a Chinese identifier is impossible here
      const lits = code.match(/"[^"\n]*[\u4e00-\u9fa5][^"\n]*"/g) || [];
      for (const lit of lits) offenders.push(file + ":" + (i + 1) + " " + lit);
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
  const DYNAMIC = /^(diff|think|coach|status|result|practice\.kind)\./;
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
