/**
 * 绝对标尺:各档对 Rapfi(Gomocup 冠军引擎,开源)对打,配对计分。
 *
 *   RAPFI=/path/to/pbrain-rapfi node scripts/bench-rapfi.mjs
 *   RAPFI=… TIERS=hard,ext MS=20,100 OPENINGS=12 node scripts/bench-rapfi.mjs
 *   RAPFI=… REF=v1.64.0 node scripts/bench-rapfi.mjs        # 用旧版引擎(从 git 取)
 *
 * 为什么要它:`bench-tiers` 只量档与档之间的差,v1.64 评估里「极 ≈ 难」就是它量出来的,
 * 但它回答不了「难到底有多难」。Rapfi 在不同思考时间下是一串稳定的强度刻度,拿各档去对它,
 * 得到的是**绝对**位置:某档 ≈ Rapfi 多少毫秒。
 *
 * Rapfi 不在仓库里(C++,需自行编译并配好 config.toml + 权重,见其 README);没有设 RAPFI 时
 * 本脚本直接跳过,不进 CI。协议是 Piskvork:每手发一次 BOARD(整盘),无状态,
 * 所以一个进程能下完全部对局。规则 `INFO rule 0` = 自由式(五连及以上胜),与本应用的「自由」一致。
 *
 * 计分与 bench-tiers 相同:同一开局正反各一局,两局全赢 +1、一胜一负 0、两局全输 −1;
 * 另报逐局得分率与由此反推的 Elo(相对 Rapfi@该时限)。
 */
import fs from "fs";
import os from "os";
import path from "path";
import vm from "vm";
import { spawn, execFileSync } from "child_process";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");
const RAPFI = process.env.RAPFI;
if (!RAPFI || !fs.existsSync(RAPFI)) {
  console.log("SKIP: 设 RAPFI=/path/to/pbrain-rapfi 才能跑(与 config.toml、权重同目录)");
  process.exit(0);
}
const num = (k, d) => (process.env[k] ? Number(process.env[k]) : d);

// ── 引擎:工作区的,或者某个 git ref 的 ────────────────────────────────────
function loadEngines(ref) {
  const ctx = { console, Date, performance };
  ctx.globalThis = ctx; ctx.window = ctx;
  vm.createContext(ctx);
  const files = ["core.js", "ai.js", "ai2.js"];
  if (fs.existsSync(path.join(root, "src/web/js/ai3.js"))) files.push("ai3.js");
  for (const f of files) {
    let src;
    if (ref) {
      try { src = execFileSync("git", ["show", `${ref}:src/web/js/${f}`], { cwd: root, encoding: "utf8", maxBuffer: 1 << 26 }); }
      catch (_) { continue; } // 旧版本没有这个文件
    } else src = fs.readFileSync(path.join(root, "src/web/js", f), "utf8");
    vm.runInContext(src, ctx, { filename: f });
  }
  return ctx;
}
const E = loadEngines(process.env.REF || "");
const Core = E.GobanCore;
/** 档位的路由与发布档一致:由 app.js 的 engineFor 决定;这里复刻,新版本若有 GobanEngineFor 就用它。 */
function engineFor(diff) {
  if (E.GobanTier && E.GobanTier.engineFor) return E.GobanTier.engineFor(diff);
  return diff === "hard" || diff === "extreme" ? E.GobanAi2 : E.GobanAi;
}
const TIER = {
  easy: { diff: "easy", ms: 0 }, normal: { diff: "normal", ms: 250 },
  hard: { diff: "hard", ms: 2000 }, ext: { diff: "extreme", ms: 5000 },
};

