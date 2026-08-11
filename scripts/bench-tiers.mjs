/**
 * 档位棋力评测:档位之间对打,输出配对胜负、Elo 差与显著性。
 *
 *   node scripts/bench-tiers.mjs                    # 默认快跑
 *   PAIRS=ext:hard OPENINGS=24 node scripts/bench-tiers.mjs
 *   NODES_EXT=200000 NODES_HARD=80000 node scripts/bench-tiers.mjs
 *
 * ## 为什么需要它
 *
 * 这个项目**没有任何绝对棋力度量**。`test-strength.mjs` 守的是序关系与回归
 * (「预算更多不许更弱」「不许退化成互堵和棋」),`b/23 · w/32` 那四条守的是
 * 确定性 —— 它们证明「引擎没被改动」,不证明「引擎有多强」。于是改一处评估
 * 函数之后,只知道它变了,不知道变强还是变弱。这个脚本就是那把缺掉的尺。
 *
 * ## 配对计分:先手优势必须在方法里消掉,不能靠事后解释
 *
 * 首次实测(12 局/配对、交换颜色)得到「极 8 : 难 4」,看着像极档更强。但逐局
 * 一看,**12 局里黑赢了 10 局**;三个配对合计 36 局黑赢 25 局(69%)。也就是说
 * 胜负主要由「谁拿到黑」决定。交换颜色只让**配对**公平,并没有降低**单局方差**。
 *
 * 所以这里改成配对计分:同一开局正反各打一遍,
 *
 *   两局都赢 → +1    一胜一负 → 0    两局都输 → -1
 *
 * 先手优势对两边同等作用,在配对内部相消。代价是有效样本减半(N 个开局只给
 * N 个配对分),换来的是**方差大幅下降**,这笔买卖在均势开局下是划算的。
 *
 * ## 显著性随数字一起给
 *
 * 「极 8 : 难 4」在 n=12 下单尾 p≈0.19 —— 不显著,但看着很像结论。所以输出里
 * 一律带符号检验的 p 值:**没有 p 的胜负数不许拿来做决定**。
 *
 * ## 确定性
 *
 * 全部走 `nodeBudget` 而不是墙钟,同一次调用同样的输入给同样的一手,结果可复现、
 * 与机器负载无关。节点数按发布档的时间比设定(普 250ms→10k · 难 2000ms→80k ·
 * 极 5000ms→200k),但它是**代理**不是等价物:真机上还有 worker 往返与渲染。
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
const load = (rel) => vm.runInContext(fs.readFileSync(path.join(root, rel), "utf8"), ctx, { filename: rel });
for (const f of ["src/web/js/version.js", "src/web/js/i18n.js", "src/web/js/core.js",
  "src/web/js/sgf.js", "src/web/js/ai.js", "src/web/js/ai2.js"]) load(f);
const Core = ctx.GobanCore, Ai = ctx.GobanAi, Ai2 = ctx.GobanAi2;

const num = (k, d) => (process.env[k] ? Number(process.env[k]) : d);

/** 档位定义。节点数照搬发布档的时间比,可用环境变量覆盖以做敏感性分析。 */
export const TIERS = {
  easy:   { label: "简", eng: Ai,  diff: "easy",    nodes: num("NODES_EASY", 1200) },
  normal: { label: "普", eng: Ai,  diff: "normal",  nodes: num("NODES_NORMAL", 10000) },
  hard:   { label: "难", eng: Ai2, diff: "hard",    nodes: num("NODES_HARD", 80000) },
  ext:    { label: "极", eng: Ai2, diff: "extreme", nodes: num("NODES_EXT", 200000) },
};

// ── 开局册 ────────────────────────────────────────────────────────────────────
//
// 三子开局(黑·白·黑),从天元展开。**必须去重到对称等价类** —— 否则同一个局面
// 会被算好几遍,把独立样本数虚报,p 值跟着虚低。
const SIZE = 15, C = 7;
const SYMS = [
  ([r, c]) => [r, c],          ([r, c]) => [c, r],
  ([r, c]) => [r, 14 - c],     ([r, c]) => [14 - r, c],
  ([r, c]) => [14 - r, 14 - c], ([r, c]) => [c, 14 - r],
  ([r, c]) => [14 - c, r],     ([r, c]) => [14 - c, 14 - r],
];
/** 对称等价类的规范形:8 种变换里字典序最小的那个。 */
function canonical(stones) {
  let best = null;
  for (const f of SYMS) {
    const key = stones.map(([r, c]) => { const [a, b] = f([r, c]); return a * SIZE + b; }).join(",");
    if (best === null || key < best) best = key;
  }
  return best;
}
function openingBook(limit) {
  const offs = [];
  for (let dr = -2; dr <= 2; dr++) for (let dc = -2; dc <= 2; dc++) {
    if (dr || dc) offs.push([dr, dc]);
  }
  const seen = new Set(), book = [];
  for (const [wr, wc] of offs) {
    for (const [br, bc] of offs) {
      if (wr === br && wc === bc) continue;
      const st = [[C, C], [C + wr, C + wc], [C + br, C + bc]];
      if (st.some(([r, c]) => r < 0 || r > 14 || c < 0 || c > 14)) continue;
      const k = canonical(st);
      if (seen.has(k)) continue;
      seen.add(k);
      book.push(st);
      if (book.length >= limit) return book;
    }
  }
  return book;
}

