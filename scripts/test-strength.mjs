/**
 * AI strength regression (self-play). Guards the v1.17 failure mode (mutual
 * pre-blocking full-board draws) and the C2 class gap over C1.
 * Run: node scripts/test-strength.mjs   (~20-60s; wired into package.sh)
 *
 * hard-vs-normal games use deterministic node budgets (opts.nodeBudget) so
 * outcomes are bit-reproducible regardless of CPU load. easy games are
 * inherently random and keep retry semantics.
 */
import fs from "fs";
import path from "path";
import vm from "vm";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");
const ctx = { console, Date, performance };
ctx.globalThis = ctx;
ctx.window = ctx;
vm.createContext(ctx);
for (const f of ["core.js", "ai.js", "ai2.js"]) {
  vm.runInContext(
    fs.readFileSync(path.join(root, "src/web/js", f), "utf8"),
    ctx,
    { filename: f }
  );
}
const Core = ctx.GobanCore;
const Ai = ctx.GobanAi;
const Ai2 = ctx.GobanAi2;

/** sideCfg: { eng, difficulty, timeMs?, nodeBudget? } */
function play(cfgB, cfgW, maxMoves) {
  const b = Core.emptyBoard();
  let turn = "b";
  let moves = 0;
  while (moves < maxMoves) {
    const cfg = turn === "b" ? cfgB : cfgW;
    const m = cfg.eng.aiMove({
      board: b,
      side: turn,
      difficulty: cfg.difficulty,
      timeMs: cfg.timeMs,
      nodeBudget: cfg.nodeBudget,
    });
    if (!m || b[m.r][m.c]) return { winner: "ERR", moves };
    b[m.r][m.c] = turn;
    moves++;
    if (Core.findWin(b, m.r, m.c, turn)) return { winner: turn, moves };
    if (Core.boardFull(b)) return { winner: "draw", moves };
    turn = Core.opp(turn);
  }
  return { winner: "none", moves };
}

let failed = 0;
function assert(cond, msg) {
  if (!cond) {
    failed++;
    console.error("FAIL:", msg);
  } else {
    console.log("ok:", msg);
  }
}

const C1HARD = { eng: Ai, difficulty: "hard", nodeBudget: 80000 };
const C1NORM = { eng: Ai, difficulty: "normal", nodeBudget: 8000 };
const C2HARD = { eng: Ai2, difficulty: "hard", nodeBudget: 80000 };

// Deterministic C1 gate: normal-difficulty engine must stay honest.
{
  const g = play(C1HARD, C1NORM, 100);
  assert(g.winner === "b", "DET C1hard(B,80k) beats C1normal(W,8k) — got " + g.winner + "/" + g.moves);
}

// Deterministic C2 gates — the class gap over C1.
{
  const g = play(C2HARD, C1NORM, 100);
  assert(g.winner === "b", "DET C2hard(B,80k) beats normal(W,8k) — got " + g.winner + "/" + g.moves);
}
{
  // The line C1 could never hold: C2 as white must not lose to normal-black.
  const g = play(C1NORM, C2HARD, 120);
  assert(
    g.winner !== "b" && g.winner !== "ERR",
    "DET C2hard(W,80k) holds normal(B,8k) — got " + g.winner + "/" + g.moves
  );
}

// Monotonicity guard: MORE search must not make C2 weaker. A forcing-extension
// bug once made deep search lose to shallow (1-5) — extreme played worse than
// hard. Deep (120k) must win the match vs shallow (40k) across both colors.
{
  const OPEN = [[[7, 7], [6, 8]], [[7, 7], [7, 8], [8, 7]], [[7, 7], [8, 8], [6, 6]]];
  const deep = { eng: Ai2, difficulty: "hard", nodeBudget: 120000 };
  const shallow = { eng: Ai2, difficulty: "hard", nodeBudget: 40000 };
  function playOpening(cfgB, cfgW, opening) {
    const b = Core.emptyBoard();
    let turn = "b";
    for (const [r, c] of opening) { b[r][c] = turn; turn = Core.opp(turn); }
    let moves = opening.length;
    while (moves < 160) {
      const cfg = turn === "b" ? cfgB : cfgW;
      const m = cfg.eng.aiMove({ board: b, side: turn, difficulty: cfg.difficulty, nodeBudget: cfg.nodeBudget });
      if (!m || b[m.r][m.c]) return "ERR";
      b[m.r][m.c] = turn;
      moves++;
      if (Core.findWin(b, m.r, m.c, turn)) return turn;
      if (Core.boardFull(b)) return "draw";
      turn = Core.opp(turn);
    }
    return "none";
  }
  let deepW = 0, shallowW = 0;
  for (const op of OPEN) {
    const g1 = playOpening(deep, shallow, op);
    if (g1 === "b") deepW++; else if (g1 === "w") shallowW++;
    const g2 = playOpening(shallow, deep, op);
    if (g2 === "w") deepW++; else if (g2 === "b") shallowW++;
  }
  assert(deepW >= shallowW, "MONOTONIC: deep(120k) not weaker than shallow(40k) — deep " + deepW + " shallow " + shallowW);
}

// easy is randomized: require a win within 2 attempts per side (app routing:
// hard = C2).
{
  const series = (label, cfgB, cfgW, want) => {
    const games = [];
    for (let i = 0; i < 2; i++) {
      const g = play(cfgB, cfgW, 100);
      games.push(g.winner + "/" + g.moves);
      if (g.winner === want) return assert(true, label + " — got " + games.join(" "));
    }
    assert(false, label + " — got " + games.join(" "));
  };
  const EASY = { eng: Ai, difficulty: "easy", timeMs: 30 };
  const HARD = { eng: Ai2, difficulty: "hard", timeMs: 600 };
  series("hard(B) beats easy(W) within 2 games", HARD, EASY, "b");
  series("hard(W) beats easy(B) within 2 games", EASY, HARD, "w");
}

if (failed) {
  console.error("\n" + failed + " strength check(s) failed");
  process.exit(1);
}
console.log("\nstrength ok");
