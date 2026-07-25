/**
 * Curated puzzle bank generator (authoring tool, not part of the build).
 *
 * Positions come from deterministic engine self-play, so they are natural
 * board shapes rather than hand-drawn diagrams, and every candidate is
 * validated through practice.js's own predicates — the exact code that will
 * judge the player's click — so a puzzle can never ship unsolvable or
 * ambiguous.
 *
 * Run: node scripts/gen-puzzles.mjs [count]   → prints the BUILTINS literal
 * Paste the output into src/web/js/practice.js. Re-running with the same
 * arguments reproduces the same bank (no Math.random anywhere).
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
for (const f of ["core.js", "ai.js", "ai2.js", "practice.js"]) {
  vm.runInContext(fs.readFileSync(path.join(root, "src/web/js", f), "utf8"), ctx, { filename: f });
}
const Core = ctx.GobanCore;
const Ai = ctx.GobanAi;
const P = ctx.GobanPractice.puzzles;
const SIZE = Core.SIZE;

// `node scripts/gen-puzzles.mjs vcf` regenerates one type only.
const ONLY = process.argv.slice(2).filter((a) => /^(win1|defend|vcf)$/.test(a));
// v1.30 sizing: at 53 puzzles the daily challenge (5/day) showed the whole
// bank in 46 days and then only repeated. ~130 pushes that past 100 days.
// win1/defend saturate long before the sweep ends; vcf is the scarce type,
// so it gets the headroom and the sweep runs to exhaustion for its sake.
const TARGET = { win1: 50, defend: 45, vcf: 35 };
for (const t of Object.keys(TARGET)) if (ONLY.length && !ONLY.includes(t)) TARGET[t] = 0;
/** vcf puzzles must need a real forcing chain: v1.26 shipped 9 of 12 that were
 *  won by a single double-four, which is a different (much easier) exercise. */
const VCF_MIN_DEPTH = 3;
const found = { win1: [], defend: [], vcf: [] };
const seen = new Set();

function sig(board, side, type) {
  return type + ":" + side + ":" + board.map((row) => row.map((s) => s || ".").join("")).join("");
}

/** Coarse fingerprint so the bank does not fill up with near-identical shapes. */
function shapeKey(board, type) {
  let rs = 0, cs = 0, n = 0;
  for (let r = 0; r < SIZE; r++) for (let c = 0; c < SIZE; c++) if (board[r][c]) { rs += r; cs += c; n++; }
  return type + ":" + n + ":" + Math.round(rs / n / 2) + ":" + Math.round(cs / n / 2);
}
const shapes = new Set();

function stonesOf(board) {
  const b = [], w = [];
  for (let r = 0; r < SIZE; r++) for (let c = 0; c < SIZE; c++) {
    if (board[r][c] === "b") b.push([r, c]);
    else if (board[r][c] === "w") w.push([r, c]);
  }
  return { b, w };
}

/** Accept a position as a puzzle of `type` if it is valid, sharp and fresh. */
function consider(board, side, type) {
  if (found[type].length >= TARGET[type]) return;
  const stones = board.flat().filter(Boolean).length;
  if (stones < 8 || stones > 54) return;
  const oppoWins = Ai.listWinCells(board, Core.opp(side)).length;
  const myWins = Ai.listWinCells(board, side).length;

  if (type === "win1") {
    if (!myWins) return;
  } else if (type === "defend") {
    // Defender must not already have a five of their own: that would make an
    // "attack" click correct in reality yet wrong per the defend solution set.
    if (!oppoWins || myWins) return;
  } else if (type === "vcf") {
    // No immediate five for either side — otherwise the objectively winning
    // click (or the forced block) is not in the vcf solution set.
    if (myWins || oppoWins) return;
  }

  const sol = P.solutionsFor(board.map((r) => r.slice()), side, type);
  if (!sol.length) return;
  if (type === "win1" && sol.length > 3) return;   // many wins ⇒ trivial
  if (type === "defend" && sol.length > 4) return;
  if (type === "vcf" && sol.length > 3) return;    // keep the key move sharp

  let depth = 0;
  if (type === "vcf") {
    // Every solution must lead to a chain worth solving, not just the first.
    depth = Math.min(...sol.map((s) => P.lineDepth(P.forcedLine(board, side, s), side)));
    if (depth < VCF_MIN_DEPTH) return;
  }

  const k = sig(board, side, type);
  if (seen.has(k)) return;
  const sk = shapeKey(board, type);
  if (shapes.has(sk)) return;
  seen.add(k); shapes.add(sk);
  const st = stonesOf(board);
  found[type].push({
    type, side, b: st.b, w: st.w, solutions: sol.length, stones, depth,
    // vcf answers are expensive to re-derive (a full findVCF sweep per open),
    // so they ship with the position; test-game.mjs re-derives and compares.
    sol: type === "vcf" ? sol.map((s) => [s.r, s.c]) : null,
  });
}

