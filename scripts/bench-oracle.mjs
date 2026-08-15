/**
 * 逐手裁决尺 —— 用一个「宽预言机」给单个局面判对错，而不是靠整盘胜负。
 *
 * ## 为什么需要它
 *
 * `bench-tiers.mjs` 那把对局尺已经走到分辨力的尽头：12 对配对里 9 对下成平局、
 * 还要判废 2–4 对，真正分出胜负的只有 **3 对**。实测证据是评估权重表那次 A/B ——
 * 「抬高四的权重」与「压低四的权重」两个方向相反的变体，给出了**逐字相同**的
 * 1胜9平2负、p=0.500。反证组和主组不可区分，说明尺子在那个尺度上没有信号，
 * 而不是说明权重表无效。
 *
 * 根因是对局这个信号太稀疏：几十手棋只产出一个 0/1。这把尺改成每个局面出一个
 * 信号。
 *
 * ## 预言机是什么，为什么它有资格当参照
 *
 * 它不是「同一引擎跑更深/更多预算」——那条路已经被实测证伪：
 *
 *   - maxDepth 14 → 24：59 个局面 **0 处改变**，耗时 100s → 99s
 *   - nodeBudget 20 万 → 200 万：**0 处改变**
 *
 * 搜索在这些局面上已经收敛，树被剪完了。唯一被证明能改变行为的维度是**宽度**
 * （根宽 28→34 是 v1.57.0 唯一有效的改动，配对合池 p≈0.011）。所以预言机 =
 * 把宽度开到远超可交互的程度（根宽 72、内层 24/28/32、60 万节点），每手约 33 秒。
 * 它慢到不可能出厂，但正因如此才有资格当参照。
 *
 * 实测它确实和出厂档不是一回事：安静局面上 难 与它同手 55%、极 45%。
 *
 * ## 三条必须知道的边界
 *
 * 1. **「与预言机同手」尚未被证明和棋力正相关。** 首轮 33 个局面里，已知更强的
 *    极档(15/33) 反而比难档(18/33) 同手率低 —— 差 3 个在这个样本量下是噪声，
 *    但它足以说明这把尺**必须先自证**。`--validate` 就是干这个的：极(根宽34) 在
 *    这把尺上必须胜过 极(根宽28)，因为那个差已经用对局尺证到 p≈0.011。自证不过，
 *    这把尺作废，不许改判据去凑。
 *
 * 2. **只裁决「安静局面」。** forcedMove 或 findVCF 能直接拍板的手被排除 ——
 *    那些手四个档都走一样，量的是战术级联不是搜索。
 *
 * 3. **预言机只在两边分歧的局面上跑。** McNemar 只用得上分歧样本，一致的局面
 *    问预言机是纯浪费。实测分歧率约 9%，这把成本砍掉约 11 倍。答案按局面缓存
 *    在 scripts/baseline/oracle-cache.json，越用越便宜。
 *
 * ## 确定性
 *
 * 全程 `vary: false`。C2 的搜索本身是确定的——不确定性全部来自出口那层
 * `varyBySymmetry` 的 Math.random，关掉后同局面跑三遍逐字相同（实测 12/12）。
 * 所以题面可复现、缓存可信。
 *
 * 用法：
 *   node scripts/bench-oracle.mjs --validate            自证(极34 应胜 极28)
 *   node scripts/bench-oracle.mjs --ab S=0,2,14,90,1400 比一个权重表变体
 *   环境变量 POSITIONS(默认 240) · ORACLE_NODES(默认 600000)
 *
 * @module bench-oracle
 */
import fs from "fs";
import path from "path";
import vm from "vm";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const CACHE_PATH = path.join(ROOT, "scripts/baseline/oracle-cache.json");

const SRC = {};
for (const f of ["version", "i18n", "core", "sgf", "ai", "ai2"])
  SRC[f] = fs.readFileSync(path.join(ROOT, "src/web/js/" + f + ".js"), "utf8");

// 补丁锚点。每一处都必须命中，否则抛错 —— 在未打上补丁的引擎上出数，
// 得到的会是「变体和原样一模一样」这种看着像结论的假象。
const ANCHOR_ROOTWIDTH = "rootWidth: extreme ? 34 : 28,";
const ANCHOR_CAP = "const cap = depth >= 6 ? 10 : depth >= 3 ? 14 : 16;";
const ANCHOR_S = "const S = [0, 2, 14, 90, 700, 0];";

