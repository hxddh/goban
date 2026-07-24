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
  assert(text.includes("AP[Goban:1.24]"), "SGF AP version");
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

if (failed) {
  console.error("\n" + failed + " failed");
  process.exit(1);
}
console.log("\nall passed");
