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

const TARGET = { win1: 18, defend: 15, vcf: 12 };
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

  const k = sig(board, side, type);
  if (seen.has(k)) return;
  const sk = shapeKey(board, type);
  if (shapes.has(sk)) return;
  seen.add(k); shapes.add(sk);
  const st = stonesOf(board);
  found[type].push({ type, side, b: st.b, w: st.w, solutions: sol.length, stones });
}

/** Deterministic openings: seed stones before the engines take over. */
const OPENINGS = [];
for (let r = 4; r <= 10; r += 2) {
  for (let c = 4; c <= 10; c += 2) {
    OPENINGS.push([[7, 7], [r, c]]);
    OPENINGS.push([[r, c], [r + 1, c + 1]]);
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
  (p) => `    { type: "${p.type}", side: "${p.side}",\n      b: ${fmt(p.b)},\n      w: ${fmt(p.w)} },`
);

console.error(
  `games=${games} win1=${found.win1.length} defend=${found.defend.length} vcf=${found.vcf.length} total=${all.length}`
);
console.error(
  "solutions/puzzle: " +
    JSON.stringify(all.reduce((m, p) => ((m[p.solutions] = (m[p.solutions] || 0) + 1), m), {})) +
    "  stones min/max: " +
    Math.min(...all.map((p) => p.stones)) + "/" + Math.max(...all.map((p) => p.stones))
);
console.log(lines.join("\n"));
