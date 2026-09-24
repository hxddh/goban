/**
 * C3 — 棋型引擎(v1.65)。
 *
 * C2 的叶子评估数的是「五格窗口里有几颗子」:便宜,但**看不见形状**——一个冲四加活三
 * 与两个互不相干的三,在窗口计数里可以是同一个分数。组合只能靠搜索去撞,而 5 秒里撞不到
 * 那么深:v1.64 实测极档(5 s)对难档(2 s)Elo −73、p = 0.133,加时间换不来棋力。
 *
 * C3 换掉的正是这一层:
 *
 *   棋型   每个空点、每个方向,把两侧各 4 格编成一个三进制码(空 / 己 / 挡),查一张预计算
 *          的表,得到「己方落在这里、这一方向上」的棋型:五 / 活四 / 冲四 / 活三 / 眠三 /
 *          活二 / 眠二 / 活一 / 眠一 / 死。表只有 3^8 = 6561 项,启动时递归算一次。
 *   组合   四个方向合成一个点的「组合型」:五、活四(含同线双四)、四三、冲四+、冲四、
 *          双三、活三+、活三、眠三+、双二、眠三、活二。它直接回答「这一手之后我有什么」。
 *   增量   落子只影响穿过它的 4 条线上、两侧各 4 格的空点(至多 32 个),每个只重算一个
 *          方向。各组合型的点数随之增减,于是「对手有没有成五点 / 活四点 / 四三点」是 O(1)。
 *   剪枝   对手有成五点 → 只剩那一手;对手有活四点(即有活三)→ 只看己方冲四与对手的
 *          成四点(活三的每一个防点都在其中);对手有四三点 → 再放宽到对手的成三点。
 *          在被逼的线上,树窄到几乎一条线,所以同样的时间里算得深得多。
 *   杀     原生 VCF:只走冲四,对手唯一的挡点就是下一层;根上先查己方 VCF,再用对手的
 *          VCF 过滤候选(找不到不被连四杀的手时,退回搜索的结果)。
 *
 * 规则:搜索按自由式算(与 C1 / C2 相同),连珠档的合法性由出口的 C1.legalizeRenju 保证。
 * 开局 ≤ 2 子时交给 C1 的开局册。
 * @module ai3
 */
