/**
 * AI strength regression (self-play). Guards against the v1.17 failure mode
 * where hard-vs-normal locked into mutual pre-blocking and drew a full board.
 * Run: node scripts/test-strength.mjs   (~20-60s; wired into package.sh)
 *
 * hard-vs-normal games use deterministic node budgets (opts.nodeBudget =
 * analyzePlace count) so outcomes are bit-reproducible regardless of CPU
 * load. easy games are inherently random and keep retry semantics.
 */
import fs from "fs";
import path from "path";
import vm from "vm";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");
const ctx = { console, performance: { now: () => Date.now() } };
ctx.globalThis = ctx;
ctx.window = ctx;
vm.createContext(ctx);
for (const f of ["core.js", "ai.js"]) {
  vm.runInContext(
    fs.readFileSync(path.join(root, "src/web/js", f), "utf8"),
    ctx,
    { filename: f }
  );
}
const Core = ctx.GobanCore;
const Ai = ctx.GobanAi;

function playGame(diffB, diffW, msB, msW, maxMoves, nodesB, nodesW) {
  const b = Core.emptyBoard();
  let turn = "b";
  let moves = 0;
  while (moves < maxMoves) {
    const m = Ai.aiMove({
      board: b,
      side: turn,
      difficulty: turn === "b" ? diffB : diffW,
      timeMs: turn === "b" ? msB : msW,
      nodeBudget: turn === "b" ? nodesB : nodesW,
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

// Deterministic gate: hard(B, 80k evals) must beat normal(W, 8k evals).
// Bit-reproducible — a failure here is a real engine regression.
{
  const g = playGame("hard", "normal", 0, 0, 100, 80000, 8000);
  assert(g.winner === "b", "DET hard(B,80k) beats normal(W,8k) — got " + g.winner + "/" + g.moves);
}

// White-side benchmark (deterministic): freestyle black's first-mover edge
// means C1-hard cannot hold same-family black; C2 should flip this line to
// a non-loss. Informational until then.
{
  const g = playGame("normal", "hard", 0, 0, 120, 8000, 80000);
  console.log("info: DET hard(W,80k) vs normal(B,8k): " + g.winner + "/" + g.moves + " (C2 target: non-loss)");
}

// easy is randomized: require a win within 2 attempts per side.
{
  const series = (label, diffB, diffW, msB, msW, want) => {
    const games = [];
    for (let i = 0; i < 2; i++) {
      const g = playGame(diffB, diffW, msB, msW, 100);
      games.push(g.winner + "/" + g.moves);
      if (g.winner === want) return assert(true, label + " — got " + games.join(" "));
    }
    assert(false, label + " — got " + games.join(" "));
  };
  series("hard(B) beats easy(W) within 2 games", "hard", "easy", 600, 30, "b");
  series("hard(W) beats easy(B) within 2 games", "easy", "hard", 30, 600, "w");
}

if (failed) {
  console.error("\n" + failed + " strength check(s) failed");
  process.exit(1);
}
console.log("\nstrength ok");