/**
 * 造一台引擎。null 表示「仓库现状，一个字节不改」。
 * @param {{rootWidth?:number, caps?:number[], S?:number[]}} [patch]
 */
export function makeEngine(patch) {
  const c = { console, Date, performance };
  c.globalThis = c;
  c.window = c;
  vm.createContext(c);
  for (const f of ["version", "i18n", "core", "sgf", "ai"])
    vm.runInContext(SRC[f], c, { filename: f });
  let s = SRC.ai2;
  const hit = (anchor, next) => {
    if (!s.includes(anchor)) throw new Error(`补丁锚点没命中: ${anchor}`);
    s = s.replace(anchor, next);
  };
  if (patch && patch.rootWidth != null)
    hit(ANCHOR_ROOTWIDTH, `rootWidth: extreme ? ${patch.rootWidth} : 28,`);
  if (patch && patch.caps)
    hit(
      ANCHOR_CAP,
      `const cap = depth >= 6 ? ${patch.caps[0]} : depth >= 3 ? ${patch.caps[1]} : ${patch.caps[2]};`
    );
  if (patch && patch.S) hit(ANCHOR_S, `const S = [${patch.S.join(", ")}, 0];`);
  vm.runInContext(s, c, { filename: "ai2.js" });
  return { Core: c.GobanCore, C1: c.GobanAi, Ai2: c.GobanAi2 };
}

/** 预言机：宽度开到远超可交互的程度。慢到不可能出厂，正因如此才有资格当参照。 */
export const ORACLE_PATCH = { rootWidth: 72, caps: [24, 28, 32] };
export const ORACLE_NODES = Number(process.env.ORACLE_NODES || 600000);

const boardKey = (board, side) => board.map((r) => r.map((x) => x || ".").join("")).join("/") + "|" + side;

/** 8 种对称下的最小串 —— 只用来给题面去重，缓存仍按原样局面存，避免变换错位。 */
function canonical(board) {
  const T = [
    (r, c) => [r, c],
    (r, c) => [c, 14 - r],
    (r, c) => [14 - r, 14 - c],
    (r, c) => [14 - c, r],
    (r, c) => [r, 14 - c],
    (r, c) => [14 - r, c],
    (r, c) => [c, r],
    (r, c) => [14 - c, 14 - r],
  ];
  let best = null;
  for (const t of T) {
    const g = Array.from({ length: 15 }, () => Array(15).fill("."));
    for (let r = 0; r < 15; r++)
      for (let c = 0; c < 15; c++) {
        if (!board[r][c]) continue;
        const [rr, cc] = t(r, c);
        g[rr][cc] = board[r][c];
      }
    const s = g.map((x) => x.join("")).join("");
    if (best === null || s < best) best = s;
  }
  return best;
}

/**
 * 安静局面题面：引擎自战产生自然棋形，排除 forcedMove / findVCF 能直接拍板的手
 * （那些手四档走一样，量的是级联不是搜索），再按 8 种对称去重。
 *
 * 开局册必须够大。首版只用了 22 条两子开局，**要 240 个局面只拿到 59** ——
 * `vary:false` 下引擎是确定的，不同开局大量收敛到同一条线，对称去重之后所剩无几。
 * 题面不够直接导致自证失败（分歧 5 个、可判样本 4 个、p=0.313），那不是引擎的问题
 * 也不是预言机的问题，是题面供给的问题。
 *
 * 所以改成**三子开局枚举 × 两种走子档**：第三子把分叉打开，难/极交替走子让同一开局
 * 也长出不同的中盘。三子开局先按对称去重，避免把同一个开局算好几遍。
 */
