/**
 * C1.c — threat-first freestyle gomoku engine.
 * Priority: win > block win > dual > rush4 > block rush4/live4 >
 *           live3 attack/block > VCF/VCT > α-β (threat moves deep).
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

  // Zobrist + TT
  const ZN = SZ * SZ;
  const zobrist = new Uint32Array(ZN * 2 + 1);
  (function () {
    let s = 0xA15C1C1c >>> 0;
    for (let i = 0; i < zobrist.length; i++) {
      s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
      zobrist[i] = s;
    }
  })();
  const Z_SIDE = ZN * 2;
  const TT_N = 1 << 19;
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

  function cloneBoard(board) {
    const o = new Array(SZ);
    for (let r = 0; r < SZ; r++) o[r] = board[r].slice();
    return o;
  }
  function nowMs() {
    return typeof performance !== "undefined" && performance.now ? performance.now() : Date.now();
  }
  function timedOut(ctx) {
    return ctx && ctx.t1 > 0 && nowMs() >= ctx.t1;
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

  /** Line pattern through (r,c) for color already placed or to place. */
  function scanDir(board, r, c, dr, dc, color) {
    // Build string of 9 cells centered: 0 empty, 1 me, 2 opp, 3 wall
    const cells = [];
    for (let k = -4; k <= 4; k++) {
      const rr = r + dr * k,
        cc = c + dc * k;
      if (rr < 0 || rr >= SZ || cc < 0 || cc >= SZ) cells.push(3);
      else if (board[rr][cc] === color) cells.push(1);
      else if (!board[rr][cc]) cells.push(0);
      else cells.push(2);
    }
    // Force center as me
    cells[4] = 1;
    return cells;
  }

  /**
   * Pattern score for placing color at (r,c). Uses window matching.
   * Returns {score, tier} tier: 5=win, 4=live4, 3=rush4, 2=live3, 1=sleep3/live2
   */
  function patternPlace(board, r, c, color) {
    if (board[r][c]) return { score: -1e15, tier: 0, wins: 0, live4: 0, rush4: 0, live3: 0 };
    if (Core.wouldWin(board, r, c, color)) {
      return { score: 1e9, tier: 5, wins: 1, live4: 0, rush4: 0, live3: 0 };
    }
    board[r][c] = color;
    let score = 0,
      live4 = 0,
      rush4 = 0,
      live3 = 0,
      sleep3 = 0,
      live2 = 0;
    // consecutive metric (fast)
    for (let di = 0; di < 4; di++) {
      const dr = DIRS[di][0],
        dc = DIRS[di][1];
      let cnt = 1,
        o1 = 0,
        o2 = 0;
      let rr = r + dr,
        cc = c + dc;
      while (rr >= 0 && rr < SZ && cc >= 0 && cc < SZ && board[rr][cc] === color) {
        cnt++;
        rr += dr;
        cc += dc;
      }
      if (rr >= 0 && rr < SZ && cc >= 0 && cc < SZ && !board[rr][cc]) o1 = 1;
      rr = r - dr;
      cc = c - dc;
      while (rr >= 0 && rr < SZ && cc >= 0 && cc < SZ && board[rr][cc] === color) {
        cnt++;
        rr -= dr;
        cc -= dc;
      }
      if (rr >= 0 && rr < SZ && cc >= 0 && cc < SZ && !board[rr][cc]) o2 = 1;
      const open = o1 + o2;
      if (cnt >= 5) score += 1e9;
      else if (cnt === 4 && open === 2) {
        live4++;
        score += 600000;
      } else if (cnt === 4 && open === 1) {
        rush4++;
        score += 100000;
      } else if (cnt === 3 && open === 2) {
        live3++;
        score += 20000;
      } else if (cnt === 3 && open === 1) {
        sleep3++;
        score += 1200;
      } else if (cnt === 2 && open === 2) {
        live2++;
        score += 600;
      } else if (cnt === 2 && open === 1) score += 50;
      else score += cnt * 8;

      // jump patterns: ●●_● / ●_●●  (broken three → often live3-like)
      const win = scanDir(board, r, c, dr, dc, color);
      const str = win.join("");
      // 011010 / 010110 with empties — jump live three
      if (
        str.indexOf("011010") >= 0 ||
        str.indexOf("010110") >= 0 ||
        str.indexOf("01110") >= 0
      ) {
        // already counted consecutive; boost jump
        if (str.indexOf("011010") >= 0 || str.indexOf("010110") >= 0) {
          live3++;
          score += 15000;
        }
      }
      // jump four ●●_●●
      if (str.indexOf("0110110") >= 0 || str.indexOf("11011") >= 0) {
        rush4++;
        score += 80000;
      }
    }
    if (live4 >= 1 || rush4 >= 2) score += 500000;
    if (live3 >= 2) score += 350000;
    if (live3 >= 1 && (rush4 >= 1 || live4 >= 1)) score += 400000;

    const wins = listWins(board, color).length;
    board[r][c] = "";
    score += wins * 200000;
    score += (14 - (Math.abs(r - 7) + Math.abs(c - 7))) * 4;

    let tier = 0;
    if (wins >= 1 || live4 >= 1) tier = 4;
    else if (rush4 >= 1 || wins >= 1) tier = 3;
    else if (live3 >= 1) tier = 2;
    else if (sleep3 || live2) tier = 1;
    if (wins >= 2 || live4 >= 1 || (rush4 >= 1 && live3 >= 1) || live3 >= 2) tier = Math.max(tier, 4);
    if (Core.wouldWin(board, r, c, color)) tier = 5;

    return {
      score: score,
      tier: tier,
      wins: wins,
      live4: live4,
      rush4: rush4,
      live3: live3,
      sleep3: sleep3,
      live2: live2,
    };
  }

  function evalStatic(board, me) {
    const them = Core.opp(me);
    let sc = 0;
    for (let r = 0; r < SZ; r++)
      for (let c = 0; c < SZ; c++) {
        if (!board[r][c]) continue;
        const col = board[r][c];
        const sign = col === me ? 1 : -1.2;
        for (let di = 0; di < 4; di++) {
          const dr = DIRS[di][0],
            dc = DIRS[di][1];
          const pr = r - dr,
            pc = c - dc;
          if (pr >= 0 && pr < SZ && pc >= 0 && pc < SZ && board[pr][pc] === col) continue;
          let cnt = 0,
            rr = r,
            cc = c;
          while (rr >= 0 && rr < SZ && cc >= 0 && cc < SZ && board[rr][cc] === col) {
            cnt++;
            rr += dr;
            cc += dc;
          }
          let open = 0;
          const br = r - dr,
            bc = c - dc;
          if (br < 0 || br >= SZ || bc < 0 || bc >= SZ || !board[br][bc]) open++;
          if (rr < 0 || rr >= SZ || cc < 0 || cc >= SZ || !board[rr][cc]) open++;
          let v = 0;
          if (cnt >= 5) v = 1e6;
          else if (cnt === 4 && open === 2) v = 300000;
          else if (cnt === 4 && open === 1) v = 50000;
          else if (cnt === 3 && open === 2) v = 12000;
          else if (cnt === 3 && open === 1) v = 700;
          else if (cnt === 2 && open === 2) v = 300;
          else v = cnt * 5;
          sc += sign * v;
        }
        sc += sign * (14 - (Math.abs(r - 7) + Math.abs(c - 7))) * 0.4;
      }
    // side-to-move threats bonus for me already reflected by caller
    return sc;
  }

  /**
   * Ranked moves. offense + deny opponent patterns.
   */
  function rankMoves(board, me, maxN, ctx) {
    const them = Core.opp(me);
    const raw = emptiesNear(board, 2);
    const out = [];
    for (let i = 0; i < raw.length; i++) {
      if (timedOut(ctx)) break;
      const m = raw[i];
      const off = patternPlace(board, m.r, m.c, me);
      const def = patternPlace(board, m.r, m.c, them);
      let s = off.score + def.score * 1.05; // defend slightly more
      if (off.tier >= 5) s = 1e12;
      else if (def.tier >= 5) s = 1e11 + def.score;
      else if (off.tier >= 4) s = 1e10 + off.score;
      else if (def.tier >= 4) s = 5e9 + def.score;
      else if (off.tier >= 3) s = 1e9 + off.score;
      else if (def.tier >= 3) s = 5e8 + def.score;
      out.push({ r: m.r, c: m.c, s: s, off: off, def: def });
    }
    out.sort((a, b) => b.s - a.s);
    return out.slice(0, maxN || out.length);
  }

  /** Only tactical / threat-related moves for deep search. */
  function threatMoves(board, me, maxN, ctx) {
    const all = rankMoves(board, me, 40, ctx);
    const t = [];
    for (let i = 0; i < all.length; i++) {
      const m = all[i];
      if (
        m.off.tier >= 2 ||
        m.def.tier >= 2 ||
        m.off.live3 ||
        m.def.live3 ||
        m.off.rush4 ||
        m.def.rush4 ||
        m.off.live4 ||
        m.def.live4 ||
        m.off.wins ||
        m.def.wins
      ) {
        t.push(m);
      }
    }
    if (t.length < 6) return all.slice(0, maxN || 16);
    return t.slice(0, maxN || 20);
  }

  /**
   * Forced / high-priority root move. Returns move or null.
   */
  function forcedMove(board, me, ctx) {
    const them = Core.opp(me);
    const cells = emptiesNear(board, 2);

    // 1 win
    for (let i = 0; i < cells.length; i++) {
      if (Core.wouldWin(board, cells[i].r, cells[i].c, me)) return cells[i];
    }
    // 2 block win
    for (let i = 0; i < cells.length; i++) {
      if (Core.wouldWin(board, cells[i].r, cells[i].c, them)) return cells[i];
    }

    // Classify each empty
    const myDual = [];
    const myFour = []; // creates ≥1 win cell
    const myLive3 = [];
    const theirDual = [];
    const theirFour = [];
    const theirLive3 = [];

    for (let i = 0; i < cells.length; i++) {
      if (timedOut(ctx)) break;
      const m = cells[i];
      // my place
      board[m.r][m.c] = me;
      const mw = listWins(board, me).length;
      board[m.r][m.c] = "";
      const mo = patternPlace(board, m.r, m.c, me);
      if (mw >= 2 || mo.live4 >= 1 || (mo.rush4 >= 1 && mo.live3 >= 1) || mo.live3 >= 2) {
        myDual.push({ m: m, s: mo.score + mw * 1e6 });
      } else if (mw >= 1 || mo.rush4 >= 1 || mo.live4 >= 1) {
        myFour.push({ m: m, s: mo.score });
      } else if (mo.live3 >= 1) {
        myLive3.push({ m: m, s: mo.score });
      }

      board[m.r][m.c] = them;
      const tw = listWins(board, them).length;
      board[m.r][m.c] = "";
      const to = patternPlace(board, m.r, m.c, them);
      if (tw >= 2 || to.live4 >= 1 || (to.rush4 >= 1 && to.live3 >= 1) || to.live3 >= 2) {
        theirDual.push({ m: m, s: to.score + tw * 1e6 });
      } else if (tw >= 1 || to.rush4 >= 1 || to.live4 >= 1) {
        theirFour.push({ m: m, s: to.score });
      } else if (to.live3 >= 1) {
        theirLive3.push({ m: m, s: to.score });
      }
    }

    const best = (arr) => {
      if (!arr.length) return null;
      arr.sort((a, b) => b.s - a.s);
      return arr[0].m;
    };

    // 3 my dual / live4 fork
    if (myDual.length) return best(myDual);
    // 4 block their dual
    if (theirDual.length) return best(theirDual);
    // 5 my rush four (force)
    if (myFour.length) return best(myFour);
    // 6 block their rush four / four-makers
    if (theirFour.length) return best(theirFour);
    // 7 my live3 (if they don't have equal — already no four)
    // Prefer live3 that also defends
    if (myLive3.length && !theirLive3.length) return best(myLive3);
    // 8 block their live3 (mandatory when we have no four)
    if (theirLive3.length) {
      // If we can counter with live3 that also hits their threat, prefer
      if (myLive3.length) {
        // intersection: moves in myLive3 that are also theirLive3 cells
        const set = {};
        for (let i = 0; i < theirLive3.length; i++) {
          set[theirLive3[i].m.r + "," + theirLive3[i].m.c] = true;
        }
        for (let i = 0; i < myLive3.length; i++) {
          const k = myLive3[i].m.r + "," + myLive3[i].m.c;
          if (set[k]) return myLive3[i].m;
        }
        // both attack: play strongest live3 if dual-ish
        myLive3.sort((a, b) => b.s - a.s);
        theirLive3.sort((a, b) => b.s - a.s);
        // if my live3 is dual-type already handled; else block theirs
      }
      return best(theirLive3);
    }
    if (myLive3.length) return best(myLive3);
    return null;
  }

  // VCF
  function findVCF(board, me, maxD, ctx) {
    return vcf(board, me, 0, maxD, ctx);
  }
  function vcf(board, me, d, maxD, ctx) {
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
    const cap = Math.min(attacks.length, d === 0 ? 24 : 16);
    for (let i = 0; i < cap; i++) {
      if (timedOut(ctx)) break;
      const { m, b } = attacks[i];
      board[m.r][m.c] = me;
      board[b.r][b.c] = them;
      const ok = vcf(board, me, d + 1, maxD, ctx);
      board[b.r][b.c] = "";
      board[m.r][m.c] = "";
      if (ok) return m;
    }
    return null;
  }

  // VCT with live3
  function findVCT(board, me, maxD, ctx) {
    return vct(board, me, 0, maxD, ctx);
  }
  function vct(board, me, d, maxD, ctx) {
    if (timedOut(ctx) || d > maxD) return null;
    const them = Core.opp(me);
    const f = findVCF(board, me, maxD - d + 8, ctx);
    if (f) return f;

    const moves = threatMoves(board, me, d === 0 ? 18 : 12, ctx);
    for (let i = 0; i < moves.length; i++) {
      if (Core.wouldWin(board, moves[i].r, moves[i].c, me)) return moves[i];
    }
    for (let i = 0; i < moves.length; i++) {
      if (timedOut(ctx)) break;
      const m = moves[i];
      if (m.off.tier < 2 && m.off.live3 < 1 && m.off.rush4 < 1) continue;
      board[m.r][m.c] = me;
      if (Core.findWin(board, m.r, m.c, me)) {
        board[m.r][m.c] = "";
        return m;
      }
      if (listWins(board, them).length) {
        board[m.r][m.c] = "";
        continue;
      }
      const mw = listWins(board, me);
      if (mw.length >= 2) {
        board[m.r][m.c] = "";
        return m;
      }
      let replies;
      if (mw.length === 1) replies = [mw[0]];
      else {
        // block our live3 points: their best defenses
        const def = threatMoves(board, them, 4, ctx);
        replies = def.map((x) => ({ r: x.r, c: x.c }));
        if (!replies.length) {
          board[m.r][m.c] = "";
          continue;
        }
      }
      let good = true;
      for (let j = 0; j < replies.length; j++) {
        const r = replies[j];
        if (board[r.r][r.c]) continue;
        board[r.r][r.c] = them;
        if (Core.findWin(board, r.r, r.c, them)) {
          good = false;
          board[r.r][r.c] = "";
          break;
        }
        const cont = findVCF(board, me, 10, ctx) || vct(board, me, d + 1, maxD, ctx);
        board[r.r][r.c] = "";
        if (!cont) {
          good = false;
          break;
        }
      }
      board[m.r][m.c] = "";
      if (good && replies.length) return m;
    }
    return null;
  }

  function negamax(board, depth, alpha, beta, side, root, ctx, ply, h, killers, hist, threatOnly) {
    if (timedOut(ctx)) return evalStatic(board, root);
    const a0 = alpha;
    let ttMv = -1;
    const hit = ttGet(h, depth, alpha, beta);
    if (hit) {
      if (hit.sc != null) return hit.sc;
      if (hit.mv >= 0) ttMv = hit.mv;
    }
    if (depth <= 0) {
      // quiescence: one ply of threats
      return quiesce(board, alpha, beta, side, root, ctx, ply, h, 2);
    }

    // terminal tactics
    const cells0 = emptiesNear(board, 2);
    for (let i = 0; i < cells0.length; i++) {
      if (Core.wouldWin(board, cells0[i].r, cells0[i].c, side)) {
        return 8e6 - ply;
      }
    }

    let moves =
      threatOnly || depth >= 3
        ? threatMoves(board, side, depth >= 5 ? 12 : 16, ctx)
        : rankMoves(board, side, depth >= 4 ? 14 : 20, ctx);

    if (ttMv >= 0) {
      const tr = unR(ttMv),
        tc = unC(ttMv);
      const ix = moves.findIndex((m) => m.r === tr && m.c === tc);
      if (ix > 0) {
        const t = moves[ix];
        moves.splice(ix, 1);
        moves.unshift(t);
      } else if (ix < 0 && !board[tr][tc]) moves.unshift({ r: tr, c: tc, s: 1e15, off: {}, def: {} });
    }
    // killers
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
    for (let i = 0; i < moves.length; i++) {
      if (timedOut(ctx)) break;
      const m = moves[i];
      if (board[m.r][m.c]) continue;
      // must block opponent win
      const them = Core.opp(side);
      // If opponent has win-in-1 and this move isn't block or our win, skip
      // (cheap check once per node via first move ordering — full check:)
      board[m.r][m.c] = side;
      let val;
      if (Core.findWin(board, m.r, m.c, side)) {
        val = 8e6 - ply;
      } else {
        // opponent immediate win left?
        const ow = listWins(board, them);
        if (ow.length) {
          val = -8e6 + ply;
        } else {
          const h2 = xorPlace(h, m.r, m.c, side) ^ zobrist[Z_SIDE];
          const ext =
            (m.off && (m.off.tier >= 3 || m.off.live3 >= 1)) ||
            (m.def && m.def.tier >= 3)
              ? 1
              : 0;
          const nd = depth - 1 + (ext && depth < 6 ? 0 : 0);
          if (i === 0 || depth < 3) {
            val = -negamax(
              board,
              nd,
              -beta,
              -alpha,
              them,
              root,
              ctx,
              ply + 1,
              h2,
              killers,
              hist,
              depth >= 3
            );
          } else {
            val = -negamax(
              board,
              nd,
              -alpha - 1,
              -alpha,
              them,
              root,
              ctx,
              ply + 1,
              h2,
              killers,
              hist,
              true
            );
            if (val > alpha && val < beta) {
              val = -negamax(
                board,
                nd,
                -beta,
                -alpha,
                them,
                root,
                ctx,
                ply + 1,
                h2,
                killers,
                hist,
                depth >= 3
              );
            }
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
        if (hist && bestC >= 0) hist[bestC] = (hist[bestC] || 0) + depth * depth;
        break;
      }
    }
    let fl = EX;
    if (best <= a0) fl = UP;
    else if (best >= beta) fl = LO;
    ttPut(h, depth, fl, best, bestC);
    return best;
  }

  function quiesce(board, alpha, beta, side, root, ctx, ply, h, qdepth) {
    const stand = evalStatic(board, root);
    if (qdepth <= 0 || timedOut(ctx)) return stand;
    if (stand >= beta) return stand;
    if (stand > alpha) alpha = stand;
    const them = Core.opp(side);
    // only captures of threats
    const moves = threatMoves(board, side, 10, ctx);
    for (let i = 0; i < moves.length; i++) {
      if (timedOut(ctx)) break;
      const m = moves[i];
      if (!m.off || m.off.tier < 2) {
        if (!m.def || m.def.tier < 3) continue;
      }
      if (Core.wouldWin(board, m.r, m.c, side)) return 8e6 - ply;
      board[m.r][m.c] = side;
      if (listWins(board, them).length) {
        board[m.r][m.c] = "";
        continue;
      }
      const h2 = xorPlace(h, m.r, m.c, side) ^ zobrist[Z_SIDE];
      const val = -quiesce(board, -beta, -alpha, them, root, ctx, ply + 1, h2, qdepth - 1);
      board[m.r][m.c] = "";
      if (val >= beta) return val;
      if (val > alpha) alpha = val;
    }
    return alpha;
  }

  function searchRoot(board, me, maxD, ctx) {
    const them = Core.opp(me);
    const killers = [new Int16Array(64).fill(-1), new Int16Array(64).fill(-1)];
    const hist = new Int32Array(256);
    const h0 = hashBoard(board, me);
    let moves = rankMoves(board, me, 28, ctx);
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
      let a = -Infinity,
        b = Infinity;
      if (depth >= 3 && Math.abs(bestV) < 1e6) {
        const w = 2000 + depth * 400;
        a = bestV - w;
        b = bestV + w;
      }
      let iBest = best,
        iVal = -Infinity;
      for (let i = 0; i < moves.length; i++) {
        if (timedOut(ctx)) break;
        const m = moves[i];
        if (Core.wouldWin(board, m.r, m.c, me)) return { r: m.r, c: m.c };
        board[m.r][m.c] = me;
        let val;
        if (Core.findWin(board, m.r, m.c, me)) val = 8e6;
        else if (listWins(board, them).length) val = -8e6;
        else {
          const h2 = xorPlace(h0, m.r, m.c, me) ^ zobrist[Z_SIDE];
          val = -negamax(
            board,
            depth - 1,
            -b,
            -a,
            them,
            me,
            ctx,
            1,
            h2,
            killers,
            hist,
            depth >= 3
          );
          if ((val <= a || val >= b) && !timedOut(ctx)) {
            val = -negamax(
              board,
              depth - 1,
              -Infinity,
              Infinity,
              them,
              me,
              ctx,
              1,
              h2,
              killers,
              hist,
              depth >= 3
            );
          }
        }
        board[m.r][m.c] = "";
        if (val > iVal) {
          iVal = val;
          iBest = { r: m.r, c: m.c };
        }
        if (val > a) a = val;
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

  function profileFor(difficulty, opts) {
    const hard = difficulty === "hard";
    const normal = difficulty === "normal";
    let budget;
    if (typeof opts.timeMs === "number") budget = opts.timeMs;
    else if (hard) {
      budget = opts.think === "fast" ? 800 : opts.think === "deep" ? 3500 : 2000;
    } else if (normal) budget = 250;
    else budget = 0;
    return {
      budgetMs: budget,
      vcfDepth: hard ? 22 : normal ? 12 : 0,
      vctDepth: hard ? 12 : normal ? 5 : 0,
      abDepth: hard ? 8 : normal ? 5 : 1,
      useVct: hard || normal,
    };
  }

  function aiMove(opts) {
    const board = cloneBoard(opts.board);
    const difficulty = opts.difficulty || "normal";
    const me =
      opts.side === "b" || opts.side === "w"
        ? opts.side
        : Core.opp(opts.humanColor || "b");
    const them = Core.opp(me);
    const prof = profileFor(difficulty, opts || {});
    const ctx = { t1: prof.budgetMs > 0 ? nowMs() + prof.budgetMs : 0 };
    ttReset();

    if (!hasStone(board)) {
      if (difficulty === "easy") {
        return randomPick([
          { r: 7, c: 7 },
          { r: 6, c: 6 },
          { r: 6, c: 8 },
          { r: 8, c: 6 },
          { r: 8, c: 8 },
        ]);
      }
      return { r: 7, c: 7 };
    }

    // —— Absolute forced hierarchy ——
    const force = forcedMove(board, me, ctx);
    // forcedMove includes win/block/dual/four/live3 — always trust for hard/normal
    if (force && difficulty !== "easy") {
      // Still allow VCF if force is only live3 and VCF exists elsewhere? 
      // For four+ always return force
      const fo = patternPlace(board, force.r, force.c, me);
      const fd = patternPlace(board, force.r, force.c, them);
      if (fo.tier >= 3 || fd.tier >= 3 || fo.tier >= 5 || fd.tier >= 5) return force;
      // live3 force: check own VCF first
      if (prof.vcfDepth > 0) {
        const vcfM = findVCF(board, me, prof.vcfDepth, ctx);
        if (vcfM) return vcfM;
      }
      return force;
    }

    if (difficulty === "easy") {
      const ranked = rankMoves(board, me, 8, null);
      const pool = ranked.slice(0, 5);
      if (Math.random() < 0.55 && pool.length > 1) return randomPick(pool.slice(1)) || pool[0];
      return randomPick(pool.slice(0, 2)) || pool[0];
    }

    // VCF
    if (prof.vcfDepth > 0) {
      const v = findVCF(board, me, prof.vcfDepth, ctx);
      if (v) return v;
    }
    // Deny opponent VCF
    if (prof.vcfDepth > 0 && !timedOut(ctx)) {
      const ov = findVCF(board, them, Math.min(16, prof.vcfDepth), ctx);
      if (ov) {
        const defs = rankMoves(board, me, 26, ctx);
        for (let i = 0; i < defs.length; i++) {
          if (timedOut(ctx)) break;
          const d = defs[i];
          if (Core.wouldWin(board, d.r, d.c, me)) return d;
          board[d.r][d.c] = me;
          const ow = listWins(board, them);
          let still = null;
          if (!ow.length) still = findVCF(board, them, Math.min(14, prof.vcfDepth), ctx);
          board[d.r][d.c] = "";
          if (!ow.length && !still) return d;
        }
        if (!board[ov.r][ov.c]) return ov;
      }
    }

    // VCT
    if (prof.useVct && prof.vctDepth > 0 && !timedOut(ctx)) {
      const vt = findVCT(board, me, prof.vctDepth, ctx);
      if (vt) return vt;
    }

    // If forced live3 was deferred and still pending
    if (force) return force;

    const mv = searchRoot(board, me, prof.abDepth, ctx);
    if (mv) return mv;
    const fb = rankMoves(board, me, 3, null);
    return fb[0] ? { r: fb[0].r, c: fb[0].c } : emptiesNear(board, 2)[0];
  }

  function hintMove(opts) {
    return aiMove({
      board: opts.board,
      side: opts.side,
      humanColor: opts.humanColor,
      difficulty: opts.difficulty === "easy" ? "hard" : opts.difficulty || "hard",
      timeMs: typeof opts.timeMs === "number" ? opts.timeMs : 1500,
      think: opts.think || "normal",
    });
  }

  function candidateMoves(board, maxN, nearDist, sideToMove) {
    return rankMoves(board, sideToMove || "b", maxN || 40, null).map((m) => ({
      r: m.r,
      c: m.c,
    }));
  }

  global.GobanAi = {
    aiMove: aiMove,
    hintMove: hintMove,
    candidateMoves: candidateMoves,
    evaluateBoard: evalStatic,
    cloneBoard: cloneBoard,
    listWinCells: listWins,
    findVCF: findVCF,
    findVCT: findVCT,
    shapeAt: patternPlace,
    profileFor: profileFor,
    forcedMove: function (b, me) {
      return forcedMove(cloneBoard(b), me, { t1: nowMs() + 200 });
    },
  };
})(typeof window !== "undefined" ? window : globalThis);
