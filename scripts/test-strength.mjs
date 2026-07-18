/**
 * AI strength regression (self-play). Guards against the v1.17 failure mode
 * where hard-vs-normal locked into mutual pre-blocking and drew a full board.
 * Run: node scripts/test-strength.mjs   (~15-30s; wired into package.sh)
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

function playGame(diffB, diffW, msB, msW, maxMoves) {
  const b = Core.emptyBoard();
  let turn = "b";
  let moves = 0;
  while (moves < maxMoves) {
    const m = Ai.aiMove({
      board: b,
      side: turn,
      difficulty: turn === "b" ? diffB : diffW,
      timeMs: turn === "b" ? msB : msW,
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

// Deterministic (hard/normal have no randomness): hard as black must convert.
{
  const g = playGame("hard", "normal", 600, 250, 100);
  assert(
    g.winner === "b",
    "hard(B) beats normal(W) within 100 moves — got " + JSON.stringify(g)
  );
}

// easy is randomized: allow slack but hard must always win.
{
  const g1 = playGame("hard", "easy", 600, 30, 80);
  assert(g1.winner === "b", "hard(B) beats easy(W) — got " + JSON.stringify(g1));
  const g2 = playGame("easy", "hard", 30, 600, 80);
  assert(g2.winner === "w", "hard(W) beats easy(B) — got " + JSON.stringify(g2));
}

if (failed) {
  console.error("\n" + failed + " strength check(s) failed");
  process.exit(1);
}
console.log("\nstrength ok");