/**
 * Deterministic openings: seed stones before the engines take over.
 *
 * Widened in v1.30 (5×5 grid, three seed shapes) because the old 4×4 grid ×
 * two shapes ran out of vcf positions: a sweep with the target raised to 40
 * still only yielded 13, having exhausted all 128 games. vcf needs a long
 * forcing chain to exist at all, so the only lever is more distinct games.
 */
const OPENINGS = [];
for (let r = 3; r <= 11; r += 2) {
  for (let c = 3; c <= 11; c += 2) {
    OPENINGS.push([[7, 7], [r, c]]);
    OPENINGS.push([[r, c], [r + 1, c + 1]]);
    OPENINGS.push([[r, c], [r + 2, c + 1]]); // knight step — different shapes than the two diagonals
  }
}

const LEVELS = [
  { b: "easy", w: "normal" },
  { b: "normal", w: "easy" },
  { b: "normal", w: "normal" },
  { b: "easy", w: "easy" },
];

function playAndHarvest(opening, levels) {
  const board = Core.emptyBoard();
  let turn = "b";
  for (const [r, c] of opening) { board[r][c] = turn; turn = Core.opp(turn); }
  for (let ply = 0; ply < 70; ply++) {
    // Harvest BEFORE the move: the position with `turn` to play is the puzzle.
    consider(board.map((r) => r.slice()), turn, "win1");
    consider(board.map((r) => r.slice()), turn, "defend");
    consider(board.map((r) => r.slice()), turn, "vcf");
    if (Object.keys(TARGET).every((t) => found[t].length >= TARGET[t])) return true;

    const diff = turn === "b" ? levels.b : levels.w;
    const m = Ai.aiMove({ board, side: turn, difficulty: diff, nodeBudget: 12000 });
    if (!m || board[m.r][m.c]) return false;
    board[m.r][m.c] = turn;
    if (Core.findWin(board, m.r, m.c, turn)) return false; // game over — next game
    turn = Core.opp(turn);
  }
  return false;
}

let games = 0;
outer:
for (const levels of LEVELS) {
  for (const opening of OPENINGS) {
    games++;
    if (playAndHarvest(opening, levels)) break outer;
    if (Object.keys(TARGET).every((t) => found[t].length >= TARGET[t])) break outer;
  }
}

const all = [...found.win1, ...found.defend, ...found.vcf];
const fmt = (pts) => "[" + pts.map(([r, c]) => `[${r},${c}]`).join(",") + "]";
const lines = all.map(
  (p) => `    { type: "${p.type}", side: "${p.side}",\n      b: ${fmt(p.b)},\n      w: ${fmt(p.w)}` +
    (p.sol ? `,\n      sol: ${fmt(p.sol)} },` : " },")
);

console.error(
  `games=${games} win1=${found.win1.length} defend=${found.defend.length} vcf=${found.vcf.length} total=${all.length}`
);
const vcfDepths = found.vcf.map((p) => p.depth);
if (vcfDepths.length) console.error("vcf 深度分布: " + JSON.stringify(
  vcfDepths.reduce((m, d) => ((m[d] = (m[d] || 0) + 1), m), {})));
console.error(
  "solutions/puzzle: " +
    JSON.stringify(all.reduce((m, p) => ((m[p.solutions] = (m[p.solutions] || 0) + 1), m), {})) +
    "  stones min/max: " +
    Math.min(...all.map((p) => p.stones)) + "/" + Math.max(...all.map((p) => p.stones))
);
console.log(lines.join("\n"));
