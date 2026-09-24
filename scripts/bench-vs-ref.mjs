/**
 * 新旧同名档对打:工作区的每一档 vs 某个 git ref(默认 v1.64.0)的同名档。
 *
 *   node scripts/bench-vs-ref.mjs
 *   REF=v1.64.0 TIERS=normal,hard,ext OPENINGS=12 SCALE=0.25 node scripts/bench-vs-ref.mjs
 *   PAIRS=ext:hard node scripts/bench-vs-ref.mjs        # 工作区内部的相邻档(不取 ref)
 *
 * v1.65 的验收就是它:「每一档都更难」= **新档对旧同名档,配对计分 p < 0.05**;
 * 「极档不是假的」= **新极对新难 p < 0.05**。
 *
 * 用墙钟而不是节点数:两代引擎的「节点」不是同一种东西(C1 数 analyzePlace、C2 数 make、
 * C3 数 make),按节点对齐等于偷偷给某一边让子。SCALE 按比例缩短双方的思考时间
 * (0.25 = 难 500 ms、极 1250 ms),两边等比缩,序关系不变,跑得完。
 * 开局、配对计分与符号检验与 bench-tiers 同一套。
 */
import fs from "fs";
import path from "path";
import vm from "vm";
import { execFileSync } from "child_process";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");
const num = (k, d) => (process.env[k] ? Number(process.env[k]) : d);
const FILES = ["core.js", "ai.js", "ai2.js", "ai3.js"];

function loadEngines(ref) {
  const ctx = { console, Date, performance };
  ctx.globalThis = ctx; ctx.window = ctx;
  vm.createContext(ctx);
  for (const f of FILES) {
    let src;
    if (ref) {
      try { src = execFileSync("git", ["show", `${ref}:src/web/js/${f}`], { cwd: root, encoding: "utf8", maxBuffer: 1 << 26, stdio: ["ignore", "pipe", "ignore"] }); }
      catch (_) { continue; }
    } else {
      const p = path.join(root, "src/web/js", f);
      if (!fs.existsSync(p)) continue;
      src = fs.readFileSync(p, "utf8");
    }
    vm.runInContext(src, ctx, { filename: (ref || "work") + ":" + f });
  }
  if (!ctx.GobanAi) {
    console.error(`取不到 ${ref || "工作区"} 的引擎(浅克隆先 git fetch origin tag ${ref})`);
    process.exit(1);
  }
  // v1.65 之前没有 GobanTier:照当时 app.js 的 engineFor 路由
  const engineFor = ctx.GobanTier ? ctx.GobanTier.engineFor
    : (d) => (d === "hard" || d === "extreme") && ctx.GobanAi2 ? ctx.GobanAi2 : ctx.GobanAi;
  return { Core: ctx.GobanCore, engineFor };
}

const SCALE = num("SCALE", 0.25);
const MS = { easy: 30, normal: 250, hard: 2000, ext: 5000 };
const DIFF = { easy: "easy", normal: "normal", hard: "hard", ext: "extreme" };
// v1.65 起普档的发布时限是 400ms(C3);旧版仍按它当时的 250ms
const MS_NEW = { easy: 30, normal: 400, hard: 2000, ext: 5000 };

function player(E, tier, msTable) {
  const eng = E.engineFor(DIFF[tier]);
  const ms = Math.max(20, Math.round(msTable[tier] * SCALE));
  return { name: tier, move: (bd, side) => eng.aiMove({ board: bd, side, difficulty: DIFF[tier], timeMs: ms, vary: false }) };
}

