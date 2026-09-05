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
      // v1.31 varies among symmetry-equivalent replies; equally strong by
      // construction, but a strength assertion has to compare the same game
      // twice, so this suite plays the engine with variety switched off.
      vary: false,
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
      const m = cfg.eng.aiMove({ board: b, side: turn, difficulty: cfg.difficulty, nodeBudget: cfg.nodeBudget, vary: false });
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


// ---- v1.63:难度承诺(对手画像)必须可证伪 ----------------------------------
// 侧栏难度的提示文案从「C2 引擎:深搜索 + 战术级联」改成了面向玩家的承诺:
//   入门:会挡住你的冲四,但常常漏掉活三
//   普通:必挡直接威胁,会算连续冲四
//   困难:会做杀、会防杀
// 承诺写在字典里,证据写在这里。题材是练习题库(scripts/gen-puzzles 验证过每一道)
// 与一组构造的活三局面;实测(v1.63):入门挡冲四 45/45、挡活三 19/40、VCF 12/35;
// 普通挡活三 40/40、VCF 35/35;困难 VCF 35/35。
{
  vm.runInContext(fs.readFileSync(path.join(root, "src/web/js/i18n.js"), "utf8"), ctx, { filename: "i18n.js" });
  vm.runInContext(fs.readFileSync(path.join(root, "src/web/js/practice.js"), "utf8"), ctx, { filename: "practice.js" });
  const P = ctx.GobanPractice;
  P.init({ getGames: () => [] });
  const bank = P.puzzles.buildCandidates();
  const hits = (eng, diff, ms, type) => {
    const list = bank.filter((p) => p.type === type);
    let n = 0;
    for (const p of list) {
      const m = eng.aiMove({ board: p.board.map((r) => r.slice()), side: p.side, difficulty: diff, timeMs: ms, vary: false });
      if (m && p.solutions.some((s) => s.r === m.r && s.c === m.c)) n++;
    }
    return { n, total: list.length };
  };
  const eDef = hits(Ai, "easy", 30, "defend");
  assert(eDef.n === eDef.total, "入门:挡住每一个冲四/成五威胁 (" + eDef.n + "/" + eDef.total + ")");
  const eVcf = hits(Ai, "easy", 30, "vcf");
  assert(eVcf.n < eVcf.total * 0.7, "入门:并不总能算出连续冲四 —— 否则它不是入门 (" + eVcf.n + "/" + eVcf.total + ")");
  const nVcf = hits(Ai, "normal", 250, "vcf");
  assert(nVcf.n >= nVcf.total * 0.9, "普通:会算连续冲四 (" + nVcf.n + "/" + nVcf.total + ")");
  const hVcf = hits(Ai2, "hard", 800, "vcf");
  assert(hVcf.n >= hVcf.total * 0.9, "困难:会做杀 (" + hVcf.n + "/" + hVcf.total + ")");

  // 活三局面:白三连、两端开;黑到手,远处三子。挡点是两端之一。
  const openThree = (k) => {
    const b = Core.emptyBoard();
    const r = 3 + (k % 8), c0 = 3 + ((k * 3) % 7);
    for (let i = 0; i < 3; i++) b[r][c0 + i] = "w";
    b[(r + 5) % 15][(c0 + 7) % 15] = "b";
    b[(r + 6) % 15][(c0 + 8) % 15] = "b";
    b[(r + 4) % 15][(c0 + 9) % 15] = "b";
    return { b, r, c0 };
  };
  const blocksThree = (eng, diff, ms) => {
    let n = 0;
    for (let k = 0; k < 40; k++) {
      const { b, r, c0 } = openThree(k);
      const m = eng.aiMove({ board: b, side: "b", difficulty: diff, timeMs: ms, vary: false });
      if (m && m.r === r && (m.c === c0 - 1 || m.c === c0 + 3)) n++;
    }
    return n;
  };
  const eThree = blocksThree(Ai, "easy", 30);
  // 入门是随机化的:40 局面 p≈0.5,±3σ 约 [8, 32]
  assert(eThree >= 6 && eThree <= 34, "入门:常常漏掉活三,但不是从不挡 (" + eThree + "/40)");
  const nThree = blocksThree(Ai, "normal", 250);
  assert(nThree >= 38, "普通:必挡直接威胁,活三也挡 (" + nThree + "/40)");
}

if (failed) {
  console.error("\n" + failed + " strength check(s) failed");
  process.exit(1);
}
console.log("\nstrength ok");