(function (global) {
  const Core = global.GobanCore;
  const C1 = global.GobanAi;
  const nowMs = () =>
    typeof performance !== "undefined" && performance.now ? performance.now() : Date.now();

  const SZ = 15;
  const N = SZ * SZ;
  const DIRS = [[0, 1], [1, 0], [1, 1], [1, -1]];

  // --- 单方向棋型 ------------------------------------------------------------
  const DEAD = 0, B1 = 1, F1 = 2, B2 = 3, F2 = 4, B3 = 5, F3 = 6, B4 = 7, F4 = 8, FIVE = 9;

  /**
   * PAT[code]:中心为己方时,这一方向上的棋型。code 是两侧 8 格的三进制编码,
   * 位序 −4…−1、+1…+4,数字 0 空、1 己、2 挡(对方或盘外)。
   * 定义是递归的,只看穿过中心的五:
   *   五   穿过中心的某个五格全是己
   *   活四 有 ≥2 个空点,各自一落就成穿过中心的五(同线双四也算)
   *   冲四 恰有 1 个
   *   活三 / 眠三 有空点,一落成活四 / 冲四;二、一 依此类推
   */
  const PAT = new Uint8Array(6561);
  (function buildPatterns() {
    const memo = new Int8Array(6561).fill(-1);
    const line = new Int8Array(9);
    const pow3 = [1, 3, 9, 27, 81, 243, 729, 2187];
    const codeOf = () => {
      let code = 0, k = 0;
      for (let i = 0; i < 9; i++) { if (i === 4) continue; code += line[i] * pow3[k++]; }
      return code;
    };
    const fiveThroughCenter = () => {
      for (let s = 0; s <= 4; s++) {
        let ok = true;
        for (let i = s; i < s + 5; i++) if (line[i] !== 1) { ok = false; break; }
        if (ok) return true;
      }
      return false;
    };
    const ev = () => {
      const code = codeOf();
      if (memo[code] >= 0) return memo[code];
      let res;
      if (fiveThroughCenter()) res = FIVE;
      else {
        let wins = 0;
        for (let e = 0; e < 9; e++) {
          if (e === 4 || line[e] !== 0) continue;
          line[e] = 1;
          if (fiveThroughCenter()) wins++;
          line[e] = 0;
        }
        if (wins >= 2) res = F4;
        else if (wins === 1) res = B4;
        else {
          res = DEAD;
          for (let e = 0; e < 9; e++) {
            if (e === 4 || line[e] !== 0) continue;
            line[e] = 1;
            const p = ev();
            line[e] = 0;
            const down = p === F4 ? F3 : p === B4 ? B3 : p === F3 ? F2 : p === B3 ? B2 : p === F2 ? F1 : p === B2 ? B1 : DEAD;
            if (down > res) res = down;
          }
        }
      }
      memo[code] = res;
      return res;
    };
    for (let code = 0; code < 6561; code++) {
      let c = code;
      for (let i = 0; i < 9; i++) {
        if (i === 4) { line[i] = 1; continue; }
        line[i] = c % 3; c = (c / 3) | 0;
      }
      PAT[code] = ev();
    }
  })();

  // --- 组合型(四个方向合成)--------------------------------------------------
  const P_NONE = 0, P_F2 = 1, P_B3 = 2, P_22 = 3, P_B3P = 4, P_F3 = 5, P_F3P = 6,
    P_33 = 7, P_B4 = 8, P_B4P = 9, P_43 = 10, P_F4 = 11, P_FIVE = 12;
  const NP4 = 13;

  /** 单方向棋型的分值 —— 叶子评估与着法排序共用。 */
  const VAL = new Int32Array([0, 2, 6, 12, 36, 48, 150, 170, 1600, 20000]);
  /** 组合型额外加的分:组合是 C2 看不见的那一层,分值要压过单方向之和。 */
  const COMBO = new Int32Array([0, 0, 0, 60, 50, 0, 200, 900, 0, 150, 1400, 0, 0]);

  function combine(p0, p1, p2, p3) {
    const n = new Uint8Array(10);
    n[p0]++; n[p1]++; n[p2]++; n[p3]++;
    if (n[FIVE]) return P_FIVE;
    if (n[F4] || n[B4] >= 2) return P_F4;
    if (n[B4] && n[F3]) return P_43;
    if (n[B4] && (n[B3] || n[F2])) return P_B4P;
    if (n[B4]) return P_B4;
    if (n[F3] >= 2) return P_33;
    if (n[F3] && (n[B3] || n[F2])) return P_F3P;
    if (n[F3]) return P_F3;
    if (n[B3] && (n[F2] || n[B3] >= 2)) return P_B3P;
    if (n[F2] >= 2) return P_22;
    if (n[B3]) return P_B3;
    if (n[F2]) return P_F2;
    return P_NONE;
  }
  // 10^4 种方向组合,预先算好
  const P4OF = new Uint8Array(10000);
  for (let a = 0; a < 10; a++) for (let b = 0; b < 10; b++) for (let c = 0; c < 10; c++) for (let d = 0; d < 10; d++) {
    P4OF[a * 1000 + b * 100 + c * 10 + d] = combine(a, b, c, d);
  }

  // --- 邻接表:每个点、每个方向两侧各 4 格 ------------------------------------
  /** NB[(cell*4+d)*8 + k]:k = 0..3 是 −4…−1,4..7 是 +1…+4;盘外为 −1 */
  const NB = new Int16Array(N * 4 * 8);
  for (let r = 0; r < SZ; r++) for (let c = 0; c < SZ; c++) {
    const cell = r * SZ + c;
    for (let d = 0; d < 4; d++) {
      const [dr, dc] = DIRS[d];
      let k = 0;
      for (const s of [-4, -3, -2, -1, 1, 2, 3, 4]) {
        const rr = r + dr * s, cc = c + dc * s;
        NB[(cell * 4 + d) * 8 + k++] = rr >= 0 && rr < SZ && cc >= 0 && cc < SZ ? rr * SZ + cc : -1;
      }
    }
  }
  const POW3 = [1, 3, 9, 27, 81, 243, 729, 2187];

  // --- 棋盘状态(单例:worker 里一次只算一个局面)-----------------------------
  const bd = new Int8Array(N);                 // 0 空 · 1 黑 · 2 白
  const pat = new Uint8Array(2 * N * 4);       // [(side*N+cell)*4+d]
  const p4 = new Uint8Array(2 * N);            // [side*N+cell]
  const score = new Int32Array(2 * N);
  const cnt = new Int32Array(2 * NP4);         // [side*NP4 + p4] 空点计数
  const sum = new Float64Array(2);             // 各方空点分值之和
  let stones = 0;

  function lineCode(cell, d, side) {
    const base = (cell * 4 + d) * 8;
    const me = side + 1;
    let code = 0;
    for (let k = 0; k < 8; k++) {
      const nb = NB[base + k];
      const v = nb < 0 ? 2 : bd[nb] === 0 ? 0 : bd[nb] === me ? 1 : 2;
      code += v * POW3[k];
    }
    return code;
  }

  function cellOut(cell) {
    for (let s = 0; s < 2; s++) {
      const i = s * N + cell;
      sum[s] -= score[i];
      cnt[s * NP4 + p4[i]]--;
    }
  }
  function cellIn(cell) {
    for (let s = 0; s < 2; s++) {
      const i = s * N + cell;
      const b = i * 4;
      const a0 = pat[b], a1 = pat[b + 1], a2 = pat[b + 2], a3 = pat[b + 3];
      const q = P4OF[a0 * 1000 + a1 * 100 + a2 * 10 + a3];
      p4[i] = q;
      score[i] = VAL[a0] + VAL[a1] + VAL[a2] + VAL[a3] + COMBO[q];
      sum[s] += score[i];
      cnt[s * NP4 + q]++;
    }
  }
  function refreshDir(cell, d) {
    cellOut(cell);
    for (let s = 0; s < 2; s++) pat[(s * N + cell) * 4 + d] = PAT[lineCode(cell, d, s)];
    cellIn(cell);
  }

  function resetFrom(board2d) {
    stones = 0;
    for (let r = 0; r < SZ; r++) for (let c = 0; c < SZ; c++) {
      const v = board2d[r][c];
      bd[r * SZ + c] = v === "b" ? 1 : v === "w" ? 2 : 0;
      if (bd[r * SZ + c]) stones++;
    }
    cnt.fill(0); sum[0] = sum[1] = 0;
    for (let cell = 0; cell < N; cell++) {
      if (bd[cell]) {
        for (let s = 0; s < 2; s++) { p4[s * N + cell] = 0; score[s * N + cell] = 0; }
        continue;
      }
      for (let s = 0; s < 2; s++) for (let d = 0; d < 4; d++) pat[(s * N + cell) * 4 + d] = PAT[lineCode(cell, d, s)];
      // cellIn 会加计数;初始时没有旧值要减
      cellIn(cell);
    }
  }

  let nodes = 0;
  function make(cell, color) {
    cellOut(cell);
    for (let s = 0; s < 2; s++) { p4[s * N + cell] = 0; score[s * N + cell] = 0; }
    bd[cell] = color;
    stones++;
    nodes++;
    for (let d = 0; d < 4; d++) {
      const base = (cell * 4 + d) * 8;
      for (let k = 0; k < 8; k++) {
        const nb = NB[base + k];
        if (nb >= 0 && bd[nb] === 0) refreshDir(nb, d);
      }
    }
  }
  function unmake(cell) {
    bd[cell] = 0;
    stones--;
    for (let s = 0; s < 2; s++) for (let d = 0; d < 4; d++) pat[(s * N + cell) * 4 + d] = PAT[lineCode(cell, d, s)];
    cellIn(cell);
    for (let d = 0; d < 4; d++) {
      const base = (cell * 4 + d) * 8;
      for (let k = 0; k < 8; k++) {
        const nb = NB[base + k];
        if (nb >= 0 && bd[nb] === 0) refreshDir(nb, d);
      }
    }
  }

  const has = (s, q) => cnt[s * NP4 + q] > 0;
  const count = (s, q) => cnt[s * NP4 + q];
  /** 这一方能走出至少冲四的空点数(五 / 活四 / 四三 / 冲四+ / 冲四) */
  const fourPoints = (s) => count(s, P_FIVE) + count(s, P_F4) + count(s, P_43) + count(s, P_B4P) + count(s, P_B4);
  function findCell(s, q) {
    const off = s * N;
    for (let cell = 0; cell < N; cell++) if (!bd[cell] && p4[off + cell] === q) return cell;
    return -1;
  }
  function maxDir(s, cell) {
    const b = (s * N + cell) * 4;
    let m = pat[b];
    if (pat[b + 1] > m) m = pat[b + 1];
    if (pat[b + 2] > m) m = pat[b + 2];
    if (pat[b + 3] > m) m = pat[b + 3];
    return m;
  }

  // --- 置换表 -----------------------------------------------------------------
  const zob = new Int32Array(N * 2 * 2); // 两个 32 位键
  (function () {
    let x = 0x9e3779b9 | 0;
    for (let i = 0; i < zob.length; i++) {
      x ^= x << 13; x ^= x >>> 17; x ^= x << 5;
      zob[i] = x;
    }
  })();
  let h1 = 0, h2 = 0;
  const hashXor = (cell, color) => {
    const i = (cell * 2 + (color - 1)) * 2;
    h1 ^= zob[i]; h2 ^= zob[i + 1];
  };
  const TT_BITS = 20, TT_N = 1 << TT_BITS;
  const ttK = new Int32Array(TT_N), ttV = new Int32Array(TT_N), ttSc = new Int32Array(TT_N);
  // ttV: depth(8) | flag(2) | move+1(9) | gen(8)
  let ttGen = 1;
  const EXACT = 0, LOWER = 1, UPPER = 2;
  function ttGet(ply) {
    const i = h1 & (TT_N - 1);
    if (ttK[i] !== h2) return null;
    const v = ttV[i];
    if (((v >>> 19) & 0xff) !== ttGen) return null;
    let sc = ttSc[i];
    if (sc > WIN_MIN) sc -= ply; else if (sc < -WIN_MIN) sc += ply;
    return { depth: v & 0xff, flag: (v >>> 8) & 3, move: ((v >>> 10) & 0x1ff) - 1, score: sc };
  }
  function ttPut(depth, flag, move, sc, ply) {
    const i = h1 & (TT_N - 1);
    if (sc > WIN_MIN) sc += ply; else if (sc < -WIN_MIN) sc -= ply;
    ttK[i] = h2;
    ttV[i] = (depth & 0xff) | (flag << 8) | ((move + 1) << 10) | (ttGen << 19);
    ttSc[i] = sc;
  }

  // --- 预算 -------------------------------------------------------------------
  let deadline = 0, nodeCap = 0, aborted = false;
  function outOfBudget() {
    if (aborted) return true;
    if (nodeCap > 0 && nodes >= nodeCap) { aborted = true; return true; }
    if (deadline > 0 && (nodes & 511) === 0 && nowMs() >= deadline) { aborted = true; return true; }
    return false;
  }

  // --- VCF:只走冲四的连杀 ----------------------------------------------------
  let vcfNodes = 0;
  const VCF_NODE_CAP = 60000;
  /**
   * side(0 黑 / 1 白)先走,只用冲四,能否连杀。返回第一手或 −1。
   * 对手每一手都被迫挡在唯一的成五点上;对手若借挡子也成了四,下一手必须是那个挡点。
   */
  function vcf(side, depth) {
    const me = side, op = 1 - side, color = side + 1, opColor = 2 - side;
    if (has(me, P_FIVE)) return findCell(me, P_FIVE);
    if (depth <= 0 || ++vcfNodes > VCF_NODE_CAP) return -1;
    if (count(op, P_FIVE) >= 2) return -1;
    let only = -1;
    if (has(op, P_FIVE)) only = findCell(op, P_FIVE);
    const off = me * N;
    for (let cell = 0; cell < N; cell++) {
      if (bd[cell]) continue;
      if (only >= 0 && cell !== only) continue;
      const q = p4[off + cell];
      if (q < P_B4) continue;
      make(cell, color); hashXor(cell, color);
      let win = -1;
      if (count(me, P_FIVE) >= 2 && !has(op, P_FIVE)) win = cell;          // 活四 / 双四
      else if (count(me, P_FIVE) === 1) {
        const block = findCell(me, P_FIVE);
        if (!has(op, P_FIVE) || block === findCell(op, P_FIVE)) {
          make(block, opColor); hashXor(block, opColor);
          if (vcf(side, depth - 1) >= 0) win = cell;
          unmake(block); hashXor(block, opColor);
        }
      }
      unmake(cell); hashXor(cell, color);
      if (win >= 0) return win;
    }
    return -1;
  }

  // --- VCT:活三 / 冲四交替的连杀(极档)----------------------------------------
  let vctNodes = 0, vctCap = 0;
  /**
   * side 先走,只走「逼着对方应」的手(冲四,或走出活四点 = 活三),能否连杀。
   * 防守集是**全的**:对冲四只有那一个挡点;对活三,是攻方所有能走出至少冲四的点
   * (活三的每一个防点都在其中,跳三的中点也在)再加守方自己的冲四(抢先手)。
   * 所以找到的杀是严格的 —— 这正是 C1 的 VCT 做不到、只好把深度压浅的地方。
   */
  function vct(side, depth) {
    const me = side, op = 1 - side, color = side + 1, opColor = 2 - side;
    if (has(me, P_FIVE)) return findCell(me, P_FIVE);
    if (count(op, P_FIVE) >= 2) return -1;
    if (depth <= 0 || ++vctNodes > vctCap || outOfBudget()) return -1;
    vcfNodes = 0;
    const f = vcf(side, Math.min(20, depth * 2));
    if (f >= 0) return f;
    const only = has(op, P_FIVE) ? findCell(op, P_FIVE) : -1;
    // 攻方候选:走出冲四,或走出活四点(活三)的手
    const offM = me * N;
    const cand = [];
    for (let cell = 0; cell < N; cell++) {
      if (bd[cell] || (only >= 0 && cell !== only)) continue;
      const q = p4[offM + cell];
      if (q >= P_F3) cand.push(cell); // 活三及以上(含冲四、四三、活四)
    }
    cand.sort((a, b) => score[offM + b] - score[offM + a]);
    const lim = Math.min(cand.length, 10);
    const replies = new Int16Array(N);
    for (let i = 0; i < lim; i++) {
      const a = cand[i];
      make(a, color); hashXor(a, color);
      let ok = false;
      if (!has(op, P_FIVE) || (only >= 0)) {
        if (count(me, P_FIVE) >= 2 && !has(op, P_FIVE)) ok = true;
        else {
          let nr = 0;
          if (count(me, P_FIVE) === 1) replies[nr++] = findCell(me, P_FIVE);
          else if (has(me, P_F4) && !has(op, P_FIVE)) {
            const offO = op * N;
            for (let cell = 0; cell < N; cell++) {
              if (bd[cell]) continue;
              if (maxDir(me, cell) >= B4 || p4[offO + cell] >= P_B4) replies[nr++] = cell;
            }
          }
          if (nr > 0) {
            ok = true;
            for (let j = 0; j < nr && ok; j++) {
              const r = replies[j];
              make(r, opColor); hashXor(r, opColor);
              if (has(op, P_FIVE) && count(op, P_FIVE) >= 2 && !has(me, P_FIVE)) ok = false;
              else if (vct(side, depth - 1) < 0) ok = false;
              unmake(r); hashXor(r, opColor);
              if (aborted) ok = false;
            }
          }
        }
      }
      unmake(a); hashXor(a, color);
      if (ok) return a;
      if (aborted) break;
    }
    return -1;
  }

  // --- 搜索 -------------------------------------------------------------------
  const WIN = 10000000, WIN_MIN = WIN - 1000;
  const MAX_PLY = 64;
  const killers = new Int16Array(MAX_PLY * 2).fill(-1);
  const history = new Int32Array(2 * N);

  function evaluate(side) {
    const me = side, op = 1 - side;
    // 轮到的一方的威胁比对方的值钱:它下一手就能兑现
    return Math.round(sum[me] * 1.15 - sum[op]);
  }

  const moveBuf = [];
  for (let i = 0; i < MAX_PLY; i++) moveBuf.push(new Int16Array(N));
  const prioBuf = [];
  for (let i = 0; i < MAX_PLY; i++) prioBuf.push(new Int32Array(N));

  /** 生成候选,按优先级排好序,返回个数。forced 时只有挡点。 */
  function genMoves(side, ply, width, ttMove) {
    const me = side, op = 1 - side;
    const out = moveBuf[ply], pr = prioBuf[ply];
    let n = 0;
    if (has(op, P_FIVE)) {
      out[0] = findCell(op, P_FIVE);
      return 1;
    }
    const offM = me * N, offO = op * N;
    let mode = 0; // 0 常规 · 1 对手有活四点 · 2 对手有四三点
    if (has(op, P_F4)) mode = 1;
    else if (has(op, P_43)) mode = 2;
    for (let cell = 0; cell < N; cell++) {
      if (bd[cell]) continue;
      const sm = score[offM + cell], so = score[offO + cell];
      if (mode === 1) {
        // 活三的每个防点,都是对手能走出至少冲四的点;再加上己方的冲四(抢先手)
        if (maxDir(op, cell) < B4 && p4[offM + cell] < P_B4) continue;
      } else if (mode === 2) {
        if (maxDir(op, cell) < B3 && p4[offM + cell] < P_B4) continue;
      } else if (sm + so === 0) continue;
      let p = sm * 2 + so + (history[offM + cell] >> 4);
      if (cell === ttMove) p += 1 << 28;
      else if (cell === killers[ply * 2] || cell === killers[ply * 2 + 1]) p += 1 << 24;
      out[n] = cell; pr[n] = p; n++;
    }
    // 插入排序(n 通常 < 60)
    for (let i = 1; i < n; i++) {
      const c = out[i], p = pr[i];
      let j = i - 1;
      while (j >= 0 && pr[j] < p) { out[j + 1] = out[j]; pr[j + 1] = pr[j]; j--; }
      out[j + 1] = c; pr[j + 1] = p;
    }
    if (mode === 0 && n > width) n = width;
    return n;
  }

  /** 内层宽度按档位给(v1.65):档与档之间的差要落在「看得多宽」上,不只是给多少时间 */
  let inner = [16, 12, 9];
  function widthAt(ply) { return ply === 0 ? rootWidth : ply <= 2 ? inner[0] : ply <= 4 ? inner[1] : inner[2]; }
  let rootWidth = 30;

  function negamax(side, depth, alpha, beta, ply) {
    if (outOfBudget()) return 0;
    const me = side, op = 1 - side;
    if (has(me, P_FIVE)) return WIN - ply;
    const opFive = count(op, P_FIVE);
    if (opFive >= 2) return -(WIN - ply - 1);
    if (opFive === 0) {
      // 我能走出活四(或双四、四三里的活四部分),对手又没有冲四可以抢先 → 必胜
      if (has(me, P_F4) && fourPoints(op) === 0) return WIN - ply - 3;
    }
    if (ply >= MAX_PLY - 1) return evaluate(side);

    const tt = ttGet(ply);
    let ttMove = -1;
    if (tt) {
      ttMove = tt.move;
      if (tt.depth >= depth) {
        if (tt.flag === EXACT) return tt.score;
        if (tt.flag === LOWER && tt.score >= beta) return tt.score;
        if (tt.flag === UPPER && tt.score <= alpha) return tt.score;
      }
    }
    const forced = opFive === 1;
    if (depth <= 0 && !forced) return evaluate(side);

    const n = genMoves(side, ply, widthAt(ply), ttMove);
    if (n === 0) return evaluate(side);
    const moves = moveBuf[ply];
    const color = side + 1;
    const a0 = alpha;
    let best = -Infinity, bestMove = moves[0];
    for (let i = 0; i < n; i++) {
      const cell = moves[i];
      make(cell, color); hashXor(cell, color);
      // 被逼的一手不耗深度(延伸):挡五是唯一的应手,不该吃掉搜索的视野
      const nd = forced ? depth : depth - 1;
      let sc;
      if (i === 0) sc = -negamax(1 - side, nd, -beta, -alpha, ply + 1);
      else {
        sc = -negamax(1 - side, nd, -alpha - 1, -alpha, ply + 1);
        if (sc > alpha && sc < beta) sc = -negamax(1 - side, nd, -beta, -alpha, ply + 1);
      }
      unmake(cell); hashXor(cell, color);
      if (aborted) return 0;
      if (sc > best) { best = sc; bestMove = cell; }
      if (sc > alpha) alpha = sc;
      if (alpha >= beta) {
        if (cell !== killers[ply * 2]) { killers[ply * 2 + 1] = killers[ply * 2]; killers[ply * 2] = cell; }
        history[side * N + cell] += depth * depth;
        break;
      }
    }
    ttPut(depth, best <= a0 ? UPPER : best >= beta ? LOWER : EXACT, bestMove, best, ply);
    return best;
  }

  /** 根:逐层加深,每层按上一层的分数重排。返回 {cell, depth, score}。 */
  function searchRoot(side, maxDepth, candidates) {
    const color = side + 1;
    let order = candidates.slice();
    let bestCell = order[0], bestScore = -Infinity, doneDepth = 0;
    for (let depth = 2; depth <= maxDepth; depth++) {
      let alpha = -Infinity;
      const scores = [];
      let iterBest = -1, iterScore = -Infinity;
      for (let i = 0; i < order.length; i++) {
        const cell = order[i];
        make(cell, color); hashXor(cell, color);
        let sc;
        if (i === 0) sc = -negamax(1 - side, depth - 1, -Infinity, Infinity, 1);
        else {
          sc = -negamax(1 - side, depth - 1, -alpha - 1, -alpha, 1);
          if (sc > alpha) sc = -negamax(1 - side, depth - 1, -Infinity, -alpha, 1);
        }
        unmake(cell); hashXor(cell, color);
        if (aborted) break;
        scores.push({ cell, sc });
        if (sc > iterScore) { iterScore = sc; iterBest = cell; }
        if (sc > alpha) alpha = sc;
      }
      if (aborted) {
        // 未完成的一层:只有在它已经找到比上一层更好的手时才采用
        if (iterBest >= 0 && iterScore > bestScore && scores.length > 0 && scores[0].cell === order[0]) {
          bestCell = iterBest; bestScore = iterScore;
        }
        break;
      }
      bestCell = iterBest; bestScore = iterScore; doneDepth = depth;
      scores.sort((a, b) => b.sc - a.sc);
      order = scores.map((x) => x.cell);
      if (bestScore >= WIN_MIN || bestScore <= -WIN_MIN) break; // 杀已算清
    }
    return { cell: bestCell, depth: doneDepth, score: bestScore };
  }

  // --- 档位 -------------------------------------------------------------------
  function profileFor(difficulty, opts) {
    const extreme = difficulty === "extreme";
    const normal = difficulty === "normal";
    let budget;
    if (typeof opts.nodeBudget === "number" && opts.nodeBudget > 0) budget = 0;
    else if (typeof opts.timeMs === "number") budget = opts.timeMs;
    else if (extreme) budget = opts.think === "fast" ? 2500 : opts.think === "deep" ? 8000 : 5000;
    else if (normal) budget = 400;
    else budget = opts.think === "fast" ? 800 : opts.think === "deep" ? 3500 : 2000;
    return {
      budgetMs: budget,
      nodeBudget: typeof opts.nodeBudget === "number" && opts.nodeBudget > 0 ? opts.nodeBudget : 0,
      vcfDepth: extreme ? 30 : normal ? 14 : 20,
      // 极档独有:严格 VCT。难档不给 —— 两档必须分得开(v1.64 实测极 ≈ 难)
      vctDepth: extreme ? 9 : 0,
      vctCap: extreme ? 120000 : 0,
      maxDepth: extreme ? 30 : normal ? 12 : 18,
      rootWidth: extreme ? 26 : normal ? 20 : 26,
      inner: extreme ? [14, 10, 8] : normal ? [12, 9, 7] : [14, 10, 8],
      denyVct: false,
    };
  }

  let lastStage = "";
  let lastInfo = null;

  function toRC(cell) { return { r: (cell / SZ) | 0, c: cell % SZ }; }

  function aiMoveCore(opts) {
    const board2d = opts.board;
    const difficulty = opts.difficulty || "hard";
    const me2 = opts.side === "b" || opts.side === "w" ? opts.side : Core.opp(opts.humanColor || "b");
    const side = me2 === "b" ? 0 : 1;
    const op = 1 - side;
    const prof = profileFor(difficulty, opts || {});
    lastStage = ""; lastInfo = null;

    resetFrom(board2d);
    h1 = 0; h2 = 0;
    for (let cell = 0; cell < N; cell++) if (bd[cell]) hashXor(cell, bd[cell]);

    if (stones <= 2) {
      lastStage = "book";
      return C1.aiMove({ board: board2d, side: me2, difficulty: "hard", timeMs: 200, vary: false });
    }
    // 1) 成五 / 挡五
    if (has(side, P_FIVE)) { lastStage = "win"; return toRC(findCell(side, P_FIVE)); }
    if (has(op, P_FIVE)) { lastStage = "blockwin"; return toRC(findCell(op, P_FIVE)); }

    nodes = 0; aborted = false;
    deadline = prof.budgetMs > 0 ? nowMs() + prof.budgetMs : 0;
    nodeCap = prof.nodeBudget;
    ttGen = (ttGen % 250) + 1;
    killers.fill(-1);
    history.fill(0);

    // 2) 自己的冲四连杀
    vcfNodes = 0;
    const own = vcf(side, prof.vcfDepth);
    if (own >= 0) { lastStage = "vcf"; return toRC(own); }

    // 2b) 极档:自己的活三连杀(占用至多 30% 的预算)
    if (prof.vctDepth > 0) {
      const saveDeadline = deadline;
      if (deadline > 0) deadline = nowMs() + (deadline - nowMs()) * 0.3;
      vctNodes = 0; vctCap = prof.vctCap;
      const v = vct(side, prof.vctDepth);
      aborted = false;
      deadline = saveDeadline;
      if (v >= 0) { lastStage = "vct"; return toRC(v); }
    }

    // 3) 根候选;对手若有连四杀,只留下挡得住的
    rootWidth = prof.rootWidth;
    inner = prof.inner;
    let n = genMoves(side, 0, prof.rootWidth, -1);
    let cands = Array.from(moveBuf[0].subarray(0, n));
    vcfNodes = 0;
    if (vcf(op, prof.vcfDepth) >= 0) {
      const safe = [];
      // 挡连四杀要看全部空点里的防点,不只看宽度内的前几名
      const all = [];
      for (let cell = 0; cell < N; cell++) if (!bd[cell] && (score[side * N + cell] + score[op * N + cell]) > 0) all.push(cell);
      for (const cell of all) {
        make(cell, side + 1); hashXor(cell, side + 1);
        vcfNodes = 0;
        const still = has(side, P_FIVE) ? -1 : vcf(op, prof.vcfDepth);
        unmake(cell); hashXor(cell, side + 1);
        if (still < 0) safe.push(cell);
        if (deadline > 0 && nowMs() >= deadline) break;
      }
      if (safe.length) {
        const rank = new Map(cands.map((c, i) => [c, i]));
        safe.sort((a, b) => (rank.has(a) ? rank.get(a) : 999) - (rank.has(b) ? rank.get(b) : 999));
        cands = safe;
        lastStage = "deny";
      }
    }
    // 3b) 极档:对手有活三连杀(VCT)时,只留下拆得掉它的手。执白时这就是「难」与「极」
    //     的分水岭 —— 自由式黑方先手必胜,白方要活下来,靠的正是在杀成形之前拆掉它。
    if (prof.denyVct && cands.length > 1 && lastStage !== "deny") {
      const saveDeadline = deadline;
      if (deadline > 0) deadline = nowMs() + (deadline - nowMs()) * 0.35;
      vctNodes = 0; vctCap = prof.vctCap >> 1;
      const threat = vct(op, prof.vctDepth - 2);
      if (threat >= 0 && !aborted) {
        // 防点:对手的活三 / 冲四点,加上我的冲四(抢先手);逐一验证拆没拆掉
        const pool = [];
        for (let cell = 0; cell < N; cell++) {
          if (bd[cell]) continue;
          if (p4[op * N + cell] >= P_F3 || p4[side * N + cell] >= P_B4 || cell === threat) pool.push(cell);
        }
        const safe = [];
        for (const cell of pool) {
          make(cell, side + 1); hashXor(cell, side + 1);
          vctNodes = 0; vctCap = prof.vctCap >> 2;
          const still = has(side, P_FIVE) ? -1 : vct(op, prof.vctDepth - 2);
          unmake(cell); hashXor(cell, side + 1);
          if (aborted) break;
          if (still < 0) safe.push(cell);
        }
        if (!aborted && safe.length) {
          const rank = new Map(cands.map((c, i) => [c, i]));
          safe.sort((a, b) => (rank.has(a) ? rank.get(a) : 999) - (rank.has(b) ? rank.get(b) : 999));
          cands = safe;
          lastStage = "deny-vct";
        }
      }
      aborted = false;
      deadline = saveDeadline;
    }
    if (cands.length === 1) { lastStage = lastStage || "forced"; return toRC(cands[0]); }

    // 4) 搜索
    const res = searchRoot(side, prof.maxDepth, cands);
    lastStage = lastStage || "search";
    lastInfo = { depth: res.depth, score: res.score, nodes };
    return toRC(res.cell);
  }

  /** 交货前验一次:落点必须在盘内且为空。v1.65 基准里 48 局中出过一次占用点,按局面重放
   *  复现不了(取决于时限在哪一刻截断),所以在出口兜底,而不是赌它不再发生。 */
  function sane(board2d, mv) {
    if (mv && mv.r >= 0 && mv.r < SZ && mv.c >= 0 && mv.c < SZ && !board2d[mv.r][mv.c]) return mv;
    lastStage = "fallback";
    let best = null, bestSc = -1;
    for (let r = 0; r < SZ; r++) for (let c = 0; c < SZ; c++) {
      if (board2d[r][c]) continue;
      const cell = r * SZ + c;
      const sc = score[cell] + score[N + cell];
      if (sc > bestSc) { bestSc = sc; best = { r, c }; }
    }
    return best;
  }

  function aiMove(opts) {
    // 出口闸与 C1 / C2 共用:对称变化只在最外层做一次,禁手合法性在最后验
    return C1.legalizeRenju(opts, C1.varyBySymmetry(opts.board, sane(opts.board, aiMoveCore(opts)), opts));
  }

  global.GobanAi3 = {
    aiMove,
    lastStage: () => lastStage,
    lastInfo: () => lastInfo,
    profileFor,
    _debug: { sane, PAT, P4OF, resetFrom, make, unmake, p4, pat, cnt, vcf, evaluate, bd, codes: { DEAD, B1, F1, B2, F2, B3, F3, B4, F4, FIVE }, combos: { P_NONE, P_F2, P_B3, P_22, P_B3P, P_F3, P_F3P, P_33, P_B4, P_B4P, P_43, P_F4, P_FIVE } },
  };
})(typeof window !== "undefined" ? window : globalThis);

/**
 * 档位 → 引擎,全应用只此一处(app.js、ai-worker.js、评测脚本都读它)。
 * 此前这张表写在三处(app.js 的 engineFor、worker 的 dispatch、bench 的 TIERS),
 * 改档位要记得改三遍。
 *   简 —— C1(掷骰子式的弱,v1.66 重做)
 *   普 / 难 / 极 —— C3
 */
(function (global) {
  global.GobanTier = {
    engineFor: function (difficulty) {
      if (difficulty === "easy") return global.GobanAi;
      return global.GobanAi3 || global.GobanAi2 || global.GobanAi;
    },
  };
})(typeof window !== "undefined" ? window : globalThis);