// ── 开局册(同 bench-tiers)──
const SYMS = [
  ([r, c]) => [r, c], ([r, c]) => [c, r], ([r, c]) => [r, 14 - c], ([r, c]) => [14 - r, c],
  ([r, c]) => [14 - r, 14 - c], ([r, c]) => [c, 14 - r], ([r, c]) => [14 - c, r], ([r, c]) => [14 - c, 14 - r],
];
function canonical(st) {
  let best = null;
  for (const f of SYMS) { const k = st.map((p) => { const [a, b] = f(p); return a * 15 + b; }).join(","); if (best === null || k < best) best = k; }
  return best;
}
function openingBook(limit) {
  const offs = []; for (let dr = -2; dr <= 2; dr++) for (let dc = -2; dc <= 2; dc++) if (dr || dc) offs.push([dr, dc]);
  const seen = new Set(), book = [];
  for (const [wr, wc] of offs) for (const [br, bc] of offs) {
    if (wr === br && wc === bc) continue;
    const st = [[7, 7], [7 + wr, 7 + wc], [7 + br, 7 + bc]];
    const k = canonical(st); if (seen.has(k)) continue; seen.add(k); book.push(st);
    if (book.length >= limit) return book;
  }
  return book;
}
function playGame(Core, A, B, open) {
  const bd = Core.emptyBoard(); let side = "b";
  for (const [r, c] of open) { bd[r][c] = side; side = Core.opp(side); }
  for (let ply = open.length; ply < 225; ply++) {
    const who = side === "b" ? A : B;
    const mv = who.move(bd, side);
    if (!mv || bd[mv.r][mv.c]) return "err";
    bd[mv.r][mv.c] = side;
    if (Core.findWin(bd, mv.r, mv.c, side)) return side;
    if (Core.boardFull(bd)) return "draw";
    side = Core.opp(side);
  }
  return "draw";
}
function logC(n, k) { let s = 0; for (let i = 0; i < k; i++) s += Math.log(n - i) - Math.log(i + 1); return s; }
function signP(w, l) { const n = w + l; if (!n) return 1; let p = 0; for (let k = w; k <= n; k++) p += Math.exp(logC(n, k) - n * Math.log(2)); return Math.min(1, p); }

const book = openingBook(num("OPENINGS", 12));
const NEW = loadEngines("");
const REF = process.env.REF || "v1.64.0";
let pairs;
if (process.env.PAIRS) pairs = process.env.PAIRS.split(",").map((s) => { const [a, b] = s.split(":"); return [player(NEW, a, MS_NEW), player(NEW, b, MS_NEW), `新${a} vs 新${b}`]; });
else {
  const OLD = loadEngines(REF);
  pairs = (process.env.TIERS || "normal,hard,ext").split(",").map((t) => [player(NEW, t, MS_NEW), player(OLD, t, MS), `新${t} vs ${REF} ${t}`]);
}
console.log(`开局 ${book.length} 个 × 正反 · 时限 ×${SCALE}(新:普 ${Math.round(400 * SCALE)} / 难 ${Math.round(2000 * SCALE)} / 极 ${Math.round(5000 * SCALE)} ms)`);
const rows = [];
for (const [A, B, label] of pairs) {
  let pw = 0, pl = 0, pt = 0, a = 0, b = 0, d = 0, errs = 0;
  for (const op of book) {
    const g1 = playGame(NEW.Core, A, B, op), g2 = playGame(NEW.Core, B, A, op);
    const a1 = g1 === "b", a2 = g2 === "w", b1 = g1 === "w", b2 = g2 === "b";
    errs += (g1 === "err") + (g2 === "err");
    a += a1 + a2; b += b1 + b2; d += (g1 === "draw") + (g2 === "draw");
    if (a1 && a2) pw++; else if (b1 && b2) pl++; else pt++;
  }
  const score = (pw + pt / 2) / book.length;
  const elo = score <= 0 ? -Infinity : score >= 1 ? Infinity : -400 * Math.log10(1 / score - 1);
  const p = signP(Math.max(pw, pl), Math.min(pw, pl));
  const row = { 对局: label, 配对: `${pw}胜 ${pt}平 ${pl}负`, 逐局: `${a}:${b}${d ? " 和" + d : ""}`,
    Elo: Number.isFinite(elo) ? (elo >= 0 ? "+" : "") + elo.toFixed(0) : (elo > 0 ? "+∞" : "−∞"),
    p: p.toFixed(4), 判定: p < 0.05 ? (pw > pl ? "显著更强" : "显著更弱") : "不显著", errs };
  rows.push(row);
  console.log(JSON.stringify(row));
}
console.table(rows);