export function positions(limit) {
  const E = makeEngine(null);
  const { Core, C1, Ai2 } = E;
  const out = [];
  const seen = new Set();
  const seenOpen = new Set();
  const OFF = [
    [0, 1], [1, 1], [0, 2], [1, 2], [2, 2], [-1, 1], [-1, 2], [-2, 2],
    [0, -1], [1, -1], [2, 0], [2, 1], [0, 3], [3, 3], [1, 3], [2, 3],
  ];
  /** 三子开局（黑中心 → 白 → 黑），按 8 种对称去重。 */
  const OPENS = [];
  for (const [dr, dc] of OFF)
    for (const [er, ec] of OFF) {
      const w = [7 + dr, 7 + dc];
      const b2 = [7 + er, 7 + ec];
      if (w[0] === b2[0] && w[1] === b2[1]) continue;
      if (b2[0] === 7 && b2[1] === 7) continue;
      const g = Core.emptyBoard();
      g[7][7] = "b";
      g[w[0]][w[1]] = "w";
      g[b2[0]][b2[1]] = "b";
      const k = canonical(g);
      if (seenOpen.has(k)) continue;
      seenOpen.add(k);
      OPENS.push([[7, 7], w, b2]);
    }
  // 「安静」判据要跑在每一手上，所以它必须便宜。findVCF 不给 ctx 就是无限预算，
  // 首版正是这里把生成拖到 400 个局面跑不完 900 秒。给一个 eval 配额即可 ——
  // 这个判据只用来筛掉「级联直接拍板」的手，漏掉几个深 VCF 不影响结论方向。
  const quiet = (bd, side) =>
    !C1.forcedMove(C1.cloneBoard(bd), side) &&
    !C1.findVCF(C1.cloneBoard(bd), side, 8, { t1: 0, e1: C1.ticks() + 30000 });
  outer: for (const open of OPENS) {
    // 两个走子器故意选不同引擎：C2 难档给深棋形，C1 普档便宜且棋形不同，
    // 同一开局因此长出两条中盘，题面供给翻倍而成本只加一点。
    for (const drive of [
      { E: Ai2, d: "hard", nb: 40000 },
      { E: C1, d: "normal", nb: 8000 },
    ]) {
      if (out.length >= limit) break outer;
      const bd = Core.emptyBoard();
      let side = "b";
      let bad = false;
      for (const [r, c] of open) {
        if (r < 0 || r > 14 || c < 0 || c > 14 || bd[r][c]) { bad = true; break; }
        bd[r][c] = side;
        side = Core.opp(side);
      }
      if (bad) continue;
      for (let ply = open.length; ply < 28 && out.length < limit; ply++) {
        if (quiet(bd, side)) {
          const k = canonical(bd) + "|" + side;
          if (!seen.has(k)) {
            seen.add(k);
            out.push({ board: C1.cloneBoard(bd), side });
          }
        }
        const mv = drive.E.aiMove({
          board: bd, side, difficulty: drive.d, timeMs: 0,
          nodeBudget: drive.nb, vary: false,
        });
        if (!mv || bd[mv.r][mv.c]) break;
        bd[mv.r][mv.c] = side;
        if (Core.findWin(bd, mv.r, mv.c, side)) break;
        side = Core.opp(side);
      }
    }
  }
  return out;
}

function loadCache() {
  try {
    return JSON.parse(fs.readFileSync(CACHE_PATH, "utf8"));
  } catch {
    return {};
  }
}
function saveCache(cache) {
  fs.mkdirSync(path.dirname(CACHE_PATH), { recursive: true });
  fs.writeFileSync(CACHE_PATH, JSON.stringify(cache, null, 0) + "\n");
}

/** 预言机裁决一个局面，命中缓存就不算。返回 "r,c"。 */
export function adjudicate(oracle, C1, p, cache) {
  const k = boardKey(p.board, p.side);
  if (cache[k]) return cache[k];
  const mv = oracle.Ai2.aiMove({
    board: C1.cloneBoard(p.board), side: p.side,
    difficulty: "extreme", timeMs: 0, nodeBudget: ORACLE_NODES, vary: false,
  });
  const v = mv ? `${mv.r},${mv.c}` : "-";
  cache[k] = v;
  return v;
}

/** 精确二项符号检验的单尾 p（McNemar 的精确版）。 */
export function signTestP(a, b) {
  const n = a + b;
  if (!n) return 1;
  const lc = (N, k) => {
    let s = 0;
    for (let i = 0; i < k; i++) s += Math.log(N - i) - Math.log(i + 1);
    return s;
  };
  let p = 0;
  for (let k = Math.max(a, b); k <= n; k++) p += Math.exp(lc(n, k) - n * Math.log(2));
  return p;
}

