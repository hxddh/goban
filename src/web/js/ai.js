/**
 * C1.b engine: patterns + VCF/VCT + TT + killers + iterative α-β.
 * Freestyle 15×15. Only mutates board copies / search state.
 * @module ai
 */
(function (global) {
  const Core = global.GobanCore;
  const N = () => Core.SIZE;
  const DIRS = [
    [0, 1],
    [1, 0],
    [1, 1],
    [1, -1],
  ];

  // --- Zobrist / TT --------------------------------------------------------
  const Z_CELLS = 15 * 15;
  const zobrist = new Uint32Array(Z_CELLS * 2 + 1);
  (function initZ() {
    let s = 0xC1B5C1B5 >>> 0;
    for (let i = 0; i < zobrist.length; i++) {
      s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
      zobrist[i] = s;
    }
  })();
  const Z_SIDE = Z_CELLS * 2;

  const TT_EXACT = 0;
  const TT_LOWER = 1;
  const TT_UPPER = 2;
  const TT_SIZE = 1 << 18; // 262k entries
  const ttKey = new Int32Array(TT_SIZE);
  const ttDepth = new Int8Array(TT_SIZE);
  const ttFlag = new Int8Array(TT_SIZE);
  const ttScore = new Float64Array(TT_SIZE);
  const ttMove = new Int16Array(TT_SIZE); // r*16+c or -1
  let ttEpoch = 1;
  const ttEpochArr = new Int32Array(TT_SIZE);

  function ttClear() {
    ttEpoch = (ttEpoch + 1) | 0;
    if (ttEpoch > 1e9) {
      ttEpoch = 1;
      ttEpochArr.fill(0);
    }
  }

  function ttIndex(hash) {
    return (hash >>> 0) & (TT_SIZE - 1);
  }

  function ttProbe(hash, depth, alpha, beta) {
    const i = ttIndex(hash);
    if (ttEpochArr[i] !== ttEpoch || ttKey[i] !== (hash | 0)) return null;
    if (ttDepth[i] < depth) return { move: ttMove[i], onlyMove: true };
    const sc = ttScore[i];
    const fl = ttFlag[i];
    if (fl === TT_EXACT) return { score: sc, move: ttMove[i] };
    if (fl === TT_LOWER && sc >= beta) return { score: sc, move: ttMove[i] };
    if (fl === TT_UPPER && sc <= alpha) return { score: sc, move: ttMove[i] };
    return { move: ttMove[i], onlyMove: true };
  }

  function ttStore(hash, depth, flag, score, moveRC) {
    const i = ttIndex(hash);
    // replace if empty epoch or deeper/equal
    if (ttEpochArr[i] === ttEpoch && ttDepth[i] > depth) return;
    ttEpochArr[i] = ttEpoch;
    ttKey[i] = hash | 0;
    ttDepth[i] = depth;
    ttFlag[i] = flag;
    ttScore[i] = score;
    ttMove[i] = moveRC == null ? -1 : moveRC;
  }

  function packMove(r, c) {
    return (r << 4) | c;
  }
  function unpackR(m) {
    return m >> 4;
  }
  function unpackC(m) {
    return m & 15;
  }

  function hashBoard(board, side) {
    let h = 0;
    const n = N();
    for (let r = 0; r < n; r++) {
      for (let c = 0; c < n; c++) {
        const s = board[r][c];
        if (!s) continue;
        const base = s === "b" ? 0 : Z_CELLS;
        h ^= zobrist[base + r * 15 + c];
      }
    }
    if (side === "w") h ^= zobrist[Z_SIDE];
    return h >>> 0;
  }

  function hashXorPlace(h, r, c, color) {
    const base = color === "b" ? 0 : Z_CELLS;
    return (h ^ zobrist[base + r * 15 + c]) >>> 0;
  }

  // --- utils ---------------------------------------------------------------
  function cloneBoard(board) {
    const n = N();
    const out = new Array(n);
    for (let r = 0; r < n; r++) out[r] = board[r].slice();
    return out;
  }

  function nowMs() {
    return typeof performance !== "undefined" && performance.now
      ? performance.now()
      : Date.now();
  }

  function timedOut(ctx) {
    return ctx && ctx.deadline > 0 && nowMs() >= ctx.deadline;
  }

  function nearStone(board, r, c, dist) {
    const d = dist || 2;
    const n = N();
    for (let dr = -d; dr <= d; dr++) {
      for (let dc = -d; dc <= d; dc++) {
        if (!dr && !dc) continue;
        const rr = r + dr,
          cc = c + dc;
        if (rr >= 0 && rr < n && cc >= 0 && cc < n && board[rr][cc]) return true;
      }
    }
    return false;
  }

  function hasAny(board) {
    const n = N();
    for (let r = 0; r < n; r++)
      for (let c = 0; c < n; c++) if (board[r][c]) return true;
    return false;
  }

  /** Win cells — only near stones (five-in-row cannot appear in empty region). */
  function listWinCells(board, color) {
    const n = N();
    const list = [];
    for (let r = 0; r < n; r++) {
      for (let c = 0; c < n; c++) {
        if (board[r][c]) continue;
        if (!nearStone(board, r, c, 1)) continue;
        if (Core.wouldWin(board, r, c, color)) list.push({ r: r, c: c });
      }
    }
    return list;
  }

  function lineRun(board, r, c, dr, dc, color) {
    const n = N();
    let cnt = 1;
    let rr = r + dr,
      cc = c + dc;
    while (rr >= 0 && rr < n && cc >= 0 && cc < n && board[rr][cc] === color) {
      cnt++;
      rr += dr;
      cc += dc;
    }
    const end1Open = rr >= 0 && rr < n && cc >= 0 && cc < n && !board[rr][cc] ? 1 : 0;
    rr = r - dr;
    cc = c - dc;
    while (rr >= 0 && rr < n && cc >= 0 && cc < n && board[rr][cc] === color) {
      cnt++;
      rr -= dr;
      cc -= dc;
    }
    const end2Open = rr >= 0 && rr < n && cc >= 0 && cc < n && !board[rr][cc] ? 1 : 0;
    return { cnt: cnt, open: end1Open + end2Open };
  }

  function shapeAt(board, r, c, color) {
    if (board[r][c]) {
      return { score: -1e15, wins: 0, live4: 0, rush4: 0, live3: 0, sleep3: 0, live2: 0 };
    }
    if (Core.wouldWin(board, r, c, color)) {
      return { score: 1e12, wins: 1, live4: 0, rush4: 0, live3: 0, sleep3: 0, live2: 0 };
    }
    board[r][c] = color;
    let score = 0;
    let live4 = 0,
      rush4 = 0,
      live3 = 0,
      sleep3 = 0,
      live2 = 0;
    for (let d = 0; d < 4; d++) {
      const dr = DIRS[d][0],
        dc = DIRS[d][1];
      const { cnt, open } = lineRun(board, r, c, dr, dc, color);
      if (cnt >= 5) score += 1e12;
      else if (cnt === 4 && open === 2) {
        live4++;
        score += 520000;
      } else if (cnt === 4 && open === 1) {
        rush4++;
        score += 90000;
      } else if (cnt === 3 && open === 2) {
        live3++;
        score += 14000;
      } else if (cnt === 3 && open === 1) {
        sleep3++;
        score += 900;
      } else if (cnt === 2 && open === 2) {
        live2++;
        score += 480;
      } else if (cnt === 2 && open === 1) score += 45;
      else score += cnt * 6;
    }
    if (live4 >= 1 || rush4 >= 2) score += 420000;
    if (live3 >= 2) score += 220000;
    if (live3 >= 1 && rush4 >= 1) score += 280000;
    if (live3 >= 1 && live4 >= 1) score += 350000;

    const wins = listWinCells(board, color).length;
    board[r][c] = "";
    score += wins * 160000;
    score += (14 - (Math.abs(r - 7) + Math.abs(c - 7))) * 3;
    return {
      score: score,
      wins: wins,
      live4: live4,
      rush4: rush4,
      live3: live3,
      sleep3: sleep3,
      live2: live2,
    };
  }

  function candidateList(board, nearDist) {
    const n = N();
    if (!hasAny(board)) return [{ r: 7, c: 7 }];
    const list = [];
    const d = nearDist || 2;
    for (let r = 0; r < n; r++) {
      for (let c = 0; c < n; c++) {
        if (board[r][c]) continue;
        if (!nearStone(board, r, c, d)) continue;
        list.push({ r: r, c: c });
      }
    }
    if (!list.length) {
      for (let r = 0; r < n; r++)
        for (let c = 0; c < n; c++) if (!board[r][c]) list.push({ r: r, c: c });
    }
    return list;
  }

  function rankedCandidates(board, me, maxN, ctx, killers, history, ply) {
    const them = Core.opp(me);
    const raw = candidateList(board, 2);
    const scored = [];
    for (let i = 0; i < raw.length; i++) {
      if (timedOut(ctx)) break;
      const m = raw[i];
      const off = shapeAt(board, m.r, m.c, me);
      const def = shapeAt(board, m.r, m.c, them);
      let s = off.score + def.score * 0.96;
      if (Core.wouldWin(board, m.r, m.c, me)) s = 1e14;
      else if (Core.wouldWin(board, m.r, m.c, them)) s = 1e13 + def.score;
      // history / killers
      const code = packMove(m.r, m.c);
      if (killers && ply != null) {
        if (killers[0][ply] === code) s += 50000;
        else if (killers[1][ply] === code) s += 30000;
      }
      if (history) s += history[code] || 0;
      scored.push({ r: m.r, c: m.c, s: s, off: off, def: def });
    }
    scored.sort((a, b) => b.s - a.s);
    return scored.slice(0, maxN || scored.length);
  }

  function evaluateBoard(board, me) {
    const them = Core.opp(me);
    const n = N();
    let score = 0;
    for (let r = 0; r < n; r++) {
      for (let c = 0; c < n; c++) {
        if (!board[r][c]) continue;
        const color = board[r][c];
        const sign = color === me ? 1 : -1.18;
        for (let di = 0; di < 4; di++) {
          const dr = DIRS[di][0],
            dc = DIRS[di][1];
          const pr = r - dr,
            pc = c - dc;
          if (pr >= 0 && pr < n && pc >= 0 && pc < n && board[pr][pc] === color) continue;
          let cnt = 0;
          let rr = r,
            cc = c;
          while (rr >= 0 && rr < n && cc >= 0 && cc < n && board[rr][cc] === color) {
            cnt++;
            rr += dr;
            cc += dc;
          }
          let open = 0;
          const br = r - dr,
            bc = c - dc;
          if (br < 0 || br >= n || bc < 0 || bc >= n || !board[br][bc]) open++;
          if (rr < 0 || rr >= n || cc < 0 || cc >= n || !board[rr][cc]) open++;
          let v = 0;
          if (cnt >= 5) v = 1e6;
          else if (cnt === 4 && open === 2) v = 220000;
          else if (cnt === 4 && open === 1) v = 45000;
          else if (cnt === 3 && open === 2) v = 9000;
          else if (cnt === 3 && open === 1) v = 550;
          else if (cnt === 2 && open === 2) v = 220;
          else if (cnt === 2 && open === 1) v = 22;
          else v = cnt * 4;
          score += sign * v;
        }
        score += sign * (14 - (Math.abs(r - 7) + Math.abs(c - 7))) * 0.35;
      }
    }
    return score;
  }

  // --- VCF -----------------------------------------------------------------
  function findVCF(board, me, maxDepth, ctx) {
    return vcfRec(board, me, 0, maxDepth, ctx, 0);
  }

  function vcfRec(board, me, depth, maxDepth, ctx, hash) {
    if (timedOut(ctx) || depth > maxDepth) return null;
    const them = Core.opp(me);
    const cands = candidateList(board, 2);

    for (let i = 0; i < cands.length; i++) {
      const m = cands[i];
      if (Core.wouldWin(board, m.r, m.c, me)) return m;
    }

    const attacks = [];
    for (let i = 0; i < cands.length; i++) {
      if (timedOut(ctx)) break;
      const m = cands[i];
      board[m.r][m.c] = me;
      if (Core.findWin(board, m.r, m.c, me)) {
        board[m.r][m.c] = "";
        return m;
      }
      const myWins = listWinCells(board, me);
      const oppWins = listWinCells(board, them);
      board[m.r][m.c] = "";
      if (oppWins.length) continue;
      if (myWins.length >= 2) return m;
      if (myWins.length === 1) attacks.push({ m: m, block: myWins[0] });
    }

    attacks.sort((a, b) => {
      const da = Math.abs(a.m.r - 7) + Math.abs(a.m.c - 7);
      const db = Math.abs(b.m.r - 7) + Math.abs(b.m.c - 7);
      return da - db;
    });

    const cap = Math.min(attacks.length, depth === 0 ? 20 : 14);
    for (let i = 0; i < cap; i++) {
      if (timedOut(ctx)) break;
      const { m, block } = attacks[i];
      board[m.r][m.c] = me;
      board[block.r][block.c] = them;
      const cont = vcfRec(board, me, depth + 1, maxDepth, ctx, hash);
      board[block.r][block.c] = "";
      board[m.r][m.c] = "";
      if (cont) return m;
    }
    return null;
  }

  // --- VCT -----------------------------------------------------------------
  function findVCT(board, me, maxDepth, ctx) {
    return vctRec(board, me, 0, maxDepth, ctx);
  }

  function vctRec(board, me, depth, maxDepth, ctx) {
    if (timedOut(ctx) || depth > maxDepth) return null;
    const them = Core.opp(me);

    const vcf = findVCF(board, me, maxDepth - depth + 6, ctx);
    if (vcf) return vcf;

    const ranked = rankedCandidates(board, me, depth === 0 ? 32 : 22, ctx, null, null, 0);
    for (let i = 0; i < ranked.length; i++) {
      if (Core.wouldWin(board, ranked[i].r, ranked[i].c, me)) return ranked[i];
    }

    const attacks = [];
    for (let i = 0; i < ranked.length; i++) {
      if (timedOut(ctx)) break;
      const m = ranked[i];
      const sh = m.off || shapeAt(board, m.r, m.c, me);
      let prio = 0;
      if (sh.wins >= 2 || sh.live4 >= 1) prio = 1e9 + sh.score;
      else if (sh.wins >= 1) prio = 1e8 + sh.score;
      else if (sh.rush4 >= 1 && sh.live3 >= 1) prio = 5e7 + sh.score;
      else if (sh.live3 >= 2) prio = 4e7 + sh.score;
      else if (sh.rush4 >= 1 || sh.live3 >= 1) prio = sh.score;
      else continue;
      attacks.push({ m: m, prio: prio });
    }
    attacks.sort((a, b) => b.prio - a.prio);
    const limit = Math.min(attacks.length, depth === 0 ? 16 : depth <= 2 ? 12 : 8);

    for (let i = 0; i < limit; i++) {
      if (timedOut(ctx)) break;
      const m = attacks[i].m;
      board[m.r][m.c] = me;
      if (Core.findWin(board, m.r, m.c, me)) {
        board[m.r][m.c] = "";
        return m;
      }
      const oppWins = listWinCells(board, them);
      if (oppWins.length) {
        board[m.r][m.c] = "";
        continue;
      }
      const myWins = listWinCells(board, me);
      if (myWins.length >= 2) {
        board[m.r][m.c] = "";
        return m;
      }

      let replies;
      if (myWins.length === 1) {
        replies = [myWins[0]];
      } else {
        // defensive replies against live3 — top opponent shapes
        const defs = rankedCandidates(board, them, 5, ctx, null, null, 0);
        replies = defs.map((d) => ({ r: d.r, c: d.c }));
      }

      let allGood = replies.length > 0;
      for (let j = 0; j < replies.length; j++) {
        if (timedOut(ctx)) {
          allGood = false;
          break;
        }
        const d = replies[j];
        if (board[d.r][d.c]) continue;
        board[d.r][d.c] = them;
        if (Core.findWin(board, d.r, d.c, them)) {
          allGood = false;
          board[d.r][d.c] = "";
          break;
        }
        // after defense, also check if we still have VCF short-circuit
        const cont =
          findVCF(board, me, 8, ctx) || vctRec(board, me, depth + 1, maxDepth, ctx);
        board[d.r][d.c] = "";
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

  // --- α-β with TT ---------------------------------------------------------
  function negamax(board, depth, alpha, beta, side, root, ctx, ply, hash, killers, history) {
    if (timedOut(ctx)) return evaluateBoard(board, root);

    const alphaOrig = alpha;
    let ttMoveCode = -1;
    if (depth > 0) {
      const hit = ttProbe(hash, depth, alpha, beta);
      if (hit) {
        if (hit.score != null && !hit.onlyMove) return hit.score;
        if (hit.move >= 0) ttMoveCode = hit.move;
      }
    }

    if (depth === 0) return evaluateBoard(board, root);

    const ranked = rankedCandidates(
      board,
      side,
      depth >= 4 ? 12 : depth >= 2 ? 16 : 20,
      ctx,
      killers,
      history,
      ply
    );
    // TT move first
    if (ttMoveCode >= 0) {
      const tr = unpackR(ttMoveCode),
        tc = unpackC(ttMoveCode);
      const idx = ranked.findIndex((m) => m.r === tr && m.c === tc);
      if (idx > 0) {
        const tmp = ranked[idx];
        ranked.splice(idx, 1);
        ranked.unshift(tmp);
      } else if (idx < 0 && !board[tr][tc]) {
        ranked.unshift({ r: tr, c: tc, s: 1e15 });
      }
    }

    if (!ranked.length) return 0;

    let best = -Infinity;
    let bestCode = -1;
    for (let i = 0; i < ranked.length; i++) {
      if (timedOut(ctx)) break;
      const m = ranked[i];
      if (board[m.r][m.c]) continue;
      if (Core.wouldWin(board, m.r, m.c, side)) {
        const sc = 9000000 - ply;
        ttStore(hash, depth, TT_EXACT, sc, packMove(m.r, m.c));
        return sc;
      }
      board[m.r][m.c] = side;
      const h2 = hashXorPlace(hash, m.r, m.c, side) ^ zobrist[Z_SIDE];
      let val;
      if (Core.findWin(board, m.r, m.c, side)) {
        val = 9000000 - ply;
      } else {
        // PVS-ish: first full window, rest null window
        if (i === 0 || depth < 3) {
          val = -negamax(
            board,
            depth - 1,
            -beta,
            -alpha,
            Core.opp(side),
            root,
            ctx,
            ply + 1,
            h2,
            killers,
            history
          );
        } else {
          val = -negamax(
            board,
            depth - 1,
            -alpha - 1,
            -alpha,
            Core.opp(side),
            root,
            ctx,
            ply + 1,
            h2,
            killers,
            history
          );
          if (val > alpha && val < beta) {
            val = -negamax(
              board,
              depth - 1,
              -beta,
              -alpha,
              Core.opp(side),
              root,
              ctx,
              ply + 1,
              h2,
              killers,
              history
            );
          }
        }
      }
      board[m.r][m.c] = "";
      if (val > best) {
        best = val;
        bestCode = packMove(m.r, m.c);
      }
      if (val > alpha) alpha = val;
      if (alpha >= beta) {
        // killer / history
        if (killers && ply < killers[0].length) {
          if (killers[0][ply] !== bestCode) {
            killers[1][ply] = killers[0][ply];
            killers[0][ply] = bestCode;
          }
        }
        if (history && bestCode >= 0) history[bestCode] = (history[bestCode] || 0) + depth * depth;
        break;
      }
    }

    let flag = TT_EXACT;
    if (best <= alphaOrig) flag = TT_UPPER;
    else if (best >= beta) flag = TT_LOWER;
    ttStore(hash, depth, flag, best, bestCode);
    return best;
  }

  function searchRoot(board, me, maxDepth, ctx) {
    const them = Core.opp(me);
    const killers = [new Int16Array(64).fill(-1), new Int16Array(64).fill(-1)];
    const history = new Int32Array(16 * 16);
    let hash = hashBoard(board, me);
    const ranked = rankedCandidates(board, me, 24, ctx, killers, history, 0);
    let bestMove = ranked[0] ? { r: ranked[0].r, c: ranked[0].c } : null;
    let bestVal = -Infinity;

    for (let depth = 1; depth <= maxDepth; depth++) {
      if (timedOut(ctx)) break;
      // aspiration around previous score
      let alpha = -Infinity,
        beta = Infinity;
      if (depth >= 3 && bestVal > -1e8 && bestVal < 1e8) {
        const window = 800 + depth * 200;
        alpha = bestVal - window;
        beta = bestVal + window;
      }
      let iterBest = bestMove;
      let iterVal = -Infinity;
      // bring previous best to front
      if (bestMove) {
        const bi = ranked.findIndex((m) => m.r === bestMove.r && m.c === bestMove.c);
        if (bi > 0) {
          const t = ranked[bi];
          ranked.splice(bi, 1);
          ranked.unshift(t);
        }
      }
      for (let i = 0; i < ranked.length; i++) {
        if (timedOut(ctx)) break;
        const m = ranked[i];
        if (Core.wouldWin(board, m.r, m.c, me)) return { r: m.r, c: m.c };
        board[m.r][m.c] = me;
        const h2 = hashXorPlace(hash, m.r, m.c, me) ^ zobrist[Z_SIDE];
        let val;
        if (Core.findWin(board, m.r, m.c, me)) {
          val = 9000000;
        } else {
          val = -negamax(
            board,
            depth - 1,
            -beta,
            -alpha,
            them,
            me,
            ctx,
            1,
            h2,
            killers,
            history
          );
          // aspiration fail — re-search full window
          if ((val <= alpha || val >= beta) && !timedOut(ctx)) {
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
              history
            );
          }
        }
        board[m.r][m.c] = "";
        if (val > iterVal) {
          iterVal = val;
          iterBest = { r: m.r, c: m.c };
        }
        if (val > alpha) alpha = val;
      }
      if (iterBest) {
        bestMove = iterBest;
        bestVal = iterVal;
      }
      if (bestVal > 1000000) break;
    }
    return bestMove;
  }

  function randomPick(arr) {
    if (!arr || !arr.length) return null;
    return arr[Math.floor(Math.random() * arr.length)];
  }

  /**
   * timeMs budgets (defaults):
   *   easy: 0 | normal: 120 | hard: 700
   *   hard can pass timeMs 400/700/1200 via UI “思考”
   */
  function profileFor(difficulty, opts) {
    const hard = difficulty === "hard";
    const normal = difficulty === "normal";
    let budget;
    if (typeof opts.timeMs === "number") {
      budget = opts.timeMs;
    } else if (hard) {
      budget = opts.think === "fast" ? 400 : opts.think === "deep" ? 1200 : 700;
    } else if (normal) {
      budget = 120;
    } else {
      budget = 0;
    }
    return {
      difficulty: difficulty,
      budgetMs: budget,
      vcfDepth: hard ? 18 : normal ? 10 : 0,
      vctDepth: hard ? 10 : normal ? 4 : 0,
      abDepth: hard ? 7 : normal ? 4 : 1,
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
    const t0 = nowMs();
    const ctx = { deadline: prof.budgetMs > 0 ? t0 + prof.budgetMs : 0 };
    ttClear();

    if (!hasAny(board)) {
      if (difficulty === "easy") {
        return randomPick([
          { r: 7, c: 7 },
          { r: 6, c: 6 },
          { r: 6, c: 8 },
          { r: 8, c: 6 },
          { r: 8, c: 8 },
          { r: 7, c: 6 },
          { r: 7, c: 8 },
        ]);
      }
      return { r: 7, c: 7 };
    }

    const cands = candidateList(board, 2);

    // 1) Win
    for (let i = 0; i < cands.length; i++) {
      if (Core.wouldWin(board, cands[i].r, cands[i].c, me)) return cands[i];
    }
    // 2) Block win
    for (let i = 0; i < cands.length; i++) {
      if (Core.wouldWin(board, cands[i].r, cands[i].c, them)) return cands[i];
    }

    if (difficulty === "easy") {
      const ranked = rankedCandidates(board, me, 10, null, null, null, 0);
      const pool = ranked.slice(0, Math.min(6, ranked.length));
      if (Math.random() < 0.5 && pool.length > 1) return randomPick(pool.slice(1)) || pool[0];
      return randomPick(pool.slice(0, 3)) || pool[0] || cands[0];
    }

    // 3) Own VCF
    if (prof.vcfDepth > 0) {
      const vcf = findVCF(board, me, prof.vcfDepth, ctx);
      if (vcf) return vcf;
    }

    // 4) Deny opponent VCF
    if (prof.vcfDepth > 0 && !timedOut(ctx)) {
      const theirVcf = findVCF(board, them, Math.min(14, prof.vcfDepth), ctx);
      if (theirVcf) {
        const defenses = rankedCandidates(board, me, 24, ctx, null, null, 0);
        let fallback = { r: theirVcf.r, c: theirVcf.c };
        for (let i = 0; i < defenses.length; i++) {
          if (timedOut(ctx)) break;
          const d = defenses[i];
          if (Core.wouldWin(board, d.r, d.c, me)) return { r: d.r, c: d.c };
          board[d.r][d.c] = me;
          if (Core.findWin(board, d.r, d.c, me)) {
            board[d.r][d.c] = "";
            return { r: d.r, c: d.c };
          }
          const ow = listWinCells(board, them);
          let still = null;
          if (!ow.length) still = findVCF(board, them, Math.min(12, prof.vcfDepth), ctx);
          board[d.r][d.c] = "";
          if (!ow.length && !still) return { r: d.r, c: d.c };
        }
        if (!board[fallback.r][fallback.c]) return fallback;
      }
    }

    // 5) Block one-move dual threat
    {
      const rankedDef = rankedCandidates(board, them, 20, ctx, null, null, 0);
      for (let i = 0; i < rankedDef.length; i++) {
        if (timedOut(ctx)) break;
        const m = rankedDef[i];
        board[m.r][m.c] = them;
        const w = listWinCells(board, them).length;
        board[m.r][m.c] = "";
        if (w >= 2) return { r: m.r, c: m.c };
      }
    }

    // 6) VCT
    if (prof.useVct && prof.vctDepth > 0 && !timedOut(ctx)) {
      const vct = findVCT(board, me, prof.vctDepth, ctx);
      if (vct) return vct;
    }

    // 7) Create dual threat
    {
      const ranked = rankedCandidates(board, me, 28, ctx, null, null, 0);
      for (let i = 0; i < ranked.length; i++) {
        if (timedOut(ctx)) break;
        const m = ranked[i];
        board[m.r][m.c] = me;
        const w = listWinCells(board, me).length;
        board[m.r][m.c] = "";
        if (w >= 2) return { r: m.r, c: m.c };
      }
    }

    // 8) Iterative α-β + TT
    const move = searchRoot(board, me, prof.abDepth, ctx);
    if (move) return move;

    const fallback = rankedCandidates(board, me, 5, null, null, null, 0);
    return fallback[0] ? { r: fallback[0].r, c: fallback[0].c } : cands[0] || null;
  }

  function hintMove(opts) {
    return aiMove({
      board: opts.board,
      side: opts.side,
      humanColor: opts.humanColor,
      difficulty: opts.difficulty === "easy" ? "normal" : opts.difficulty || "hard",
      timeMs: typeof opts.timeMs === "number" ? opts.timeMs : 500,
      think: opts.think,
    });
  }

  function candidateMoves(board, maxN, nearDist, sideToMove) {
    const me = sideToMove || "b";
    const ranked = rankedCandidates(board, me, maxN || 40, null, null, null, 0);
    return ranked.map((m) => ({ r: m.r, c: m.c }));
  }

  global.GobanAi = {
    aiMove: aiMove,
    hintMove: hintMove,
    candidateMoves: candidateMoves,
    evaluateBoard: evaluateBoard,
    cloneBoard: cloneBoard,
    listWinCells: listWinCells,
    findVCF: findVCF,
    findVCT: findVCT,
    shapeAt: shapeAt,
    /** think: 'fast' | 'normal' | 'deep' maps hard budgets */
    profileFor: profileFor,
  };
})(typeof window !== "undefined" ? window : globalThis);
