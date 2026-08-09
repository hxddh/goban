/**
 * C2 — incremental window-count engine for hard/extreme.
 *
 * Board is a flat Int8Array(225); every 5-cell window (572 of them) keeps
 * per-color stone counts maintained incrementally on make/unmake, so leaf
 * evaluation is O(1) and threat facts (a five, a four-with-win-cell) are
 * plain counters. Search is negamax + TT + killers + iterative deepening.
 * The battle-tested C1 tactical cascade (forced hierarchy, VCF/VCT, deny)
 * still runs at the root via GobanAi exports; C2 replaces the starved
 * shallow α-β underneath it.
 * @module ai2
 */
(function (global) {
  const Core = global.GobanCore;
  const C1 = global.GobanAi;
  /**
   * Clock aligned with C1's nowMs (performance.now when available). C2 once
   * mixed Date.now() deadlines with C1's performance.now() timedOut() —
   * epoch vs monotonic milliseconds — so C1 cascade stages NEVER expired in
   * real browsers: the "stuck thinking forever" bug.
   */
  const nowMs = () =>
    typeof performance !== "undefined" && performance.now ? performance.now() : Date.now();
  const SZ = 15;
  const N = SZ * SZ;
  const B = 1;
  const W = 2;
  const WINV = 1e9;

  // --- window precompute ----------------------------------------------------
  /** winCells[w*5..w*5+4] = cell indices of window w */
  const winCells = [];
  /** cellWins[idx] = array of window ids containing idx */
  const cellWins = new Array(N);
  for (let i = 0; i < N; i++) cellWins[i] = [];
  (function build() {
    const dirs = [
      [0, 1],
      [1, 0],
      [1, 1],
      [1, -1],
    ];
    for (const [dr, dc] of dirs) {
      for (let r = 0; r < SZ; r++)
        for (let c = 0; c < SZ; c++) {
          const r4 = r + dr * 4,
            c4 = c + dc * 4;
          if (r4 < 0 || r4 >= SZ || c4 < 0 || c4 >= SZ) continue;
          const w = winCells.length / 5;
          for (let k = 0; k < 5; k++) {
            const idx = (r + dr * k) * SZ + (c + dc * k);
            winCells.push(idx);
            cellWins[idx].push(w);
          }
        }
    }
  })();
  const NW = winCells.length / 5;

  // --- zobrist / TT ---------------------------------------------------------
  const zob = new Uint32Array(N * 2 + 1);
  (function () {
    let s = 0xc2feed5 >>> 0;
    for (let i = 0; i < zob.length; i++) {
      s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
      zob[i] = s;
    }
  })();
  const ZSIDE = N * 2;
  const TT_N = 1 << 20;
  const ttKey = new Int32Array(TT_N);
  const ttDep = new Int8Array(TT_N);
  const ttFlg = new Int8Array(TT_N);
  const ttSc = new Float64Array(TT_N);
  const ttMv = new Int16Array(TT_N);
  const ttGenA = new Int32Array(TT_N);
  let ttGen = 1;
  const EX = 0,
    LO = 1,
    UP = 2;

  // --- engine state (module-level; single-threaded) -------------------------
  const bd = new Int8Array(N);
  const wCnt = new Uint8Array(NW * 2); // [w*2]=black stones, [w*2+1]=white
  const nearCnt = new Uint8Array(N); // stones within chebyshev 2
  /** windows with own=4/5 & opp=0, per color: four ⇒ a win cell exists */
  const four = new Int32Array(3);
  const five = new Int32Array(3);
  let hash = 0;
  let tick = 0;
  let stones = 0;
  /** per-window score by own count (opponent-free windows only) */
  const S = [0, 2, 14, 90, 700, 0];

  function winScore(w) {
    const b = wCnt[w * 2],
      wv = wCnt[w * 2 + 1];
    if (b && wv) return 0;
    return b ? S[b] : wv ? -S[wv] : 0; // signed: +black −white
  }

  function resetFrom(board2d) {
    bd.fill(0);
    wCnt.fill(0);
    nearCnt.fill(0);
    four.fill(0);
    five.fill(0);
    sTot = 0;
    hash = 0;
    stones = 0;
    for (let r = 0; r < SZ; r++)
      for (let c = 0; c < SZ; c++) {
        const s = board2d[r][c];
        if (!s) continue;
        placeInit(r * SZ + c, s === "b" ? B : W);
      }
  }

  function bumpNear(idx, d) {
    const r = (idx / SZ) | 0,
      c = idx % SZ;
    for (let dr = -2; dr <= 2; dr++) {
      const rr = r + dr;
      if (rr < 0 || rr >= SZ) continue;
      for (let dc = -2; dc <= 2; dc++) {
        if (!dr && !dc) continue;
        const cc = c + dc;
        if (cc < 0 || cc >= SZ) continue;
        nearCnt[rr * SZ + cc] += d;
      }
    }
  }

  /** signed window-score total: + good for black, − good for white */
  let sTot = 0;


  function placeInit(idx, color) {
    bd[idx] = color;
    stones++;
    hash = (hash ^ zob[(color === B ? 0 : N) + idx]) >>> 0;
    bumpNear(idx, 1);
    const wins = cellWins[idx];
    for (let i = 0; i < wins.length; i++) {
      const w = wins[i];
      sTot -= winScore(w);
      const cb = wCnt[w * 2],
        cw = wCnt[w * 2 + 1];
      if (cw === 0 && cb === 4) four[B]--;
      if (cb === 0 && cw === 4) four[W]--;
      if (cw === 0 && cb === 5) five[B]--;
      if (cb === 0 && cw === 5) five[W]--;
      wCnt[w * 2 + (color === B ? 0 : 1)]++;
      const nb = wCnt[w * 2],
        nw = wCnt[w * 2 + 1];
      if (nw === 0 && nb === 4) four[B]++;
      if (nb === 0 && nw === 4) four[W]++;
      if (nw === 0 && nb === 5) five[B]++;
      if (nb === 0 && nw === 5) five[W]++;
      sTot += winScore(w);
    }
  }

  function make(idx, color) {
    tick++;
    placeInit(idx, color);
  }

  function unmake(idx, color) {
    bd[idx] = 0;
    stones--;
    hash = (hash ^ zob[(color === B ? 0 : N) + idx]) >>> 0;
    bumpNear(idx, -1);
    const wins = cellWins[idx];
    for (let i = 0; i < wins.length; i++) {
      const w = wins[i];
      sTot -= winScore(w);
      const cb = wCnt[w * 2],
        cw = wCnt[w * 2 + 1];
      if (cw === 0 && cb === 4) four[B]--;
      if (cb === 0 && cw === 4) four[W]--;
      if (cw === 0 && cb === 5) five[B]--;
      if (cb === 0 && cw === 5) five[W]--;
      wCnt[w * 2 + (color === B ? 0 : 1)]--;
      const nb = wCnt[w * 2],
        nw = wCnt[w * 2 + 1];
      if (nw === 0 && nb === 4) four[B]++;
      if (nb === 0 && nw === 4) four[W]++;
      if (nw === 0 && nb === 5) five[B]++;
      if (nb === 0 && nw === 5) five[W]++;
      sTot += winScore(w);
    }
  }

  function evalSide(side) {
    const base = side === B ? sTot : -sTot;
    return base + 24; // small tempo bonus for the side to move
  }

  // --- move generation ------------------------------------------------------
  /** ordering gain of playing color at idx (attack + weighted defense) */
  function moveGain(idx, color) {
    const wins = cellWins[idx];
    let g = 0;
    const oc = color === B ? 0 : 1;
    const xc = 1 - oc;
    for (let i = 0; i < wins.length; i++) {
      const w = wins[i];
      const own = wCnt[w * 2 + oc],
        opp = wCnt[w * 2 + xc];
      if (own && opp) continue;
      if (!opp) {
        // attacking upgrade
        if (own === 4) g += 1e7; // completes five
        else g += (S[own + 1] - S[own]) * 2;
      }
      if (!own && opp) {
        // blocking value: kill an opponent-pure window
        if (opp === 4) g += 5e6; // blocks their win cell
        else g += S[opp] * 1.4;
      }
    }
    return g;
  }

  const MAXPLY = 48;
  const mIdx = [];
  const mSc = [];
  for (let i = 0; i < MAXPLY; i++) {
    mIdx.push(new Int16Array(240));
    mSc.push(new Float64Array(240));
  }
  const killers = new Int16Array(MAXPLY * 2).fill(-1);

  function genMoves(ply, color, cap, ttMove) {
    const idxA = mIdx[ply],
      scA = mSc[ply];
    let n = 0;
    for (let i = 0; i < N; i++) {
      if (bd[i] || !nearCnt[i]) continue;
      let s = moveGain(i, color);
      if (i === ttMove) s += 1e8;
      else {
        if (killers[ply * 2] === i) s += 5e4;
        else if (killers[ply * 2 + 1] === i) s += 2.5e4;
      }
      idxA[n] = i;
      scA[n] = s;
      n++;
      if (n >= 240) break;
    }
    // partial selection sort for top `cap`
    const lim = Math.min(cap, n);
    for (let a = 0; a < lim; a++) {
      let best = a;
      for (let b2 = a + 1; b2 < n; b2++) if (scA[b2] > scA[best]) best = b2;
      if (best !== a) {
        const ti = idxA[a];
        idxA[a] = idxA[best];
        idxA[best] = ti;
        const ts = scA[a];
        scA[a] = scA[best];
        scA[best] = ts;
      }
    }
    return lim;
  }

  // --- search ---------------------------------------------------------------
  let ctxT1 = 0;
  let ctxTick1 = 0;
  function outOfBudget() {
    if (ctxTick1 > 0 && tick >= ctxTick1) return true;
    if (ctxT1 > 0 && (tick & 1023) === 0) {
      return nowMs() >= ctxT1;
    }
    return false;
  }
  let hardStop = false;

  function ttIdx(h) {
    return (h >>> 0) & (TT_N - 1);
  }

  function negamax(depth, alpha, beta, side, ply, extLeft) {
    if (hardStop || outOfBudget()) {
      hardStop = true;
      return evalSide(side);
    }
    const opp = side === B ? W : B;
    // side to move has a four-window with an empty → win in one
    if (four[side] > 0) return WINV - ply;
    const a0 = alpha;
    const h = side === W ? (hash ^ zob[ZSIDE]) >>> 0 : hash;
    const ti = ttIdx(h);
    let ttMove = -1;
    if (ttGenA[ti] === ttGen && ttKey[ti] === (h | 0)) {
      ttMove = ttMv[ti];
      if (ttDep[ti] >= depth) {
        const sc = ttSc[ti],
          f = ttFlg[ti];
        if (f === EX) return sc;
        if (f === LO && sc >= beta) return sc;
        if (f === UP && sc <= alpha) return sc;
      }
    }
    if (depth <= 0) return evalSide(side);

    const cap = depth >= 6 ? 10 : depth >= 3 ? 14 : 16;
    const n = genMoves(ply, side, cap, ttMove);
    if (!n) return 0;

    let best = -Infinity;
    let bestMv = -1;
    for (let i = 0; i < n; i++) {
      const idx = mIdx[ply][i];
      make(idx, side);
      let val;
      if (five[side] > 0) {
        val = WINV - ply;
      } else {
        // No forcing extension. Extending +1 on four-making moves made the
        // extended sub-depth get stored/probed inconsistently against the TT,
        // so deeper search grafted inflated results and chased four-spam that
        // ceded initiative — search became non-monotonic (more budget played
        // WEAKER: deep 120k lost to shallow 40k, 1-5). Removing it restores
        // monotonic search (deep 4-2); forced wins remain covered by the C1
        // VCF/VCT cascade that runs before this search.
        val = -negamax(depth - 1, -beta, -alpha, opp, ply + 1, extLeft);
      }
      unmake(idx, side);
      if (hardStop) {
        // partial result: only trust if at least one child completed
        if (best === -Infinity) return evalSide(side);
        break;
      }
      if (val > best) {
        best = val;
        bestMv = idx;
      }
      if (val > alpha) alpha = val;
      if (alpha >= beta) {
        if (killers[ply * 2] !== idx) {
          killers[ply * 2 + 1] = killers[ply * 2];
          killers[ply * 2] = idx;
        }
        break;
      }
    }
    if (best === -Infinity) return evalSide(side);
    if (!hardStop) {
      let fl = EX;
      if (best <= a0) fl = UP;
      else if (best >= beta) fl = LO;
      if (!(ttGenA[ti] === ttGen && ttDep[ti] > depth)) {
        ttGenA[ti] = ttGen;
        ttKey[ti] = h | 0;
        ttDep[ti] = depth;
        ttFlg[ti] = fl;
        ttSc[ti] = best;
        ttMv[ti] = bestMv;
      }
    }
    return best;
  }

  function searchRoot(me, maxDepth) {
    const opp = me === B ? W : B;
    killers.fill(-1);
    ttGen++;
    if (ttGen > 1e9) {
      ttGen = 1;
      ttGenA.fill(0);
    }
    hardStop = false;
    const nRoot = genMoves(0, me, 28, -1);
    if (!nRoot) return null;
    // copy root moves (ply-0 buffers get reused by the search below)
    const rootIdx = Array.from(mIdx[0].slice(0, nRoot));
    let best = rootIdx[0];
    let lastFull = best;
    for (let depth = 2; depth <= maxDepth; depth++) {
      // previous best first
      const bi = rootIdx.indexOf(best);
      if (bi > 0) {
        rootIdx.splice(bi, 1);
        rootIdx.unshift(best);
      }
      let alpha = -Infinity;
      let iBest = best;
      let done = true;
      for (let i = 0; i < rootIdx.length; i++) {
        const idx = rootIdx[i];
        make(idx, me);
        let val;
        if (five[me] > 0) {
          unmake(idx, me);
          return idx; // immediate five
        }
        val = -negamax(depth - 1, -Infinity, -alpha, opp, 1, 12);
        unmake(idx, me);
        if (hardStop) {
          done = false;
          if (i === 0) iBest = best; // not even first move finished cleanly
          break;
        }
        if (val > alpha) {
          alpha = val;
          iBest = idx;
        }
      }
      if (done) {
        best = iBest;
        lastFull = iBest;
        if (alpha > WINV / 2) break; // proven win
      } else {
        // partial iteration: keep only a fully-searched improvement
        best = lastFull;
        break;
      }
    }
    return lastFull;
  }

  // --- root orchestration ---------------------------------------------------
  function profileFor(difficulty, opts) {
    const extreme = difficulty === "extreme";
    let budget;
    if (typeof opts.nodeBudget === "number" && opts.nodeBudget > 0) budget = 0;
    else if (typeof opts.timeMs === "number") budget = opts.timeMs;
    else if (extreme) budget = opts.think === "fast" ? 2500 : opts.think === "deep" ? 8000 : 5000;
    else budget = opts.think === "fast" ? 800 : opts.think === "deep" ? 3500 : 2000;
    return {
      budgetMs: budget,
      nodeBudget:
        typeof opts.nodeBudget === "number" && opts.nodeBudget > 0 ? opts.nodeBudget : 0,
      vcfDepth: 24,
      vctDepth: extreme ? 10 : 8,
      maxDepth: extreme ? 14 : 12,
    };
  }

  /** C1-ctx slice: frac of remaining wall budget + a C1-eval allowance. */
  function c1Slice(deadline, frac, evals) {
    const out = { t1: 0, e1: 0 };
    if (deadline > 0) {
      const now = nowMs();
      out.t1 = now >= deadline ? deadline : now + (deadline - now) * frac;
    }
    if (evals > 0) out.e1 = C1.ticks() + evals;
    return out;
  }

  let lastStage = "";

  /** Same symmetry-orbit variety as C1 — see GobanAi.symmetryOrbit. Applied
   *  once, at the outer edge, so every return path inside is covered and the
   *  delegation to C1 below cannot double-randomise (it runs with vary:false). */
  function aiMove(opts) {
    // 同一道出口闸,和 C1 共用一处实现 —— 见 GobanAi.legalizeRenju
    return C1.legalizeRenju(opts, C1.varyBySymmetry(opts.board, aiMoveCore(opts), opts));
  }

  function aiMoveCore(opts) {
    const board2d = C1.cloneBoard(opts.board);
    const difficulty = opts.difficulty || "hard";
    const me2 = opts.side === "b" || opts.side === "w" ? opts.side : Core.opp(opts.humanColor || "b");
    const meC = me2 === "b" ? B : W;
    const themC = me2 === "b" ? W : B;
    const them2 = Core.opp(me2);
    const prof = profileFor(difficulty, opts || {});
    const deadline = prof.budgetMs > 0 ? nowMs() + prof.budgetMs : 0;
    // deterministic mode: C1 stages get eval allowances scaled off nodeBudget
    const detEvals = prof.nodeBudget > 0 ? prof.nodeBudget : 0;

    lastStage = "";

    resetFrom(board2d);
    if (!stones) {
      lastStage = "book";
      return { r: 7, c: 7 };
    }

    // 1) immediate win / block from window counters
    const winCell = (color) => {
      if (!four[color]) return null;
      for (let w = 0; w < NW; w++) {
        const own = wCnt[w * 2 + (color === B ? 0 : 1)];
        const opp = wCnt[w * 2 + (color === B ? 1 : 0)];
        if (own === 4 && opp === 0) {
          for (let k = 0; k < 5; k++) {
            const idx = winCells[w * 5 + k];
            if (!bd[idx]) return idx;
          }
        }
      }
      return null;
    };
    let idx = winCell(meC);
    if (idx != null) {
      lastStage = "win";
      return { r: (idx / SZ) | 0, c: idx % SZ };
    }
    idx = winCell(themC);
    if (idx != null) {
      lastStage = "blockwin";
      return { r: (idx / SZ) | 0, c: idx % SZ };
    }

    // 2) opening book (reuse C1's via a shallow call is not exported; keep C2 simple:
    //    with ≤2 stones fall back to C1 entirely — cascade + book are cheap there)
    if (stones <= 2) {
      lastStage = "book";
      return C1.aiMove({
        board: board2d,
        side: me2,
        difficulty: "hard",
        timeMs: prof.budgetMs > 0 ? Math.min(300, prof.budgetMs) : undefined,
        nodeBudget: detEvals > 0 ? Math.max(2000, detEvals >> 3) : undefined,
        vary: false, // the outer aiMove varies once; twice would be no worse but is confusing
      });
    }

    // 3) C1 forced hierarchy
    const force = C1.forcedMove(board2d, me2);
    if (force && force._decisive) {
      lastStage = "force!";
      return force;
    }

    // 4) own VCF
    const vcf = C1.findVCF(
      C1.cloneBoard(board2d),
      me2,
      prof.vcfDepth,
      c1Slice(deadline, 0.3, detEvals ? detEvals * 0.2 : 0)
    );
    if (vcf) {
      lastStage = "vcf";
      return vcf;
    }

    // 5) deny opponent VCF
    {
      const dctx = c1Slice(deadline, 0.25, detEvals ? detEvals * 0.15 : 0);
      const ov = C1.findVCF(C1.cloneBoard(board2d), them2, 18, dctx);
      if (ov) {
        const defs = C1.candidateMoves(board2d, 24, 2, me2);
        for (let i = 0; i < defs.length; i++) {
          const d = defs[i];
          const b2 = C1.cloneBoard(board2d);
          b2[d.r][d.c] = me2;
          if (C1.listWinCells(b2, them2).length) continue;
          const still = C1.findVCF(b2, them2, 16, dctx);
          if (!still && !(dctx.t1 > 0 && nowMs() >= dctx.t1) && !(dctx.e1 > 0 && C1.ticks() >= dctx.e1)) {
            lastStage = "deny";
            return d;
          }
          if ((dctx.t1 > 0 && nowMs() >= dctx.t1) || (dctx.e1 > 0 && C1.ticks() >= dctx.e1)) break;
        }
        if (force) {
          lastStage = "force";
          return force;
        }
        if (!board2d[ov.r][ov.c]) {
          lastStage = "deny-fb";
          return ov;
        }
      }
    }

    // 6) soft force (their live4/four-three point blocks, own double-3)
    if (force) {
      lastStage = "force";
      return force;
    }

    // 7) VCT
    const vct = C1.findVCT(
      C1.cloneBoard(board2d),
      me2,
      prof.vctDepth,
      c1Slice(deadline, 0.35, detEvals ? detEvals * 0.2 : 0)
    );
    if (vct) {
      lastStage = "vct";
      return vct;
    }

    // 8) C2 deep search with the remaining budget
    ctxT1 = deadline;
    // calibration: C2 make() ticks run ~40x faster than C1 analyzePlace evals
    ctxTick1 = detEvals > 0 ? tick + Math.max(20000, Math.floor(detEvals * 18)) : 0;
    const mv = searchRoot(meC, prof.maxDepth);
    lastStage = "search";
    if (mv != null) return { r: (mv / SZ) | 0, c: mv % SZ };
    lastStage = "fallback";
    const fb = C1.candidateMoves(board2d, 3, 2, me2);
    return fb[0] || null;
  }

  global.GobanAi2 = {
    aiMove: aiMove,
    lastStage: function () {
      return lastStage;
    },
    _debug: {
      resetFrom: resetFrom,
      evalSide: evalSide,
      state: function () {
        return { sTot: sTot, four: Array.from(four), five: Array.from(five), stones: stones, tick: tick };
      },
    },
  };
})(typeof window !== "undefined" ? window : globalThis);
