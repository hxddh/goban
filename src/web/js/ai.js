/**
 * C1.e / P0 — pattern tables + compound threats + tight VCT.
 * Freestyle 15×15.
 *
 * Hierarchy: win > block win > VCF > forced (own compound≥3 > block their
 *            compound≥3 (incl. live3 ends) > own rush4) > deny VCF > VCT > α-β.
 * Live3-level attack/pre-block is search-ordered, never hard-forced.
 * @module ai
 */
(function (global) {
  const Core = global.GobanCore;
  const SZ = 15;
  const DIRS = [
    [0, 1],
    [1, 0],
    [1, 1],
    [1, -1],
  ];

  // --- Zobrist / TT --------------------------------------------------------
  const ZN = SZ * SZ;
  const zobrist = new Uint32Array(ZN * 2 + 1);
  (function () {
    let s = 0xc1d00d1 >>> 0;
    for (let i = 0; i < zobrist.length; i++) {
      s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
      zobrist[i] = s;
    }
  })();
  const Z_SIDE = ZN * 2;
  const TT_N = 1 << 18;
  const ttKey = new Int32Array(TT_N);
  const ttDep = new Int8Array(TT_N);
  const ttFlg = new Int8Array(TT_N);
  const ttSc = new Float64Array(TT_N);
  const ttMv = new Int16Array(TT_N);
  let ttGen = 1;
  const ttGenA = new Int32Array(TT_N);
  const EX = 0,
    LO = 1,
    UP = 2;

  function ttReset() {
    ttGen++;
    if (ttGen > 1e9) {
      ttGen = 1;
      ttGenA.fill(0);
    }
  }
  function ttI(h) {
    return (h >>> 0) & (TT_N - 1);
  }
  function ttGet(h, d, a, b) {
    const i = ttI(h);
    if (ttGenA[i] !== ttGen || ttKey[i] !== (h | 0)) return null;
    const mv = ttMv[i];
    if (ttDep[i] < d) return { mv: mv };
    const sc = ttSc[i],
      f = ttFlg[i];
    if (f === EX) return { sc: sc, mv: mv };
    if (f === LO && sc >= b) return { sc: sc, mv: mv };
    if (f === UP && sc <= a) return { sc: sc, mv: mv };
    return { mv: mv };
  }
  function ttPut(h, d, f, sc, mv) {
    const i = ttI(h);
    if (ttGenA[i] === ttGen && ttDep[i] > d) return;
    ttGenA[i] = ttGen;
    ttKey[i] = h | 0;
    ttDep[i] = d;
    ttFlg[i] = f;
    ttSc[i] = sc;
    ttMv[i] = mv == null ? -1 : mv;
  }
  function pack(r, c) {
    return (r << 4) | c;
  }
  function unR(m) {
    return m >> 4;
  }
  function unC(m) {
    return m & 15;
  }
  function hashBoard(board, side) {
    let h = 0;
    for (let r = 0; r < SZ; r++)
      for (let c = 0; c < SZ; c++) {
        const s = board[r][c];
        if (!s) continue;
        h ^= zobrist[(s === "b" ? 0 : ZN) + r * SZ + c];
      }
    if (side === "w") h ^= zobrist[Z_SIDE];
    return h >>> 0;
  }
  function xorPlace(h, r, c, color) {
    return (h ^ zobrist[(color === "b" ? 0 : ZN) + r * SZ + c]) >>> 0;
  }

  /** Debug: which aiMove stage produced the last move (for tuning/tests). */
  let lastStage = "";

  // --- utils ---------------------------------------------------------------
  function cloneBoard(board) {
    const o = new Array(SZ);
    for (let r = 0; r < SZ; r++) o[r] = board[r].slice();
    return o;
  }
  function nowMs() {
    return typeof performance !== "undefined" && performance.now ? performance.now() : Date.now();
  }
  /** Global analyzePlace counter — the deterministic budget dimension. */
  let evalTick = 0;
  /**
   * ctx: { t1: wall-clock deadline (0=off), e1: evalTick deadline (0=off) }.
   * Node budgets (e1) make games reproducible regardless of CPU load.
   */
  function timedOut(ctx) {
    if (!ctx) return false;
    if (ctx.t1 > 0 && nowMs() >= ctx.t1) return true;
    if (ctx.e1 > 0 && evalTick >= ctx.e1) return true;
    return false;
  }
  function near(board, r, c, d) {
    d = d || 2;
    for (let dr = -d; dr <= d; dr++)
      for (let dc = -d; dc <= d; dc++) {
        if (!dr && !dc) continue;
        const rr = r + dr,
          cc = c + dc;
        if (rr >= 0 && rr < SZ && cc >= 0 && cc < SZ && board[rr][cc]) return true;
      }
    return false;
  }
  function hasStone(board) {
    for (let r = 0; r < SZ; r++)
      for (let c = 0; c < SZ; c++) if (board[r][c]) return true;
    return false;
  }
  function emptiesNear(board, d) {
    if (!hasStone(board)) return [{ r: 7, c: 7 }];
    const list = [];
    for (let r = 0; r < SZ; r++)
      for (let c = 0; c < SZ; c++) {
        if (board[r][c]) continue;
        if (!near(board, r, c, d || 2)) continue;
        list.push({ r: r, c: c });
      }
    if (!list.length) {
      for (let r = 0; r < SZ; r++)
        for (let c = 0; c < SZ; c++) if (!board[r][c]) list.push({ r: r, c: c });
    }
    return list;
  }

  function listWins(board, color) {
    const list = [];
    const cells = emptiesNear(board, 1);
    for (let i = 0; i < cells.length; i++) {
      const m = cells[i];
      if (Core.wouldWin(board, m.r, m.c, color)) list.push(m);
    }
    return list;
  }

  // --- P0 pattern table (line windows) -------------------------------------
  /**
   * Encode 9-cell window centered on (r,c) for `color` AFTER placing color there.
   * 0=empty, 1=me, 2=opp/wall
   */
  function lineWindow(board, r, c, dr, dc, color) {
    const w = new Array(9);
    for (let k = -4; k <= 4; k++) {
      const rr = r + dr * k,
        cc = c + dc * k;
      if (rr < 0 || rr >= SZ || cc < 0 || cc >= SZ) w[k + 4] = 2;
      else if (k === 0) w[k + 4] = 1;
      else if (board[rr][cc] === color) w[k + 4] = 1;
      else if (!board[rr][cc]) w[k + 4] = 0;
      else w[k + 4] = 2;
    }
    return w;
  }

  function winToStr(w) {
    // compact string for substring match
    let s = "";
    for (let i = 0; i < 9; i++) s += w[i] === 1 ? "X" : w[i] === 0 ? "_" : "O";
    return s;
  }

  /**
   * Count pattern flags on one direction window string (center is our stone).
   * Uses classic freestyle shapes.
   */
  function matchDir(str) {
    // Returns additive counts for this direction only (0 or 1 of each major type ideally)
    let live4 = 0,
      rush4 = 0,
      live3 = 0,
      sleep3 = 0,
      jump3 = 0,
      jump4 = 0,
      live2 = 0;

    // Five
    if (str.indexOf("XXXXX") >= 0) return { five: 1, live4: 0, rush4: 0, live3: 0, sleep3: 0, jump3: 0, jump4: 0, live2: 0 };

    // Live four: _XXXX_
    if (str.indexOf("_XXXX_") >= 0) live4 = 1;
    // Rush fours / half fours
    else if (
      str.indexOf("OXXXX_") >= 0 ||
      str.indexOf("_XXXXO") >= 0 ||
      str.indexOf("XXXX_") >= 0 ||
      str.indexOf("_XXXX") >= 0
    ) {
      // careful: _XXXX_ already handled; bare XXXX_ is rush if not both open
      if (str.indexOf("_XXXX_") < 0) rush4 = 1;
    }
    // Jump four: XX_XX, X_XXX, XXX_X
    if (
      str.indexOf("XX_XX") >= 0 ||
      str.indexOf("X_XXX") >= 0 ||
      str.indexOf("XXX_X") >= 0 ||
      str.indexOf("_XX_XX_") >= 0
    ) {
      jump4 = 1;
      if (!live4) rush4 = Math.max(rush4, 1);
    }

    // Live three: _XXX_, _XX_X_, _X_XX_
    if (str.indexOf("_XXX_") >= 0) live3 = 1;
    if (str.indexOf("_XX_X_") >= 0 || str.indexOf("_X_XX_") >= 0) {
      jump3 = 1;
      live3 = 1;
    }
    // Sleep three: OXXX_, _XXXO, OXX_X_ etc.
    if (!live3) {
      // note: bare "OXXX" (e.g. OXXXO, dead both ends) is worthless — not counted
      if (
        str.indexOf("OXXX_") >= 0 ||
        str.indexOf("_XXXO") >= 0 ||
        str.indexOf("OXX_X") >= 0 ||
        str.indexOf("X_XXO") >= 0
      ) {
        sleep3 = 1;
      }
    }
    // Live two
    if (str.indexOf("_XX_") >= 0 || str.indexOf("_X_X_") >= 0) live2 = 1;

    return {
      five: 0,
      live4: live4,
      rush4: rush4,
      live3: live3,
      sleep3: sleep3,
      jump3: jump3,
      jump4: jump4,
      live2: live2,
    };
  }

  /**
   * Full analysis of placing `color` at (r,c). Board must NOT already have a stone there.
   * Does not leave the stone on the board.
   */
  function analyzePlace(board, r, c, color) {
    evalTick++;
    const empty = {
      score: -1e15,
      tier: 0,
      wins: 0,
      live4: 0,
      rush4: 0,
      live3: 0,
      sleep3: 0,
      jump3: 0,
      jump4: 0,
      live2: 0,
      compound: 0, // 3=double live3 / four-three / double rush, 2=single strong
      winCells: 0,
    };
    if (r < 0 || r >= SZ || c < 0 || c >= SZ || board[r][c]) return empty;

    if (Core.wouldWin(board, r, c, color)) {
      return {
        score: 1e12,
        tier: 5,
        wins: 1,
        live4: 0,
        rush4: 0,
        live3: 0,
        sleep3: 0,
        jump3: 0,
        jump4: 0,
        live2: 0,
        compound: 4,
        winCells: 1,
      };
    }

    board[r][c] = color;
    let live4 = 0,
      rush4 = 0,
      live3 = 0,
      sleep3 = 0,
      jump3 = 0,
      jump4 = 0,
      live2 = 0;
    let score = 0;

    for (let di = 0; di < 4; di++) {
      const w = lineWindow(board, r, c, DIRS[di][0], DIRS[di][1], color);
      const str = winToStr(w);
      const m = matchDir(str);
      if (m.five) {
        board[r][c] = "";
        return {
          score: 1e12,
          tier: 5,
          wins: 1,
          live4: 0,
          rush4: 0,
          live3: 0,
          sleep3: 0,
          jump3: 0,
          jump4: 0,
          live2: 0,
          compound: 4,
          winCells: 1,
        };
      }
      live4 += m.live4;
      rush4 += m.rush4;
      live3 += m.live3;
      sleep3 += m.sleep3;
      jump3 += m.jump3;
      jump4 += m.jump4;
      live2 += m.live2;

      // consecutive fallback (robust)
      let cnt = 1,
        o1 = 0,
        o2 = 0;
      let rr = r + DIRS[di][0],
        cc = c + DIRS[di][1];
      while (rr >= 0 && rr < SZ && cc >= 0 && cc < SZ && board[rr][cc] === color) {
        cnt++;
        rr += DIRS[di][0];
        cc += DIRS[di][1];
      }
      if (rr >= 0 && rr < SZ && cc >= 0 && cc < SZ && !board[rr][cc]) o1 = 1;
      rr = r - DIRS[di][0];
      cc = c - DIRS[di][1];
      while (rr >= 0 && rr < SZ && cc >= 0 && cc < SZ && board[rr][cc] === color) {
        cnt++;
        rr -= DIRS[di][0];
        cc -= DIRS[di][1];
      }
      if (rr >= 0 && rr < SZ && cc >= 0 && cc < SZ && !board[rr][cc]) o2 = 1;
      const open = o1 + o2;
      if (cnt === 4 && open === 2) live4 = Math.max(live4, 1);
      else if (cnt === 4 && open === 1) rush4 = Math.max(rush4, 1);
      else if (cnt === 3 && open === 2) live3 = Math.max(live3, 1);
      else if (cnt === 3 && open === 1) sleep3 = Math.max(sleep3, 1);
      else if (cnt === 2 && open === 2) live2 = Math.max(live2, 1);
    }

    // Win-cell scan is O(cells); it can only be non-zero when this stone
    // forms a four-type shape (an immediate five returned above already).
    const winCells = live4 || rush4 || jump4 ? listWins(board, color).length : 0;
    board[r][c] = "";

    // compound classification
    let compound = 0;
    if (winCells >= 2 || live4 >= 1) compound = 4; // unstoppable / dual win
    else if (rush4 >= 2 || (rush4 >= 1 && live3 >= 1) || live3 >= 2) compound = 3; // four-three / double live3 / double rush
    else if (rush4 >= 1 || winCells >= 1) compound = 2;
    else if (live3 >= 1) compound = 1;

    score += live4 * 800000;
    score += rush4 * 120000;
    score += live3 * 25000;
    score += jump3 * 5000;
    score += jump4 * 40000;
    score += sleep3 * 1500;
    score += live2 * 800;
    score += winCells * 250000;
    if (compound >= 3) score += 600000;
    if (compound >= 4) score += 2e6;
    score += (14 - (Math.abs(r - 7) + Math.abs(c - 7))) * 5;

    let tier = 0;
    if (compound >= 4 || winCells >= 1) tier = 5;
    else if (compound >= 3) tier = 4;
    else if (rush4 >= 1 || live4 >= 1) tier = 3;
    else if (live3 >= 1) tier = 2;
    else if (sleep3 || live2 || jump3) tier = 1;

    return {
      score: score,
      tier: tier,
      wins: winCells > 0 ? 1 : 0,
      live4: live4,
      rush4: rush4,
      live3: live3,
      sleep3: sleep3,
      jump3: jump3,
      jump4: jump4,
      live2: live2,
      compound: compound,
      winCells: winCells,
    };
  }

  /** Points where `attacker` can play to create compound≥3 or win. */
  function mustDefendPoints(board, attacker) {
    const pts = [];
    const cells = emptiesNear(board, 2);
    for (let i = 0; i < cells.length; i++) {
      const m = cells[i];
      const a = analyzePlace(board, m.r, m.c, attacker);
      if (a.tier >= 4 || a.compound >= 3 || a.winCells >= 1 || a.live4 || a.rush4) {
        pts.push({
          r: m.r,
          c: m.c,
          s: a.score,
          compound: a.compound,
          tier: a.tier,
          a: a,
        });
      }
    }
    pts.sort((x, y) => y.s - x.s);
    return pts;
  }

  /** Live-three style points opponent wants (tier≥2 offensive). */
  function live3Points(board, attacker) {
    const pts = [];
    const cells = emptiesNear(board, 2);
    for (let i = 0; i < cells.length; i++) {
      const m = cells[i];
      const a = analyzePlace(board, m.r, m.c, attacker);
      if (a.live3 >= 1 || a.compound >= 1) {
        pts.push({ r: m.r, c: m.c, s: a.score, a: a });
      }
    }
    pts.sort((x, y) => y.s - x.s);
    return pts;
  }

  function evalStatic(board, me) {
    let sc = 0;
    const them = Core.opp(me);
    // sample potential of empty near cells for both
    const cells = emptiesNear(board, 2);
    let lim = cells.length;
    if (lim > 36) {
      // sample the HOTTEST cells (most adjacent stones) — plain row-major
      // truncation silently ignored threats in the lower board half
      for (let i = 0; i < cells.length; i++) {
        const m = cells[i];
        let n = 0;
        for (let dr = -1; dr <= 1; dr++)
          for (let dc = -1; dc <= 1; dc++) {
            if (!dr && !dc) continue;
            const rr = m.r + dr,
              cc = m.c + dc;
            if (rr >= 0 && rr < SZ && cc >= 0 && cc < SZ && board[rr][cc]) n++;
          }
        m.hot = n;
      }
      cells.sort((a, b) => b.hot - a.hot);
      lim = 36;
    }
    for (let i = 0; i < lim; i++) {
      const m = cells[i];
      const o = analyzePlace(board, m.r, m.c, me);
      const d = analyzePlace(board, m.r, m.c, them);
      sc += o.score * 0.02 - d.score * 0.022;
    }
    // stone material
    for (let r = 0; r < SZ; r++)
      for (let c = 0; c < SZ; c++) {
        if (!board[r][c]) continue;
        const sign = board[r][c] === me ? 1 : -1;
        sc += sign * (14 - (Math.abs(r - 7) + Math.abs(c - 7))) * 0.5;
      }
    return sc;
  }

  function rankMoves(board, me, maxN, ctx) {
    const them = Core.opp(me);
    const raw = emptiesNear(board, 2);
    const out = [];
    for (let i = 0; i < raw.length; i++) {
      if (timedOut(ctx)) break;
      const m = raw[i];
      const off = analyzePlace(board, m.r, m.c, me);
      const def = analyzePlace(board, m.r, m.c, them);
      // P0-4 block quality: defending a point that is also our attack is best
      let s = off.score + def.score * 1.08;
      if (off.tier >= 5) s = 1e14;
      else if (def.tier >= 5) s = 1e13 + def.score;
      else if (off.compound >= 3) s = 1e12 + off.score;
      else if (def.compound >= 3) s = 5e11 + def.score + off.score * 0.3;
      else if (off.tier >= 3) s = 1e10 + off.score;
      else if (def.tier >= 3) s = 5e9 + def.score + off.score * 0.35;
      else if (off.tier >= 2 && def.tier >= 2) s = 2e9 + off.score + def.score; // dual purpose
      else if (off.tier >= 2) s = 1.2e9 + off.score + def.score * 0.4; // own live3: keeps tempo
      else if (def.tier >= 2) s = 8e8 + def.score + off.score * 0.4; // pre-block their live3
      out.push({ r: m.r, c: m.c, s: s, off: off, def: def });
    }
    out.sort((a, b) => b.s - a.s);
    return out.slice(0, maxN || out.length);
  }

  function threatMoves(board, me, maxN, ctx) {
    const all = rankMoves(board, me, 48, ctx);
    const t = [];
    for (let i = 0; i < all.length; i++) {
      const m = all[i];
      if (
        (m.off && m.off.tier >= 2) ||
        (m.def && m.def.tier >= 2) ||
        (m.off && m.off.compound >= 1) ||
        (m.def && m.def.compound >= 1)
      ) {
        t.push(m);
      }
    }
    if (t.length < 8) return all.slice(0, maxN || 18);
    return t.slice(0, maxN || 20);
  }

  /**
   * P0 forced root move with compound awareness + block quality.
   */
  function forcedMove(board, me, ctx) {
    const them = Core.opp(me);
    const cells = emptiesNear(board, 2);

    // 1-2 win / block win
    for (let i = 0; i < cells.length; i++) {
      if (Core.wouldWin(board, cells[i].r, cells[i].c, me)) return cells[i];
    }
    for (let i = 0; i < cells.length; i++) {
      if (Core.wouldWin(board, cells[i].r, cells[i].c, them)) return cells[i];
    }

    const myC = [];
    const theirC = [];
    for (let i = 0; i < cells.length; i++) {
      if (timedOut(ctx)) break;
      const m = cells[i];
      const o = analyzePlace(board, m.r, m.c, me);
      const d = analyzePlace(board, m.r, m.c, them);
      if (o.compound >= 1 || o.tier >= 2)
        myC.push({ m: m, o: o, d: d, s: o.score + (d.score > 0 ? d.score * 0.2 : 0) });
      if (d.compound >= 1 || d.tier >= 2)
        theirC.push({ m: m, o: o, d: d, s: d.score + o.score * 0.35 }); // prefer dual-purpose blocks
    }
    myC.sort((a, b) => b.s - a.s);
    theirC.sort((a, b) => b.s - a.s);

    const pickMy = (pred, check) => {
      for (let i = 0; i < myC.length; i++) {
        if (pred(myC[i].o) && (!check || check(myC[i].m))) return myC[i].m;
      }
      return null;
    };

    /**
     * A four-three only wins if the forced block of the four cannot kill the
     * three too (win cell on the three's growth line refutes both at once).
     * Verify: after my move + their block, I must still have a live4/dual
     * point, and their block must not hand them a win threat.
     */
    const fourThreeWins = (m) => {
      board[m.r][m.c] = me;
      const wins = listWins(board, me);
      let ok = false;
      if (wins.length >= 2) ok = true;
      else if (wins.length === 1) {
        const b0 = wins[0];
        board[b0.r][b0.c] = them;
        if (!listWins(board, them).length) {
          const c2 = emptiesNear(board, 2);
          for (let i = 0; i < c2.length; i++) {
            const a = analyzePlace(board, c2[i].r, c2[i].c, me);
            if (a.compound >= 4) {
              ok = true;
              break;
            }
            if (timedOut(ctx)) break;
          }
        }
        board[b0.r][b0.c] = "";
      }
      board[m.r][m.c] = "";
      return ok;
    };
    const pickTheir = (pred) => {
      for (let i = 0; i < theirC.length; i++) {
        if (pred(theirC[i].d)) return theirC[i].m;
      }
      return null;
    };

    // Tempo-ordered hierarchy. Key distinction: a four (rush4/live4) wins or
    // forces NEXT move; a pure double-live3 needs two more tempi, so it must
    // yield to any opposing four-speed threat. `_decisive` marks winning
    // forces the caller may take before opponent-VCF denial.
    // 3a own unstoppable: live4 / dual win cells
    let mv = pickMy((o) => o.compound >= 4);
    if (mv) return { r: mv.r, c: mv.c, _decisive: true };
    // 3b own four-three: the four forces, the live3 then converts —
    // verified against the one-stone dual-purpose refutation
    mv = pickMy((o) => o.rush4 >= 1 && o.live3 >= 1, fourThreeWins);
    if (mv) return { r: mv.r, c: mv.c, _decisive: true };
    // 4 block their four-speed wins: live4 points and four-three points
    // (covers existing live threes — their extensions analyze as live4)
    mv = pickTheir((d) => d.compound >= 4 || (d.rush4 >= 1 && d.live3 >= 1));
    if (mv) return mv;
    // 5 own pure double-live3: as the mover it outruns non-four threats
    mv = pickMy((o) => o.compound >= 3);
    if (mv) return mv;
    // 6 block their remaining compound≥3 (double-three seeds)
    mv = pickTheir((d) => d.compound >= 3 || d.tier >= 4);
    if (mv) return mv;

    // NOT forced: a lone rush4 (four-spam wastes tempo and feeds the
    // opponent blocking stones — winning four chains are VCF's job), and
    // anything softer (pre-blocking potential rush4/live3, plain own live3).
    // Those surface through rankMoves ordering + search instead.
    return null;
  }

  // --- VCF -----------------------------------------------------------------
  function findVCF(board, me, maxD, ctx) {
    return vcfRec(board, me, 0, maxD, ctx);
  }
  function vcfRec(board, me, d, maxD, ctx) {
    if (timedOut(ctx) || d > maxD) return null;
    const them = Core.opp(me);
    const cells = emptiesNear(board, 2);
    for (let i = 0; i < cells.length; i++) {
      if (Core.wouldWin(board, cells[i].r, cells[i].c, me)) return cells[i];
    }
    const attacks = [];
    for (let i = 0; i < cells.length; i++) {
      if (timedOut(ctx)) break;
      const m = cells[i];
      board[m.r][m.c] = me;
      if (Core.findWin(board, m.r, m.c, me)) {
        board[m.r][m.c] = "";
        return m;
      }
      const mw = listWins(board, me);
      const ow = listWins(board, them);
      board[m.r][m.c] = "";
      if (ow.length) continue;
      if (mw.length >= 2) return m;
      if (mw.length === 1) attacks.push({ m: m, b: mw[0] });
    }
    const cap = Math.min(attacks.length, d === 0 ? 28 : 18);
    for (let i = 0; i < cap; i++) {
      if (timedOut(ctx)) break;
      const { m, b } = attacks[i];
      board[m.r][m.c] = me;
      board[b.r][b.c] = them;
      const ok = vcfRec(board, me, d + 1, maxD, ctx);
      board[b.r][b.c] = "";
      board[m.r][m.c] = "";
      if (ok) return m;
    }
    return null;
  }

  // --- VCT (tight generation) ----------------------------------------------
  function findVCT(board, me, maxD, ctx) {
    if (ctx) ctx.vctNodes = 0;
    return vctRec(board, me, 0, maxD, ctx);
  }

  /** Attack moves: only those that raise threat (compound≥1 or live3/rush4). */
  function vctAttacks(board, me, ctx) {
    const cells = emptiesNear(board, 2);
    const out = [];
    for (let i = 0; i < cells.length; i++) {
      if (timedOut(ctx)) break;
      const m = cells[i];
      const a = analyzePlace(board, m.r, m.c, me);
      if (a.tier >= 2 || a.compound >= 1 || a.live3 || a.rush4 || a.live4 || a.winCells) {
        out.push({ r: m.r, c: m.c, s: a.score, a: a });
      }
    }
    out.sort((x, y) => y.s - x.s);
    return out;
  }

  /**
   * Defense set against attacker's last threat: win cells, or compound points, or live3 ends.
   */
  function vctDefenses(board, attacker, ctx) {
    const wins = listWins(board, attacker);
    if (wins.length) return wins;
    const md = mustDefendPoints(board, attacker);
    if (md.length) {
      // only top-tier threats
      const top = md[0].compound;
      return md.filter((p) => p.compound >= Math.min(2, top) || p.tier >= 3).map((p) => ({ r: p.r, c: p.c }));
    }
    const l3 = live3Points(board, attacker);
    return l3.slice(0, 4).map((p) => ({ r: p.r, c: p.c }));
  }

  function vctRec(board, me, d, maxD, ctx) {
    if (timedOut(ctx) || d > maxD) return null;
    // node backstop for pathological branching (budget slicing is primary)
    if (ctx && (ctx.vctNodes = (ctx.vctNodes || 0) + 1) > 5000) return null;
    const them = Core.opp(me);

    const vcf = findVCF(board, me, maxD - d + 10, ctx);
    if (vcf) return vcf;

    const attacks = vctAttacks(board, me, ctx);
    const lim = Math.min(attacks.length, d === 0 ? 16 : d <= 2 ? 12 : 8);

    for (let i = 0; i < lim; i++) {
      if (timedOut(ctx)) break;
      const m = attacks[i];
      if (Core.wouldWin(board, m.r, m.c, me)) return m;

      board[m.r][m.c] = me;
      if (Core.findWin(board, m.r, m.c, me)) {
        board[m.r][m.c] = "";
        return m;
      }
      // illegal: leave opponent win
      if (listWins(board, them).length) {
        board[m.r][m.c] = "";
        continue;
      }
      const mw = listWins(board, me);
      if (mw.length >= 2) {
        board[m.r][m.c] = "";
        return m; // dual
      }

      let replies = mw.length === 1 ? [mw[0]] : vctDefenses(board, me, ctx);
      if (!replies.length) {
        board[m.r][m.c] = "";
        continue;
      }
      // Defender counter-fours: a rush4 punch elsewhere steals the tempo and
      // can refute the whole sequence — occupying/blocking is not the only
      // reply. All plies: unsound "wins" here cost real games; the node cap
      // and shallower vctDepth bound the price.
      const punch = mustDefendPoints(board, them).slice(0, 2);
      for (let j = 0; j < punch.length; j++) {
        const p = punch[j];
        if (!replies.some((x) => x.r === p.r && x.c === p.c)) {
          replies.push({ r: p.r, c: p.c });
        }
      }
      // limit fan-out
      if (replies.length > 6) replies = replies.slice(0, 6);

      let allGood = true;
      for (let j = 0; j < replies.length; j++) {
        if (timedOut(ctx)) {
          allGood = false;
          break;
        }
        const r = replies[j];
        if (board[r.r][r.c]) continue;
        board[r.r][r.c] = them;
        if (Core.findWin(board, r.r, r.c, them)) {
          allGood = false;
          board[r.r][r.c] = "";
          break;
        }
        // after each defense, attacker must still have forced win
        const cont =
          findVCF(board, me, 12, ctx) ||
          (d + 1 <= maxD ? vctRec(board, me, d + 1, maxD, ctx) : null);
        board[r.r][r.c] = "";
        if (!cont) {
          allGood = false;
          break;
        }
      }
      board[m.r][m.c] = "";
      if (allGood) return m;
    }
    return null;
  }

  // --- α-β -----------------------------------------------------------------
  function negamax(board, depth, alpha, beta, side, root, ctx, ply, h, killers, threatOnly) {
    // Leaf values MUST be side-to-move relative (negamax contract).
    // evalStatic(board, root) here inverted every odd-depth subtree — with
    // iterative deepening stopping on timeout, the root then picked the
    // WORST shallow-eval move.
    if (timedOut(ctx)) return evalStatic(board, side);
    const a0 = alpha;
    let ttMv = -1;
    const hit = ttGet(h, depth, alpha, beta);
    if (hit) {
      if (hit.sc != null) return hit.sc;
      if (hit.mv >= 0) ttMv = hit.mv;
    }
    if (depth <= 0) return evalStatic(board, side);

    // quick wins
    const nearCells = emptiesNear(board, 2);
    for (let i = 0; i < nearCells.length; i++) {
      if (Core.wouldWin(board, nearCells[i].r, nearCells[i].c, side)) return 9e6 - ply;
    }

    let moves = threatOnly || depth >= 3 ? threatMoves(board, side, depth >= 5 ? 12 : 16, ctx) : rankMoves(board, side, 18, ctx);

    if (ttMv >= 0) {
      const tr = unR(ttMv),
        tc = unC(ttMv);
      const ix = moves.findIndex((m) => m.r === tr && m.c === tc);
      if (ix > 0) {
        const t = moves[ix];
        moves.splice(ix, 1);
        moves.unshift(t);
      }
    }
    if (killers && ply < 64) {
      for (let k = 0; k < 2; k++) {
        const code = killers[k][ply];
        if (code < 0) continue;
        const tr = unR(code),
          tc = unC(code);
        const ix = moves.findIndex((m) => m.r === tr && m.c === tc);
        if (ix > 0) {
          const t = moves[ix];
          moves.splice(ix, 1);
          moves.unshift(t);
        }
      }
    }

    if (!moves.length) return 0;
    let best = -Infinity,
      bestC = -1;
    const them = Core.opp(side);
    for (let i = 0; i < moves.length; i++) {
      if (timedOut(ctx)) break;
      const m = moves[i];
      if (board[m.r][m.c]) continue;
      board[m.r][m.c] = side;
      let val;
      if (Core.findWin(board, m.r, m.c, side)) val = 9e6 - ply;
      else if (listWins(board, them).length) val = -9e6 + ply;
      else {
        const h2 = xorPlace(h, m.r, m.c, side) ^ zobrist[Z_SIDE];
        if (i === 0 || depth < 3) {
          val = -negamax(board, depth - 1, -beta, -alpha, them, root, ctx, ply + 1, h2, killers, depth >= 3);
        } else {
          val = -negamax(board, depth - 1, -alpha - 1, -alpha, them, root, ctx, ply + 1, h2, killers, true);
          if (val > alpha && val < beta) {
            val = -negamax(board, depth - 1, -beta, -alpha, them, root, ctx, ply + 1, h2, killers, depth >= 3);
          }
        }
      }
      board[m.r][m.c] = "";
      if (val > best) {
        best = val;
        bestC = pack(m.r, m.c);
      }
      if (val > alpha) alpha = val;
      if (alpha >= beta) {
        if (killers && ply < 64 && bestC >= 0) {
          if (killers[0][ply] !== bestC) {
            killers[1][ply] = killers[0][ply];
            killers[0][ply] = bestC;
          }
        }
        break;
      }
    }
    // No child evaluated (timeout hit before the first move): a raw
    // -Infinity would negate into +Infinity at the parent and poison it.
    if (best === -Infinity) return evalStatic(board, side);
    // A timed-out scan yields a partial score — never store it.
    if (!timedOut(ctx)) {
      let fl = EX;
      if (best <= a0) fl = UP;
      else if (best >= beta) fl = LO;
      ttPut(h, depth, fl, best, bestC);
    }
    return best;
  }

  function searchRoot(board, me, maxD, ctx) {
    const them = Core.opp(me);
    const killers = [new Int16Array(64).fill(-1), new Int16Array(64).fill(-1)];
    const h0 = hashBoard(board, me);
    // Root list is ranked WITHOUT the clock: a timed-out scan truncates in
    // row-major order and the "best" move degrades to a top-left bias.
    // One full pass costs ~1-2ms — always affordable.
    let moves = rankMoves(board, me, 28, null);
    let best = moves[0] ? { r: moves[0].r, c: moves[0].c } : null;
    let bestV = -Infinity;

    for (let depth = 1; depth <= maxD; depth++) {
      if (timedOut(ctx)) break;
      if (best) {
        const bi = moves.findIndex((m) => m.r === best.r && m.c === best.c);
        if (bi > 0) {
          const t = moves[bi];
          moves.splice(bi, 1);
          moves.unshift(t);
        }
      }
      let iBest = best,
        iVal = -Infinity;
      let alpha = -Infinity;
      for (let i = 0; i < moves.length; i++) {
        if (timedOut(ctx)) break;
        const m = moves[i];
        if (Core.wouldWin(board, m.r, m.c, me)) return { r: m.r, c: m.c };
        board[m.r][m.c] = me;
        let val;
        if (Core.findWin(board, m.r, m.c, me)) val = 9e6;
        else if (listWins(board, them).length) val = -9e6;
        else {
          const h2 = xorPlace(h0, m.r, m.c, me) ^ zobrist[Z_SIDE];
          // root window (alpha, +inf): later siblings prune against the best so far
          val = -negamax(board, depth - 1, -Infinity, -alpha, them, me, ctx, 1, h2, killers, depth >= 3);
        }
        board[m.r][m.c] = "";
        if (val > iVal) {
          iVal = val;
          iBest = { r: m.r, c: m.c };
        }
        if (val > alpha) alpha = val;
      }
      if (iBest) {
        best = iBest;
        bestV = iVal;
      }
      if (bestV > 1e6) break;
    }
    return best;
  }

  function randomPick(a) {
    return a && a.length ? a[(Math.random() * a.length) | 0] : null;
  }

  /**
   * Tiny deterministic opening book, plies 1-3. Deterministic on purpose:
   * keeps self-play regressions stable.
   */
  function bookMove(board, me) {
    const stones = [];
    for (let r = 0; r < SZ; r++)
      for (let c = 0; c < SZ; c++) {
        if (board[r][c]) {
          stones.push({ r: r, c: c, s: board[r][c] });
          if (stones.length > 2) return null;
        }
      }
    if (!stones.length) return { r: 7, c: 7 };
    if (stones.length === 1) {
      const s = stones[0];
      if (s.r === 7 && s.c === 7) return { r: 6, c: 8 }; // diagonal contact
      return !board[7][7] ? { r: 7, c: 7 } : null;
    }
    // ply 3, we hold the center: answer with the far-side diagonal (斜指-style)
    const mine = stones.find((x) => x.s === me);
    const theirs = stones.find((x) => x.s !== me);
    if (!mine || !theirs || mine.r !== 7 || mine.c !== 7) return null;
    const dr = theirs.r - 7,
      dc = theirs.c - 7;
    const pr = 7 - (dr === 0 ? 1 : dr > 0 ? 1 : -1);
    const pc = 7 - (dc === 0 ? 1 : dc > 0 ? 1 : -1);
    if (pr >= 0 && pr < SZ && pc >= 0 && pc < SZ && !board[pr][pc]) {
      return { r: pr, c: pc };
    }
    return null;
  }

  function profileFor(difficulty, opts) {
    const hard = difficulty === "hard";
    const normal = difficulty === "normal";
    let budget;
    if (typeof opts.nodeBudget === "number" && opts.nodeBudget > 0) budget = 0;
    else if (typeof opts.timeMs === "number") budget = opts.timeMs;
    else if (hard) budget = opts.think === "fast" ? 800 : opts.think === "deep" ? 3500 : 2000;
    else if (normal) budget = 250;
    else budget = 0;
    return {
      budgetMs: budget,
      nodeBudget:
        typeof opts.nodeBudget === "number" && opts.nodeBudget > 0 ? opts.nodeBudget : 0,
      vcfDepth: hard ? 24 : normal ? 12 : 0,
      // VCT kept shallow on purpose: long speculative chains are where the
      // bounded defense generation goes unsound, and lost real games. Deep
      // wins re-emerge move by move as the position develops.
      vctDepth: hard ? 8 : normal ? 4 : 0,
      abDepth: hard ? 8 : normal ? 5 : 1,
      useVct: hard || normal,
    };
  }

  /**
   * The eight symmetries of a square board, as (r,c) → (r,c) on 15×15.
   * Index 0 is the identity and is always first, which is what keeps
   * `vary: false` byte-identical to the pre-v1.31 engine.
   */
  const SYMS = [
    (r, c) => ({ r: r, c: c }),                       // identity
    (r, c) => ({ r: c, c: SZ - 1 - r }),              // rotate 90
    (r, c) => ({ r: SZ - 1 - r, c: SZ - 1 - c }),     // rotate 180
    (r, c) => ({ r: SZ - 1 - c, c: r }),              // rotate 270
    (r, c) => ({ r: r, c: SZ - 1 - c }),              // mirror |
    (r, c) => ({ r: SZ - 1 - r, c: c }),              // mirror —
    (r, c) => ({ r: c, c: r }),                       // mirror ╲
    (r, c) => ({ r: SZ - 1 - c, c: SZ - 1 - r }),     // mirror ╱
  ];

  /** Symmetries that map the position onto itself, colours included. */
  function stabilizer(board) {
    const out = [];
    for (let s = 0; s < SYMS.length; s++) {
      const f = SYMS[s];
      let same = true;
      for (let r = 0; r < SZ && same; r++) {
        for (let c = 0; c < SZ; c++) {
          const p = f(r, c);
          if (board[r][c] !== board[p.r][p.c]) { same = false; break; }
        }
      }
      if (same) out.push(f);
    }
    return out;
  }

  /**
   * Equally-good alternatives to `mv`, obtained by mapping it through every
   * symmetry the position already has. Not a heuristic: if the board is
   * unchanged by a reflection, the reflected reply is the SAME move in a
   * mirrored frame, so strength cannot differ — unlike picking a
   * near-equal-scoring move, which trades real strength for variety.
   *
   * Why this exists: through v1.30 the engine was fully deterministic above
   * 简单, so repeating an opening replayed the identical game — measured 1
   * distinct game in 8 at 困难, 2 in 8 at 普通. The four orthogonal
   * neighbours of 天元 are one orbit, and each leads somewhere different
   * once the human keeps playing absolute coordinates.
   *
   * `mv` itself is always first, so a caller that wants the old behaviour
   * (deterministic suites, the puzzle generator, the arena baseline) can
   * take [0] — or pass vary:false and never get here at all.
   */
  function symmetryOrbit(board, mv) {
    if (!mv) return [];
    const seen = new Set([mv.r * SZ + mv.c]);
    const out = [{ r: mv.r, c: mv.c }];
    for (const f of stabilizer(board)) {
      const p = f(mv.r, mv.c);
      const k = p.r * SZ + p.c;
      if (!seen.has(k) && !board[p.r][p.c]) { seen.add(k); out.push(p); }
    }
    return out;
  }

  /** Pick uniformly from the orbit; `vary:false` or a 1-element orbit is a no-op. */
  function varyBySymmetry(board, mv, opts) {
    if (!mv || (opts && opts.vary === false)) return mv;
    const orbit = symmetryOrbit(board, mv);
    if (orbit.length < 2) return mv;
    const rnd = opts && typeof opts.rng === "function" ? opts.rng : Math.random;
    return orbit[Math.min(orbit.length - 1, (rnd() * orbit.length) | 0)];
  }

  function aiMove(opts) {
    const mv = aiMoveCore(opts);
    return legalizeRenju(opts, varyBySymmetry(opts.board, mv, opts));
  }

  /**
   * 连珠禁手:引擎交出去的那一手必须合法。
   *
   * 这是**出口精确**,不是搜索内部认规则 —— 后者的价钱量过:困难档一手展开
   * 43 万(C1)/ 135 万(C2)个候选,每个调一次 Core.renjuForbidden(13.5µs)
   * 要 5.9s / 18.2s,是 2000ms 预算的 292% / 911%。所以搜索照自由式算,只在
   * 交货口验一次:一个点,13.5µs,预算的 0.0007%。
   *
   * 也**不能**把判定塞进 emptiesNear —— 那个辅助函数不知道自己在为谁生成候选,
   * 13 个调用点黑白共用,挂上去会把这些点从**白方**的候选里一并删掉,而那正是
   * 白方最想占的地方(黑走不了,白占了就赚)。等于把规则的好处送给对手。
   *
   * 兜底用静态排序里第一个合法点。它比搜索结果弱,但只在引擎真踩线时才用得上
   * —— 实测 24 局里 8 局各踩一次(C1)、10 局各踩一次(C2),约每 60–150 手一次。
   */
  function legalizeRenju(opts, mv) {
    if (!opts || !opts.renju || !mv) return mv;
    const me = opts.side === "b" || opts.side === "w" ? opts.side : Core.opp(opts.humanColor || "b");
    if (me !== "b") return mv;                       // 禁手只约束黑
    const board = opts.board;
    if (!Core.renjuForbidden(board, mv.r, mv.c)) return mv;
    renjuFallbacks++;
    const ranked = rankMoves(cloneBoard(board), "b", 60, null);
    for (let i = 0; i < ranked.length; i++) {
      const m = ranked[i];
      if (!Core.renjuForbidden(board, m.r, m.c)) return { r: m.r, c: m.c };
    }
    // 排序里一个合法点都没有(极罕见):全盘找
    for (let r = 0; r < SZ; r++) {
      for (let c = 0; c < SZ; c++) {
        if (!board[r][c] && !Core.renjuForbidden(board, r, c)) return { r: r, c: c };
      }
    }
    return mv;   // 黑无处可走 —— 交回原手,由对局层处理
  }

  /** 出口兜底触发过多少次(闸门用:它必须真的会触发,也必须罕见)。 */
  let renjuFallbacks = 0;

  function aiMoveCore(opts) {
    const board = cloneBoard(opts.board);
    const difficulty = opts.difficulty || "normal";
    const me =
      opts.side === "b" || opts.side === "w" ? opts.side : Core.opp(opts.humanColor || "b");
    const them = Core.opp(me);
    const prof = profileFor(difficulty, opts || {});
    const ctx = {
      t1: prof.budgetMs > 0 ? nowMs() + prof.budgetMs : 0,
      e1: prof.nodeBudget > 0 ? evalTick + prof.nodeBudget : 0,
    };
    /**
     * Budget slice: sub-deadline at `frac` of the REMAINING budget (both
     * dimensions). Without this, VCT alone could burn the whole budget and
     * starve searchRoot.
     */
    const stageCtx = (frac) => {
      const out = { t1: 0, e1: 0 };
      if (ctx.t1) {
        const now = nowMs();
        out.t1 = now >= ctx.t1 ? ctx.t1 : now + (ctx.t1 - now) * frac;
      }
      if (ctx.e1) {
        out.e1 = evalTick >= ctx.e1 ? ctx.e1 : Math.floor(evalTick + (ctx.e1 - evalTick) * frac);
      }
      if (!out.t1 && !out.e1) return ctx;
      return out;
    };
    ttReset();
    lastStage = "";

    if (!hasStone(board)) {
      lastStage = "book";
      if (difficulty === "easy") {
        return randomPick([
          { r: 7, c: 7 },
          { r: 6,  c: 6 },
          { r: 6, c: 8 },
          { r: 8, c: 6 },
          { r: 8, c: 8 },
        ]);
      }
      return { r: 7, c: 7 };
    }

    // Opening book, plies 2-3 (easy keeps its own randomness)
    if (difficulty !== "easy") {
      const bk = bookMove(board, me);
      if (bk) { lastStage = "book"; return bk; }
    }

    // Absolute win/block
    const cells = emptiesNear(board, 2);
    for (let i = 0; i < cells.length; i++) {
      if (Core.wouldWin(board, cells[i].r, cells[i].c, me)) { lastStage = "win"; return cells[i]; }
    }
    for (let i = 0; i < cells.length; i++) {
      if (Core.wouldWin(board, cells[i].r, cells[i].c, them)) { lastStage = "blockwin"; return cells[i]; }
    }

    lastStage = "easy";
    if (difficulty === "easy") {
      const ranked = rankMoves(board, me, 8, null);
      const pool = ranked.slice(0, 5);
      if (Math.random() < 0.55 && pool.length > 1) return randomPick(pool.slice(1)) || pool[0];
      return randomPick(pool.slice(0, 2)) || pool[0];
    }

    // P0 forced hierarchy (compound + live3)
    const force = forcedMove(board, me, ctx);

    // Own VCF before settling for mere live3 (≤35% of remaining budget)
    if (prof.vcfDepth > 0) {
      const v = findVCF(board, me, prof.vcfDepth, stageCtx(0.35));
      if (v) { lastStage = "vcf"; return v; }
    }

    // Decisive forces (own live4/dual, verified four-three) are safe now;
    // softer forces (blocks, pure double-live3) must not preempt the
    // opponent-VCF denial below — a four chain outruns them all.
    if (force && force._decisive) { lastStage = "force!"; return force; }

    // Deny opponent VCF (≤30% of remaining budget)
    if (prof.vcfDepth > 0 && !timedOut(ctx)) {
      const denyCtx = stageCtx(0.3);
      const ov = findVCF(board, them, Math.min(18, prof.vcfDepth), denyCtx);
      if (ov) {
        const defs = rankMoves(board, me, 28, denyCtx);
        for (let i = 0; i < defs.length; i++) {
          if (timedOut(denyCtx)) break;
          const d = defs[i];
          if (Core.wouldWin(board, d.r, d.c, me)) { lastStage = "deny"; return d; }
          board[d.r][d.c] = me;
          const ow = listWins(board, them);
          let still = null;
          if (!ow.length) still = findVCF(board, them, Math.min(16, prof.vcfDepth), denyCtx);
          board[d.r][d.c] = "";
          // A null `still` right at the deadline is a timeout, not a proof —
          // trusting it returned effectively random "defenses" under load.
          if (!ow.length && !still && !timedOut(denyCtx)) { lastStage = "deny"; return d; }
        }
        // No defense verified. A DEFENSIVE force (their live4/four-three
        // point) beats blindly occupying the chain's first move — a VCF often
        // reroutes around ov, a compound point does not move. An offensive
        // force (own double-3) is slower than their chain — never that here.
        if (force) {
          const fd = analyzePlace(board, force.r, force.c, them);
          if (fd.compound >= 4 || (fd.rush4 >= 1 && fd.live3 >= 1)) {
            lastStage = "force";
            return force;
          }
        }
        if (!board[ov.r][ov.c]) { lastStage = "deny-fb"; return ov; }
      }
    }

    // Softer force now that no opponent four-chain is pending
    if (force) { lastStage = "force"; return force; }

    // VCT (≤50% of remaining budget — the rest is reserved for searchRoot,
    // which previously could be starved to a depth-0 greedy pick)
    if (prof.useVct && prof.vctDepth > 0 && !timedOut(ctx)) {
      const vt = findVCT(board, me, prof.vctDepth, stageCtx(0.5));
      if (vt) { lastStage = "vct"; return vt; }
    }

    // Block opponent next-move compound points (bud stage)
    const danger = mustDefendPoints(board, them);
    if (danger.length && danger[0].compound >= 3) {
      // pick best dual-purpose among top danger
      let best = danger[0];
      let bestS = -Infinity;
      for (let i = 0; i < Math.min(6, danger.length); i++) {
        const p = danger[i];
        const o = analyzePlace(board, p.r, p.c, me);
        const s = p.s + o.score * 0.4;
        if (s > bestS) {
          bestS = s;
          best = p;
        }
      }
      lastStage = "danger";
      return { r: best.r, c: best.c };
    }

    const mv = searchRoot(board, me, prof.abDepth, ctx);
    if (mv) { lastStage = "search"; return mv; }
    lastStage = "fallback";
    const fb = rankMoves(board, me, 3, null);
    return fb[0] ? { r: fb[0].r, c: fb[0].c } : emptiesNear(board, 2)[0];
  }

  function hintMove(opts) {
    return aiMove({
      board: opts.board,
      side: opts.side,
      humanColor: opts.humanColor,
      difficulty: opts.difficulty === "easy" ? "hard" : opts.difficulty || "hard",
      timeMs: typeof opts.timeMs === "number" ? opts.timeMs : 1800,
      think: opts.think || "normal",
    });
  }

  function candidateMoves(board, maxN, nearDist, sideToMove) {
    return rankMoves(board, sideToMove || "b", maxN || 40, null).map((m) => ({ r: m.r, c: m.c }));
  }

  // shapeAt alias for older tests
  function shapeAt(board, r, c, color) {
    return analyzePlace(board, r, c, color);
  }

  global.GobanAi = {
    aiMove: aiMove,
    aiMoveCore: aiMoveCore,
    symmetryOrbit: symmetryOrbit,
    stabilizer: stabilizer,
    varyBySymmetry: varyBySymmetry,
    hintMove: hintMove,
    candidateMoves: candidateMoves,
    evaluateBoard: evalStatic,
    cloneBoard: cloneBoard,
    listWinCells: listWins,
    findVCF: findVCF,
    findVCT: findVCT,
    shapeAt: shapeAt,
    analyzePlace: analyzePlace,
    mustDefendPoints: mustDefendPoints,
    profileFor: profileFor,
    /**
     * 公开包装。第三个参数是调用方的预算 ctx —— 不传才退回那条写死的 300ms 墙钟。
     *
     * 加这个参数是为了确定性:C2 每一手都调这里(ai2.js 的战术级联第 3 级),而这
     * 个包装原本**无条件**用墙钟,连调用方明明在节点预算模式下也照用。于是 C2 在
     * 「确定性」模式下的着法序列跟机器快慢有关 —— 实测同一进程连跑两次,着法从第
     * 一手就分岔。指纹闸门(自由式逐位零影响)因此根本立不起来。
     * 不传 ctx 时的行为一个字没变,墙钟档的棋力不受影响。
     */
    forcedMove: function (b, me, ctx) {
      return forcedMove(cloneBoard(b), me, ctx || { t1: nowMs() + 300 });
    },
    lastStage: function () {
      return lastStage;
    },
    legalizeRenju: legalizeRenju,
    renjuFallbacks: function () {
      return renjuFallbacks;
    },
    /** Current analyzePlace tick — lets callers build deterministic sub-budgets. */
    ticks: function () {
      return evalTick;
    },
  };
})(typeof window !== "undefined" ? window : globalThis);
