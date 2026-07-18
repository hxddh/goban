/**
 * C1 engine: pattern threats + VCF/VCT + iterative α-β.
 * Freestyle 15×15. Mutates only board copies.
 * @module ai
 */
(function (global) {
  const Core = global.GobanCore;
  const SIZE = () => Core.SIZE;
  const DIRS = [
    [0, 1],
    [1, 0],
    [1, 1],
    [1, -1],
  ];

  function cloneBoard(board) {
    const n = SIZE();
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

  /** All empty cells where `color` wins immediately. */
  function listWinCells(board, color) {
    const n = SIZE();
    const list = [];
    for (let r = 0; r < n; r++) {
      for (let c = 0; c < n; c++) {
        if (board[r][c]) continue;
        if (Core.wouldWin(board, r, c, color)) list.push({ r, c });
      }
    }
    return list;
  }

  function nearStone(board, r, c, dist) {
    const d = dist || 2;
    const n = SIZE();
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
    const n = SIZE();
    for (let r = 0; r < n; r++)
      for (let c = 0; c < n; c++) if (board[r][c]) return true;
    return false;
  }

  /**
   * Scan one direction through (r,c) after placing `color`.
   * Returns consecutive count including center and open ends (0–2).
   */
  function lineRun(board, r, c, dr, dc, color) {
    const n = SIZE();
    let cnt = 1;
    let rr = r + dr,
      cc = c + dc;
    while (rr >= 0 && rr < n && cc >= 0 && cc < n && board[rr][cc] === color) {
      cnt++;
      rr += dr;
      cc += dc;
    }
    const end1Open =
      rr >= 0 && rr < n && cc >= 0 && cc < n && !board[rr][cc] ? 1 : 0;

    rr = r - dr;
    cc = c - dc;
    while (rr >= 0 && rr < n && cc >= 0 && cc < n && board[rr][cc] === color) {
      cnt++;
      rr -= dr;
      cc -= dc;
    }
    const end2Open =
      rr >= 0 && rr < n && cc >= 0 && cc < n && !board[rr][cc] ? 1 : 0;

    return { cnt: cnt, open: end1Open + end2Open };
  }

  /**
   * Shape score for a hypothetical place at (r,c) for color.
   * Also counts how many win-cells that place creates.
   */
  function shapeAt(board, r, c, color) {
    if (board[r][c]) return { score: -1e15, wins: 0, live4: 0, rush4: 0, live3: 0 };
    if (Core.wouldWin(board, r, c, color)) {
      return { score: 1e12, wins: 1, live4: 0, rush4: 0, live3: 0 };
    }
    board[r][c] = color;
    let score = 0;
    let live4 = 0,
      rush4 = 0,
      live3 = 0,
      sleep3 = 0,
      live2 = 0;
    for (const [dr, dc] of DIRS) {
      const { cnt, open } = lineRun(board, r, c, dr, dc, color);
      if (cnt >= 5) score += 1e12;
      else if (cnt === 4 && open === 2) {
        live4++;
        score += 500000;
      } else if (cnt === 4 && open === 1) {
        rush4++;
        score += 80000;
      } else if (cnt === 3 && open === 2) {
        live3++;
        score += 12000;
      } else if (cnt === 3 && open === 1) {
        sleep3++;
        score += 800;
      } else if (cnt === 2 && open === 2) {
        live2++;
        score += 400;
      } else if (cnt === 2 && open === 1) score += 40;
      else score += cnt * 6;
    }
    // Dual-threat style: multiple independent fours/threes
    if (live4 >= 1 || rush4 >= 2) score += 400000;
    if (live3 >= 2) score += 200000;
    if (live3 >= 1 && rush4 >= 1) score += 250000;

    const wins = listWinCells(board, color).length;
    board[r][c] = "";
    score += wins * 150000;
    // center bias
    score += (14 - (Math.abs(r - 7) + Math.abs(c - 7))) * 3;
    return { score: score, wins: wins, live4: live4, rush4: rush4, live3: live3, sleep3: sleep3, live2: live2 };
  }

  function candidateList(board, nearDist) {
    const n = SIZE();
    if (!hasAny(board)) return [{ r: 7, c: 7 }];
    const list = [];
    const d = nearDist || 2;
    for (let r = 0; r < n; r++) {
      for (let c = 0; c < n; c++) {
        if (board[r][c]) continue;
        if (!nearStone(board, r, c, d)) continue;
        list.push({ r, c });
      }
    }
    if (!list.length) {
      for (let r = 0; r < n; r++)
        for (let c = 0; c < n; c++) if (!board[r][c]) list.push({ r, c });
    }
    return list;
  }

  /** Ranked candidates for side to move (offense + defense). */
  function rankedCandidates(board, me, maxN, ctx) {
    const them = Core.opp(me);
    const raw = candidateList(board, 2);
    const scored = [];
    for (let i = 0; i < raw.length; i++) {
      if (timedOut(ctx)) break;
      const m = raw[i];
      const off = shapeAt(board, m.r, m.c, me);
      const def = shapeAt(board, m.r, m.c, them);
      // Prefer our wins, then block their wins, then our shapes, then deny their shapes
      let s = off.score + def.score * 0.95;
      if (Core.wouldWin(board, m.r, m.c, me)) s = 1e14;
      else if (Core.wouldWin(board, m.r, m.c, them)) s = 1e13 + def.score;
      scored.push({ r: m.r, c: m.c, s: s, off: off, def: def });
    }
    scored.sort((a, b) => b.s - a.s);
    return scored.slice(0, maxN || scored.length);
  }

  function evaluateBoard(board, me) {
    const them = Core.opp(me);
    const n = SIZE();
    let score = 0;
    // Sample evaluate by best place potential is expensive; use stone-centric shapes
    for (let r = 0; r < n; r++) {
      for (let c = 0; c < n; c++) {
        if (!board[r][c]) continue;
        const color = board[r][c];
        const sign = color === me ? 1 : -1.15;
        for (const [dr, dc] of DIRS) {
          // only start of a run
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
          if (cnt >= 5) v = 1000000;
          else if (cnt === 4 && open === 2) v = 200000;
          else if (cnt === 4 && open === 1) v = 40000;
          else if (cnt === 3 && open === 2) v = 8000;
          else if (cnt === 3 && open === 1) v = 500;
          else if (cnt === 2 && open === 2) v = 200;
          else if (cnt === 2 && open === 1) v = 20;
          else v = cnt * 4;
          score += sign * v;
        }
        score += sign * (14 - (Math.abs(r - 7) + Math.abs(c - 7))) * 0.3;
      }
    }
    return score;
  }

  /**
   * VCF: win by continuous fours (forced single replies).
   * Returns a move for `me` or null.
   */
  function findVCF(board, me, maxDepth, ctx) {
    return vcfRec(board, me, 0, maxDepth, ctx);
  }

  function vcfRec(board, me, depth, maxDepth, ctx) {
    if (timedOut(ctx) || depth > maxDepth) return null;
    const them = Core.opp(me);
    const cands = candidateList(board, 2);

    // Immediate win
    for (let i = 0; i < cands.length; i++) {
      const m = cands[i];
      if (Core.wouldWin(board, m.r, m.c, me)) return m;
    }

    // Build attacking fours: place creates ≥1 win-cell for me
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
      // Opponent would win on their turn if they have a win and we didn't force
      if (oppWins.length && myWins.length === 0) continue;
      if (oppWins.length && myWins.length > 0) {
        // Opponent can take their win instead of blocking — only OK if our move was also winning (handled above)
        // If they have any win cell, they win before our VCF continues
        continue;
      }
      if (myWins.length >= 2) {
        // double threat: cannot block both
        return m;
      }
      if (myWins.length === 1) {
        attacks.push({ m: m, block: myWins[0] });
      }
    }

    // Order attacks near center / stable
    attacks.sort((a, b) => {
      const da = Math.abs(a.m.r - 7) + Math.abs(a.m.c - 7);
      const db = Math.abs(b.m.r - 7) + Math.abs(b.m.c - 7);
      return da - db;
    });

    for (let i = 0; i < attacks.length; i++) {
      if (timedOut(ctx)) break;
      const { m, block } = attacks[i];
      board[m.r][m.c] = me;
      board[block.r][block.c] = them;
      // After forced block, continue VCF
      const cont = vcfRec(board, me, depth + 1, maxDepth, ctx);
      board[block.r][block.c] = "";
      board[m.r][m.c] = "";
      if (cont) return m;
    }
    return null;
  }

  /**
   * Shallow VCT: include live-three style attacks (create rush4/live3 duals).
   * Defender answers the highest threat set.
   */
  function findVCT(board, me, maxDepth, ctx) {
    return vctRec(board, me, 0, maxDepth, ctx);
  }

  function vctRec(board, me, depth, maxDepth, ctx) {
    if (timedOut(ctx) || depth > maxDepth) return null;
    const them = Core.opp(me);

    const vcf = findVCF(board, me, maxDepth - depth + 4, ctx);
    if (vcf) return vcf;

    const ranked = rankedCandidates(board, me, 28, ctx);
    // Immediate
    for (let i = 0; i < ranked.length; i++) {
      const m = ranked[i];
      if (Core.wouldWin(board, m.r, m.c, me)) return m;
    }

    // Attack moves: create wins≥1 or live3/live4 pressure
    const attacks = [];
    for (let i = 0; i < ranked.length; i++) {
      if (timedOut(ctx)) break;
      const m = ranked[i];
      const sh = shapeAt(board, m.r, m.c, me);
      if (sh.wins >= 2 || sh.live4 >= 1) {
        attacks.push({ m: m, prio: 1000 + sh.score });
        continue;
      }
      if (sh.wins >= 1 || sh.rush4 >= 1 || sh.live3 >= 1 || sh.live3 + sh.rush4 >= 1) {
        attacks.push({ m: m, prio: sh.score });
      }
    }
    attacks.sort((a, b) => b.prio - a.prio);
    const limit = Math.min(attacks.length, depth === 0 ? 14 : 10);

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
        continue; // illegal: leaves opponent win-in-1
      }
      const myWins = listWinCells(board, me);
      if (myWins.length >= 2) {
        board[m.r][m.c] = "";
        return m;
      }

      // Defender replies: block all win cells, else best defensive candidate
      let replies = myWins.slice();
      if (!replies.length) {
        // block our live3 expansion: top defensive shapes for them
        const defs = rankedCandidates(board, them, 6, ctx);
        replies = defs.map((d) => ({ r: d.r, c: d.c }));
      }
      // Must survive all replies (AND): if for every reply we still have VCT, move wins
      let allGood = replies.length > 0;
      for (let j = 0; j < replies.length; j++) {
        if (timedOut(ctx)) {
          allGood = false;
          break;
        }
        const d = replies[j];
        if (board[d.r][d.c]) continue;
        board[d.r][d.c] = them;
        // if defender wins by this place
        if (Core.findWin(board, d.r, d.c, them)) {
          allGood = false;
          board[d.r][d.c] = "";
          break;
        }
        const cont = vctRec(board, me, depth + 1, maxDepth, ctx);
        board[d.r][d.c] = "";
        if (!cont) {
          allGood = false;
          break;
        }
      }
      board[m.r][m.c] = "";
      if (allGood && replies.length) return m;
    }
    return null;
  }

  function negamax(board, depth, alpha, beta, side, root, ctx, ply) {
    if (timedOut(ctx)) return evaluateBoard(board, root);
    if (depth === 0) return evaluateBoard(board, root);

    const ranked = rankedCandidates(board, side, depth >= 3 ? 14 : 18, ctx);
    if (!ranked.length) return 0;

    let best = -Infinity;
    for (let i = 0; i < ranked.length; i++) {
      if (timedOut(ctx)) break;
      const m = ranked[i];
      if (Core.wouldWin(board, m.r, m.c, side)) return 9000000 - ply;
      board[m.r][m.c] = side;
      let val;
      if (Core.findWin(board, m.r, m.c, side)) {
        val = 9000000 - ply;
      } else {
        val = -negamax(board, depth - 1, -beta, -alpha, Core.opp(side), root, ctx, ply + 1);
      }
      board[m.r][m.c] = "";
      if (val > best) best = val;
      if (val > alpha) alpha = val;
      if (alpha >= beta) break;
    }
    return best;
  }

  function searchRoot(board, me, maxDepth, ctx) {
    const them = Core.opp(me);
    const ranked = rankedCandidates(board, me, 22, ctx);
    let bestMove = ranked[0] ? { r: ranked[0].r, c: ranked[0].c } : null;
    let bestVal = -Infinity;

    for (let depth = 1; depth <= maxDepth; depth++) {
      if (timedOut(ctx)) break;
      let iterBest = bestMove;
      let iterVal = -Infinity;
      for (let i = 0; i < ranked.length; i++) {
        if (timedOut(ctx)) break;
        const m = ranked[i];
        if (Core.wouldWin(board, m.r, m.c, me)) return { r: m.r, c: m.c };
        board[m.r][m.c] = me;
        let val;
        if (Core.findWin(board, m.r, m.c, me)) {
          val = 9000000;
        } else {
          val = -negamax(board, depth - 1, -Infinity, Infinity, them, me, ctx, 1);
        }
        board[m.r][m.c] = "";
        if (val > iterVal) {
          iterVal = val;
          iterBest = { r: m.r, c: m.c };
        }
      }
      if (iterBest) {
        bestMove = iterBest;
        bestVal = iterVal;
      }
      if (bestVal > 1000000) break; // found forced-ish win
    }
    return bestMove;
  }

  function randomPick(arr) {
    if (!arr || !arr.length) return null;
    return arr[Math.floor(Math.random() * arr.length)];
  }

  function profileFor(difficulty, opts) {
    const hard = difficulty === "hard";
    const normal = difficulty === "normal";
    const budget =
      typeof opts.timeMs === "number"
        ? opts.timeMs
        : hard
          ? 450
          : normal
            ? 100
            : 0;
    return {
      difficulty: difficulty,
      budgetMs: budget,
      vcfDepth: hard ? 14 : normal ? 8 : 0,
      vctDepth: hard ? 6 : normal ? 3 : 0,
      abDepth: hard ? 5 : normal ? 3 : 1,
      useVct: hard || normal,
    };
  }

  /**
   * @param {object} opts
   * @param {string[][]} opts.board
   * @param {string} [opts.humanColor]
   * @param {string} [opts.side]
   * @param {string} [opts.difficulty]
   * @param {number} [opts.timeMs] search budget
   */
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

    // 1) Immediate win
    for (let i = 0; i < cands.length; i++) {
      if (Core.wouldWin(board, cands[i].r, cands[i].c, me)) return cands[i];
    }
    // 2) Block opponent win
    for (let i = 0; i < cands.length; i++) {
      if (Core.wouldWin(board, cands[i].r, cands[i].c, them)) return cands[i];
    }

    if (difficulty === "easy") {
      const ranked = rankedCandidates(board, me, 10, null);
      const pool = ranked.slice(0, Math.min(6, ranked.length));
      if (Math.random() < 0.5 && pool.length > 1) {
        return randomPick(pool.slice(1)) || pool[0];
      }
      return randomPick(pool.slice(0, 3)) || pool[0] || cands[0];
    }

    // 3) VCF
    if (prof.vcfDepth > 0) {
      const vcf = findVCF(board, me, prof.vcfDepth, ctx);
      if (vcf) return vcf;
    }

    // 4) Deny opponent VCF: find a move after which they have no VCF
    if (prof.vcfDepth > 0 && !timedOut(ctx)) {
      const theirVcf = findVCF(board, them, Math.min(12, prof.vcfDepth), ctx);
      if (theirVcf) {
        const defenses = rankedCandidates(board, me, 22, ctx);
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
          // opponent must not already have win-in-1 after our move
          const ow = listWinCells(board, them);
          let still = null;
          if (!ow.length) {
            still = findVCF(board, them, Math.min(10, prof.vcfDepth), ctx);
          }
          board[d.r][d.c] = "";
          if (!ow.length && !still) return { r: d.r, c: d.c };
        }
        if (!board[fallback.r][fallback.c]) return fallback;
      }
    }

    // 5) Prevent opponent one-move dual threat (two win-cells)
    {
      const rankedDef = rankedCandidates(board, them, 18, ctx);
      for (let i = 0; i < rankedDef.length; i++) {
        if (timedOut(ctx)) break;
        const m = rankedDef[i];
        board[m.r][m.c] = them;
        const w = listWinCells(board, them).length;
        board[m.r][m.c] = "";
        if (w >= 2) return { r: m.r, c: m.c };
      }
    }

    // 6) VCT (hard/normal)
    if (prof.useVct && prof.vctDepth > 0 && !timedOut(ctx)) {
      const vct = findVCT(board, me, prof.vctDepth, ctx);
      if (vct) return vct;
    }

    // 7) Create dual threat if available in 1 move
    {
      const ranked = rankedCandidates(board, me, 24, ctx);
      for (let i = 0; i < ranked.length; i++) {
        const m = ranked[i];
        board[m.r][m.c] = me;
        const w = listWinCells(board, me).length;
        board[m.r][m.c] = "";
        if (w >= 2) return { r: m.r, c: m.c };
      }
    }

    // 8) Iterative α-β
    const move = searchRoot(board, me, prof.abDepth, ctx);
    if (move) return move;

    const fallback = rankedCandidates(board, me, 5, null);
    return fallback[0] ? { r: fallback[0].r, c: fallback[0].c } : cands[0] || null;
  }

  function hintMove(opts) {
    return aiMove({
      board: opts.board,
      side: opts.side,
      humanColor: opts.humanColor,
      difficulty: opts.difficulty === "easy" ? "normal" : opts.difficulty || "hard",
      timeMs: typeof opts.timeMs === "number" ? opts.timeMs : 300,
    });
  }

  // Backward-compatible exports used by tests
  function candidateMoves(board, maxN, nearDist, sideToMove) {
    const me = sideToMove || "b";
    const ranked = rankedCandidates(board, me, maxN || 40, null);
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
  };
})(typeof window !== "undefined" ? window : globalThis);
