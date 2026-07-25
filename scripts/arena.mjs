/**
 * Engine A/B arena: the working tree's engine vs the engine from a git ref.
 *
 * Run: node scripts/arena.mjs [gitRef] [nodeBudget] [positions]
 *      node scripts/arena.mjs v1.27.0 8000 14
 * Default ref is the most recent tag. Prints a score out of 2 x positions;
 * the symmetric baseline (two equally strong engines) is exactly `positions`.
 *
 * Two things this harness learned the hard way, both encoded below:
 *
 *  1. Games from the EMPTY board are worthless as a measurement. At any
 *     budget reachable here black wins essentially every game, so a
 *     colour-swapped pairing scores 50/50 no matter which engine is better.
 *     Games therefore start from tilted midgame positions, each played from
 *     BOTH sides, so a stronger engine has something to convert.
 *  2. Openings must be deduped by board symmetry. A mirrored opening replays
 *     the identical game against a deterministic engine and silently inflates
 *     the sample — an early run reported "8 games" that were really 4.
 *
 * Node budgets (not wall clock) keep a result reproducible: same ref, same
 * arguments, same score. Resolution is limited — 28 paired games only detect
 * large effects, so treat a swing of ±2 as noise and raise `positions` when a
 * change deserves a verdict.
 */
import fs from "fs";
import os from "os";
import path from "path";
import vm from "vm";
import { execFileSync } from "child_process";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");
const ENGINE_FILES = ["core.js", "ai.js", "ai2.js"];

const REF = process.argv[2] ||
  execFileSync("git", ["describe", "--tags", "--abbrev=0"], { cwd: root, encoding: "utf8" }).trim();
const NB = Number(process.argv[3] || 8000);
const NPOS = Number(process.argv[4] || 14);

/** Materialise the baseline engine from git — no duplicated sources in-tree. */
function checkoutEngine(ref) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "goban-arena-"));
  for (const f of ENGINE_FILES) {
    let src;
    try {
      src = execFileSync("git", ["show", `${ref}:src/web/js/${f}`], {
        cwd: root, encoding: "utf8", maxBuffer: 1 << 26,
      });
    } catch (e) {
      // CI and fresh session clones are shallow — old refs need fetching first.
      console.error(
        `无法从 ${ref} 取出 ${f}：${String(e.stderr || e.message).trim()}\n` +
        "若是浅克隆，先执行 git fetch --tags（或 git fetch --unshallow）"
      );
      process.exit(1);
    }
    fs.writeFileSync(path.join(dir, f), src);
  }
  return dir;
}

function loadEngine(dir) {
  const ctx = { console, Date, performance };
  ctx.globalThis = ctx;
  ctx.window = ctx;
  vm.createContext(ctx);
  for (const f of ENGINE_FILES) {
    vm.runInContext(fs.readFileSync(path.join(dir, f), "utf8"), ctx, { filename: f });
  }
  return ctx;
}

const CAND = loadEngine(path.join(root, "src/web/js"));
const baseDir = checkoutEngine(REF);
const BASE = loadEngine(baseDir);
const Core = CAND.GobanCore;
const C1 = CAND.GobanAi;

/** Distinct 12-ply midgame positions, none already decided. */
function positions(n) {
  const out = [];
  const seen = new Set();
  for (let dr = -3; dr <= 3 && out.length < n; dr++) {
    for (let dc = -3; dc <= 3 && out.length < n; dc++) {
      if (!dr && !dc) continue;
      const b = Core.emptyBoard();
      let t = "b";
      b[7][7] = t; t = Core.opp(t);
      b[7 + dr][7 + dc] = t; t = Core.opp(t);
      let ok = true;
      for (let i = 0; i < 10; i++) {
        const m = C1.aiMove({
          board: b, side: t,
          difficulty: i % 3 === 0 ? "easy" : "normal",
          nodeBudget: 3000,
          vary: false, // positions must be identical for both engines
        });
        if (!m || b[m.r][m.c]) { ok = false; break; }
        b[m.r][m.c] = t;
        if (Core.findWin(b, m.r, m.c, t)) { ok = false; break; }
        t = Core.opp(t);
      }
      if (!ok) continue;
      const key = b.map((r) => r.map((s) => s || ".").join("")).join("");
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ board: b.map((r) => r.slice()), turn: t });
    }
  }
  return out;
}

/** mulberry32 — variety is exercised, but from a fixed seed, so "same ref,
 *  same arguments, same score" still holds. Math.random here would make every
 *  run disagree with the last by a game or two and drown small effects. */
function seededRng(seed) {
  let h = seed >>> 0;
  return function () {
    h = (h + 0x6d2b79f5) | 0;
    let x = Math.imul(h ^ (h >>> 15), 1 | h);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

function play(pos, blackEng, whiteEng, seed) {
  const b = pos.board.map((r) => r.slice());
  const rng = seededRng(seed || 1);
  let t = pos.turn;
  for (let ply = 0; ply < 120; ply++) {
    const eng = t === "b" ? blackEng : whiteEng;
    const m = eng.GobanAi2.aiMove({ board: b, side: t, difficulty: "hard", nodeBudget: NB, rng: rng });
    if (!m || b[m.r][m.c]) return "err";
    b[m.r][m.c] = t;
    if (Core.findWin(b, m.r, m.c, t)) return t;
    t = Core.opp(t);
  }
  return "draw";
}

const POS = positions(NPOS);
console.log(`基线 ${REF} · nodeBudget=${NB} · ${POS.length} 个局面 × 双色`);
let pts = 0, w = 0, l = 0, d = 0;
const t0 = Date.now();
for (let i = 0; i < POS.length; i++) {
  for (const candBlack of [true, false]) {
    // Same seed for both colour assignments of a position: the pairing only
    // cancels out colour bias if the two games see the same variety choices.
    const r = play(POS[i], candBlack ? CAND : BASE, candBlack ? BASE : CAND, i + 1);
    let tag;
    if (r === "draw" || r === "err") { pts += 0.5; d++; tag = "和"; }
    else if ((r === "b") === candBlack) { pts += 1; w++; tag = "候选胜"; }
    else { l++; tag = "基线胜"; }
    console.log(`局面${String(i).padStart(2)} 候选执${candBlack ? "黑" : "白"} → ${tag}`);
  }
}
const even = POS.length;
console.log(
  `\n候选 ${pts} / ${even * 2} 分 (胜 ${w} 负 ${l} 和 ${d})　对称基准 ${even}　用时 ${Math.round((Date.now() - t0) / 1000)}s`
);
const delta = pts - even;
console.log(
  Math.abs(delta) <= 2
    ? `净 ${delta > 0 ? "+" : ""}${delta}：在本样本量下与基线无法区分（±2 视为噪声）`
    : `净 ${delta > 0 ? "+" : ""}${delta}：${delta > 0 ? "候选更强" : "候选更弱"}，建议加大 positions 复核`
);
fs.rmSync(baseDir, { recursive: true, force: true });
