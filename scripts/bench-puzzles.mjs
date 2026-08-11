/**
 * 能力曲线:在**受限预算**下,各引擎档位对 130 道内置战术题的解题率。
 *
 *   node scripts/bench-puzzles.mjs
 *   BUDGETS=500,2000,8000,32000 node scripts/bench-puzzles.mjs
 *   PROFILES=c1normal,c2hard node scripts/bench-puzzles.mjs
 *
 * ## 为什么是「对预算的曲线」,而不是单个解题率
 *
 * 直接拿发布档的预算去跑,实测是这样的:
 *
 *   简 80.0%(win1 50/50 · defend 45/45 · **VCF 9/35**)
 *   普 / 难 / 极 一律 **100%**
 *
 * 题库在普及以上**完全饱和**,三档一个都分不开 —— 它是地板测试,不是阶梯。
 * (win1 与 defend 都是一步题,`forcedMove` 在任何档都拿满;真正吃搜索的只有
 * VCF,而 `vcfDepth` 从普档起就是 12/24,够用了。简档 `vcfDepth=0`、αβ 只有
 * 1 层,所以只有它掉下来。)
 *
 * ## 试过、被证伪的想法:「把预算压下去就能恢复区分力」
 *
 * 这是本脚本最初的设计意图,**实测不成立**,原样记在这里免得有人再试一遍:
 *
 *   预算(节点)      500      2000     8000
 *   C1·简           19/35    15/35    12/35     ← VCF
 *   C1·普           35/35    35/35    35/35
 *   C2·难           35/35    35/35    35/35
 *   C2·极           35/35    35/35    35/35
 *
 * 压到 500 节点,普及以上**依然全对**。原因是结构性的:VCF 由 `findVCF` 这条
 * **战术级联**负责,它受 `vcfDepth` 限深,**不受 `nodeBudget` 约束** —— 预算再
 * 小,级联照样先把杀招找出来。压预算压不到真正决定解题的那个旋钮。
 *
 * 顺带一个反直觉的读数:**简档预算越大,VCF 解得越少**(19→15→12)。简档
 * `vcfDepth=0` 根本不跑 VCF,那些「解对」是 αβ 恰好选中答案格的**巧合**;节点
 * 越多搜索越收敛,离巧合越远。所以简档那一栏量的不是能力,是运气。
 *
 * ## 因此它的真实定位:地板测试,不是阶梯
 *
 * 这把尺**分不开普/难/极**,别拿它当棋力度量。它守得住的是另一件事:战术级联
 * 有没有被改坏 —— 任何一档从 100% 掉下来都是回归。棋力的序关系去看
 * `bench-tiers.mjs`(对局 + 配对计分 + 显著性)。
 *
 * 要让它变成阶梯,需要的是**比 `vcfDepth` 更深的题**或考大局观的题,那是内容
 * 工作,不是参数工作。
 *
 * 全程 `nodeBudget`,不用墙钟,结果可复现。
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
// practice.js 会摸 DOM;给一个够用的空壳,免得为了评测去改产品代码
ctx.document = {
  getElementById: () => null, querySelector: () => null, querySelectorAll: () => [],
  createElement: () => ({
    style: {}, classList: { add() {}, remove() {}, contains() { return false; } },
    appendChild() {}, setAttribute() {},
  }),
  addEventListener() {},
};
vm.createContext(ctx);
const load = (rel) => vm.runInContext(fs.readFileSync(path.join(root, rel), "utf8"), ctx, { filename: rel });
for (const f of ["src/web/js/version.js", "src/web/js/i18n.js", "src/web/js/core.js",
  "src/web/js/sgf.js", "src/web/js/ai.js", "src/web/js/ai2.js", "src/web/js/practice.js"]) load(f);
const Ai = ctx.GobanAi, Ai2 = ctx.GobanAi2, P = ctx.GobanPractice.puzzles;

const PROFILES = {
  c1easy:   { label: "C1·简", eng: Ai,  diff: "easy" },
  c1normal: { label: "C1·普", eng: Ai,  diff: "normal" },
  c1hard:   { label: "C1·难", eng: Ai,  diff: "hard" },
  c2hard:   { label: "C2·难", eng: Ai2, diff: "hard" },
  c2ext:    { label: "C2·极", eng: Ai2, diff: "extreme" },
};

const budgets = (process.env.BUDGETS || "500,2000,8000,32000")
  .split(",").map((s) => Number(s.trim())).filter((n) => n > 0);
const profKeys = (process.env.PROFILES || "c1easy,c1normal,c2hard,c2ext")
  .split(",").map((s) => s.trim()).filter((k) => PROFILES[k]);

// 先把题目与标准答案备好 —— 无解的题要剔掉并报出来,
// 否则分母里混着不可能解的题,曲线整体压低而看不出原因。
const cases = [];
let dropped = 0;
for (const def of P.BUILTINS) {
  const board = P.boardOf(def);
  const sols = P.solutionsFor(board, def.side, def.type);
  if (!sols.length) { dropped++; continue; }
  cases.push({ board, side: def.side, type: def.type, keys: new Set(sols.map((s) => s.r * 15 + s.c)) });
}
const types = [...new Set(cases.map((c) => c.type))];
console.log(`题目 ${cases.length} 道${dropped ? `(剔除无解 ${dropped} 道)` : ""} · 题型 ${types.join(" / ")}`);
console.log(`预算 ${budgets.join(" / ")} 节点 · 档位 ${profKeys.map((k) => PROFILES[k].label).join(" ")}\n`);
if (cases.length < 100) console.log("⚠ 题目不足 100 道,曲线的分辨率有限");

const rows = [];
for (const key of profKeys) {
  const prof = PROFILES[key];
  const row = { 档位: prof.label };
  for (const nb of budgets) {
    let ok = 0;
    const per = {};
    for (const t of types) per[t] = { ok: 0, n: 0 };
    for (const c of cases) {
      const mv = prof.eng.aiMove({
        board: c.board.map((r) => r.slice()), side: c.side,
        difficulty: prof.diff, timeMs: 0, nodeBudget: nb,
      });
      per[c.type].n++;
      if (mv && c.keys.has(mv.r * 15 + mv.c)) { ok++; per[c.type].ok++; }
    }
    row[nb + "n"] = ((ok / cases.length) * 100).toFixed(1) + "%";
    // VCF 是唯一真吃搜索的题型,单列出来 —— 总分会被两类一步题稀释
    if (per.vcf) row[nb + "n·VCF"] = per.vcf.ok + "/" + per.vcf.n;
  }
  rows.push(row);
}
console.table(rows);
console.log("\n总分被 win1/defend 两类一步题稀释(它们在任何档都接近满分),看 VCF 那一列。");
console.log("注意:这把尺**分不开普/难/极**(实测压到 500 节点仍全对,见文件头)。");
console.log("它是地板测试 —— 任何一档从 100% 掉下来就是战术级联被改坏了。");
console.log("棋力的序关系请用 scripts/bench-tiers.mjs。");