/** 一局。stones 依次为 黑白黑…;之后 A 执黑、B 执白接着下。 */
function playGame(A, B, open) {
  const bd = Core.emptyBoard();
  let side = "b";
  for (const [r, c] of open) { bd[r][c] = side; side = Core.opp(side); }
  for (let ply = open.length; ply < SIZE * SIZE; ply++) {
    const t = side === "b" ? A : B;
    const mv = t.eng.aiMove({ board: bd, side, difficulty: t.diff, timeMs: 0, nodeBudget: t.nodes });
    if (!mv || bd[mv.r][mv.c]) return { w: "err", moves: ply };
    bd[mv.r][mv.c] = side;
    if (Core.findWin(bd, mv.r, mv.c, side)) return { w: side, moves: ply + 1 };
    if (Core.boardFull(bd)) return { w: "draw", moves: ply + 1 };
    side = Core.opp(side);
  }
  return { w: "draw", moves: SIZE * SIZE };
}

// ── 统计 ──────────────────────────────────────────────────────────────────────
function logC(n, k) { let s = 0; for (let i = 0; i < k; i++) s += Math.log(n - i) - Math.log(i + 1); return s; }
/** 符号检验:在「两边等强」的零假设下,观察到 >=wins 个配对胜的单尾概率。 */
export function signTestP(wins, losses) {
  const n = wins + losses;
  if (n === 0) return 1;
  let p = 0;
  for (let k = wins; k <= n; k++) p += Math.exp(logC(n, k) - n * Math.log(2));
  return Math.min(1, p);
}
/** 由胜率反推 Elo 差。平局按半分。 */
export function eloDiff(score, n) {
  if (n === 0) return 0;
  const p = score / n;
  if (p <= 0) return -Infinity;
  if (p >= 1) return Infinity;
  return -400 * Math.log10(1 / p - 1);
}

// ── 主流程 ────────────────────────────────────────────────────────────────────
const N_OPEN = num("OPENINGS", 12);
const book = openingBook(N_OPEN);
const wanted = (process.env.PAIRS || "ext:hard,hard:normal,normal:easy")
  .split(",").map((s) => s.trim().split(":"));

console.log(`开局册 ${book.length} 个(已按 8 种对称去重)· 每个开局正反各一局`);
console.log(`节点预算  简 ${TIERS.easy.nodes} · 普 ${TIERS.normal.nodes} · 难 ${TIERS.hard.nodes} · 极 ${TIERS.ext.nodes}\n`);

const rows = [];
for (const [xk, yk] of wanted) {
  const A = TIERS[xk], B = TIERS[yk];
  if (!A || !B) { console.error("未知档位:" + xk + " / " + yk); process.exit(2); }
  let pairWin = 0, pairLoss = 0, pairTie = 0;
  let rawA = 0, rawB = 0, rawDraw = 0, blackWins = 0, errs = 0;
  for (const op of book) {
    // 同一开局,A 执黑一局、B 执黑一局 —— 配对的两半
    const g1 = playGame(A, B, op);          // A 黑
    const g2 = playGame(B, A, op);          // B 黑
    for (const g of [g1, g2]) {
      if (g.w === "b") blackWins++;
      if (g.w === "err") errs++;
    }
    const aWon1 = g1.w === "b", aWon2 = g2.w === "w";
    if (g1.w === "draw" || g1.w === "err") rawDraw++; else if (aWon1) rawA++; else rawB++;
    if (g2.w === "draw" || g2.w === "err") rawDraw++; else if (aWon2) rawA++; else rawB++;
    if (aWon1 && aWon2) pairWin++;
    else if (!aWon1 && !aWon2) pairLoss++;
    else pairTie++;
  }
  const decided = pairWin + pairLoss;
  const p = signTestP(Math.max(pairWin, pairLoss), Math.min(pairWin, pairLoss));
  const score = pairWin + pairTie / 2;
  const elo = eloDiff(score, book.length);
  rows.push({
    pair: `${A.label} vs ${B.label}`,
    配对: `${pairWin}胜 ${pairTie}平 ${pairLoss}负`,
    逐局: `${rawA}:${rawB}${rawDraw ? " 和" + rawDraw : ""}`,
    黑胜率: ((blackWins / (book.length * 2)) * 100).toFixed(0) + "%",
    Elo差: Number.isFinite(elo) ? (elo >= 0 ? "+" : "") + elo.toFixed(0) : (elo > 0 ? "+∞" : "-∞"),
    p: decided === 0 ? "—" : p.toFixed(3),
    判定: decided === 0 ? "全平,分不开" : p < 0.05 ? "显著" : "不显著",
    errs,
  });
}
console.table(rows);
console.log("\n配对计分:同一开局两局全赢=胜 · 一胜一负=平 · 两局全输=负。先手优势在配对内相消。");
console.log("p 为符号检验单尾值;p ≥ 0.05 的胜负数**不足以支撑任何结论**。");
const anyErr = rows.reduce((s, r) => s + r.errs, 0);
if (anyErr) console.log(`⚠ 有 ${anyErr} 局因引擎返回空手/占用点而作废 —— 那是缺陷,不是平局。`);