// ── Rapfi 进程 ───────────────────────────────────────────────────────────
class Rapfi {
  constructor(bin) { this.bin = bin; this.spawn(); }
  spawn() {
    this.p = spawn(this.bin, [], { cwd: path.dirname(this.bin), stdio: ["pipe", "pipe", "ignore"] });
    this.buf = ""; this.waiters = [];
    this.p.stdout.on("data", (d) => {
      this.buf += d.toString();
      let i;
      while ((i = this.buf.indexOf("\n")) >= 0) {
        const line = this.buf.slice(0, i).trim(); this.buf = this.buf.slice(i + 1);
        if (!line || /^(MESSAGE|DEBUG|INFO)/.test(line)) continue;
        const w = this.waiters.shift(); if (w) w(line);
      }
    });
  }
  send(s) { this.p.stdin.write(s + "\n"); }
  next() { return new Promise((r) => this.waiters.push(r)); }
  /** 协议出错(实测偶发一次 Unknown command)时整个进程重开:那一局作废,之后的局面照旧可信 */
  async restart() { try { this.p.kill(); } catch (_) {} this.spawn(); await this.init(this.ms); }
  async init(ms) {
    this.ms = ms;
    this.send("START 15"); await this.next();
    this.send("INFO rule 0");
    this.send("INFO timeout_turn " + ms);
    this.send("INFO timeout_match 100000000");
    this.send("INFO max_memory 268435456");
    this.send("INFO thread_num 1");
  }
  /** 整盘发过去,拿回它(side)的一手。 */
  async move(board, side) {
    // Rapfi 回完一手后还要收尾一小会儿;这时到的 BOARD 会被吞掉,后面的坐标行就成了
    // 「Unknown command」。对手是即时落子的简档时每一局都会撞上。等 40ms 再发。
    await new Promise((r) => setTimeout(r, 40));
    this.send("BOARD");
    for (let r = 0; r < 15; r++) for (let c = 0; c < 15; c++) {
      const s = board[r][c];
      if (s) this.send(c + "," + r + "," + (s === side ? 1 : 2));
    }
    this.send("DONE");
    const line = await this.next();
    const m = /^(\d+),(\d+)$/.exec(line);
    if (!m) { console.error("rapfi 协议出错,重开:" + line); await this.restart(); return null; }
    return { r: Number(m[2]), c: Number(m[1]) };
  }
  close() { this.send("END"); this.p.kill(); }
}

// ── 开局册(与 bench-tiers 同一套对称去重的三子开局)────────────────────
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

async function playGame(black, white, open) {
  const bd = Core.emptyBoard(); let side = "b";
  for (const [r, c] of open) { bd[r][c] = side; side = Core.opp(side); }
  for (let ply = open.length; ply < 225; ply++) {
    const who = side === "b" ? black : white;
    const mv = await who(bd, side);
    if (!mv || bd[mv.r][mv.c]) return { w: "err" };
    bd[mv.r][mv.c] = side;
    if (Core.findWin(bd, mv.r, mv.c, side)) return { w: side, n: ply + 1 };
    if (Core.boardFull(bd)) return { w: "draw" };
    side = Core.opp(side);
  }
  return { w: "draw" };
}

const tiers = (process.env.TIERS || "normal,hard,ext").split(",");
const limits = (process.env.MS || "20,100").split(",").map(Number);
const book = openingBook(num("OPENINGS", 12));
const rapfi = new Rapfi(RAPFI);
console.log(`引擎 ${process.env.REF || "工作区"} · 开局 ${book.length} 个 × 正反 · 各档按发布时限(简 0 / 普 250 / 难 2000 / 极 5000 ms)`);
const rows = [];
for (const ms of limits) {
  await rapfi.init(ms);
  const R = (bd, side) => rapfi.move(bd, side);
  for (const t of tiers) {
    const cfg = TIER[t];
    const eng = engineFor(cfg.diff);
    const A = async (bd, side) => eng.aiMove({ board: bd, side, difficulty: cfg.diff, timeMs: cfg.ms || undefined, vary: false });
    let pw = 0, pl = 0, pt = 0, pts = 0, games = 0, errs = 0;
    for (const op of book) {
      const g1 = await playGame(A, R, op);   // 档执黑
      const g2 = await playGame(R, A, op);   // 档执白
      const s1 = g1.w === "b" ? 1 : g1.w === "draw" ? 0.5 : 0;
      const s2 = g2.w === "w" ? 1 : g2.w === "draw" ? 0.5 : 0;
      errs += (g1.w === "err") + (g2.w === "err");
      // 协议出错的局作废,不算任何一方的分;配对里有一局作废,整对不计
      if (g1.w === "err" || g2.w === "err") continue;
      pts += s1 + s2; games += 2;
      if (s1 === 1 && s2 === 1) pw++; else if (s1 === 0 && s2 === 0) pl++; else pt++;
    }
    const p = pts / games;
    const elo = p <= 0 ? -Infinity : p >= 1 ? Infinity : -400 * Math.log10(1 / p - 1);
    rows.push({ 对手: "Rapfi@" + ms + "ms", 档: t, 配对: `${pw}胜 ${pt}平 ${pl}负`, 得分率: (p * 100).toFixed(0) + "%",
      Elo: Number.isFinite(elo) ? (elo >= 0 ? "+" : "") + elo.toFixed(0) : (elo > 0 ? "+∞" : "−∞"), errs });
    console.log(JSON.stringify(rows[rows.length - 1]));
  }
}
rapfi.close();
console.table(rows);