/**
 * 比两台引擎。只在两边分歧的局面上问预言机 —— 一致的局面对 McNemar 没有贡献。
 * @returns {{n:number, disc:number, aOnly:number, bOnly:number, neither:number, p:number}}
 */
export function compare(A, B, pos, opts) {
  const nodes = (opts && opts.nodes) || 100000;
  const diff = (opts && opts.difficulty) || "extreme";
  const cache = loadCache();
  const oracle = makeEngine(ORACLE_PATCH);
  const C1 = A.C1;
  let disc = 0, aOnly = 0, bOnly = 0, neither = 0, misses = 0, done = 0;
  const t0 = Date.now();
  for (const p of pos) {
    // 进度必须打出来。这把尺的每一步都是几十分钟量级，静默的长跑分不清
    // 「还在算」和「卡死了」——首版就因此白等了两轮 900 秒。
    if (++done % 50 === 0)
      console.log(
        `  …${done}/${pos.length} · 分歧 ${disc} · 新裁决 ${misses} · ${((Date.now() - t0) / 1000).toFixed(0)}s`
      );
    const ask = (E) =>
      E.Ai2.aiMove({
        board: C1.cloneBoard(p.board), side: p.side,
        difficulty: diff, timeMs: 0, nodeBudget: nodes, vary: false,
      });
    const a = ask(A), b = ask(B);
    if (!a || !b) continue;
    const ka = `${a.r},${a.c}`, kb = `${b.r},${b.c}`;
    if (ka === kb) continue; // 一致 —— McNemar 用不上，不问预言机
    disc++;
    if (!cache[boardKey(p.board, p.side)]) misses++;
    const truth = adjudicate(oracle, C1, p, cache);
    if (ka === truth) aOnly++;
    else if (kb === truth) bOnly++;
    else neither++;
  }
  saveCache(cache);
  return { n: pos.length, disc, aOnly, bOnly, neither, misses, p: signTestP(aOnly, bOnly) };
}

function report(label, r) {
  console.log(label);
  console.log(
    `  安静局面 ${r.n} · 分歧 ${r.disc} (${((100 * r.disc) / Math.max(1, r.n)).toFixed(0)}%)` +
      ` · 新裁决 ${r.misses}`
  );
  console.log(
    `  A 中 ${r.aOnly} · B 中 ${r.bOnly} · 都不中 ${r.neither}` +
      ` · 单尾 p=${r.aOnly + r.bOnly ? r.p.toFixed(3) : "—"}`
  );
}

if (process.argv[1] && process.argv[1].endsWith("bench-oracle.mjs")) {
  const N = Number(process.env.POSITIONS || 240);
  const t0 = Date.now();
  const pos = positions(N);
  console.log(`题面 ${pos.length} 个安静局面（已排除级联拍板的手、按 8 种对称去重）`);
  const arg = process.argv.slice(2);
  if (arg.includes("--validate")) {
    // 自证：这个差已经用对局尺证到 p≈0.011，这把尺必须也认得出来。
    const r = compare(makeEngine(null), makeEngine({ rootWidth: 28 }), pos);
    report("自证：极(根宽 34，仓库现状) vs 极(根宽 28)", r);
    const ok = r.aOnly > r.bOnly && r.p < 0.05;
    console.log(
      ok
        ? "→ 自证通过：这把尺认得出一个已知为真的差"
        : "→ 自证不通过：这把尺不可用，不要拿它的数去做决定"
    );
  } else {
    const ab = arg.find((x) => x.startsWith("--ab"));
    const val = ab ? (arg[arg.indexOf(ab) + 1] || ab.split("=")[1]) : null;
    if (!val) {
      console.log("用法: --validate | --ab S=0,2,14,90,1400");
      process.exit(2);
    }
    const S = val.replace(/^S=/, "").split(",").map(Number);
    const r = compare(makeEngine({ S }), makeEngine(null), pos);
    report(`变体 S=[${S.join(",")}] vs 仓库现状 S=[0,2,14,90,700]`, r);
  }
  console.log(`耗时 ${((Date.now() - t0) / 1000).toFixed(0)}s`);
}
