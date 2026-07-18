/**
 * Heuristic + α-β AI. Mutates a board copy during search (never caller's board).
 * @module ai
 */
(function (global) {
  const Core = global.GobanCore;

  function cloneBoard(board) {
    const SIZE = Core.SIZE;
    const out = [];
    for (let r = 0; r < SIZE; r++) out.push(board[r].slice());
    return out;
  }

  function shapeScoreFor(board, color) {
    let score = 0;
    const SIZE = Core.SIZE;
    const dirs = [
      [0, 1],
      [1, 0],
      [1, 1],
      [1, -1],
    ];
    for (let r = 0; r < SIZE; r++) {
      for (let c = 0; c < SIZE; c++) {
        if (board[r][c] !== color) continue;
        for (const [dr, dc] of dirs) {
          const pr = r - dr,
            pc = c - dc;
          if (pr >= 0 && pr < SIZE && pc >= 0 && pc < SIZE && board[pr][pc] === color) continue;
          let n = 0;
          let rr = r,
            cc = c;
          while (rr >= 0 && rr < SIZE && cc >= 0 && cc < SIZE && board[rr][cc] === color) {
            n++;
            rr += dr;
            cc += dc;
          }
          let open = 0;
          const br = r - dr,
            bc = c - dc;
          if (br < 0 || br >= SIZE || bc < 0 || bc >= SIZE || !board[br][bc]) open++;
          if (rr < 0 || rr >= SIZE || cc >= SIZE || cc < 0 || !board[rr][cc]) open++;
          if (n >= 5) score += 100000;
          else if (n === 4 && open === 2) score += 50000;
          else if (n === 4 && open === 1) score += 12000;
          else if (n === 3 && open === 2) score += 4000;
          else if (n === 3 && open === 1) score += 350;
          else if (n === 2 && open === 2) score += 120;
          else if (n === 2 && open === 1) score += 20;
          else score += n * 4;
        }
      }
    }
    return score;
  }

  function evaluateBoard(board, me) {
    const them = Core.opp(me);
    const SIZE = Core.SIZE;
    let center = 0;
    for (let r = 0; r < SIZE; r++)
      for (let c = 0; c < SIZE; c++) {
        if (!board[r][c]) continue;
        const w = 14 - (Math.abs(r - 7) + Math.abs(c - 7));
        center += board[r][c] === me ? w : -w;
      }
    // Slightly overweight defense so blocks are preferred when close
    return shapeScoreFor(board, me) - shapeScoreFor(board, them) * 1.12 + center * 0.45;
  }

  function nearStone(board, r, c, dist) {
    const d = dist || 2;
    const SIZE = Core.SIZE;
    for (let dr = -d; dr <= d; dr++)
      for (let dc = -d; dc <= d; dc++) {
        if (!dr && !dc) continue;
        const rr = r + dr,
          cc = c + dc;
        if (rr >= 0 && rr < SIZE && cc >= 0 && cc < SIZE && board[rr][cc]) return true;
      }
    return false;
  }

  function scorePlace(board, r, c, me) {
    if (board[r][c]) return -1e9;
    const them = Core.opp(me);
    if (Core.wouldWin(board, r, c, me)) return 1e6;
    if (Core.wouldWin(board, r, c, them)) return 8e5;
    board[r][c] = me;
    // Count how many immediate threats we create (next-move wins for me)
    let threats = 0;
    const SIZE = Core.SIZE;
    for (let rr = 0; rr < SIZE; rr++) {
      for (let cc = 0; cc < SIZE; cc++) {
        if (board[rr][cc]) continue;
        if (Core.wouldWin(board, rr, cc, me)) threats++;
      }
    }
    const s = evaluateBoard(board, me) + threats * 8000;
    board[r][c] = "";
    return s;
  }

  /** Order by the side about to move. */
  function candidateMoves(board, maxN, nearDist, sideToMove) {
    const SIZE = Core.SIZE;
    let has = false;
    for (let r = 0; r < SIZE; r++)
      for (let c = 0; c < SIZE; c++) if (board[r][c]) has = true;
    if (!has) return [{ r: 7, c: 7 }];

    const list = [];
    for (let r = 0; r < SIZE; r++) {
      for (let c = 0; c < SIZE; c++) {
        if (board[r][c]) continue;
        if (!nearStone(board, r, c, nearDist)) continue;
        list.push({ r, c });
      }
    }
    if (!list.length) {
      for (let r = 0; r < SIZE; r++)
        for (let c = 0; c < SIZE; c++) if (!board[r][c]) list.push({ r, c });
    }
    const me = sideToMove || "b";
    list.sort((a, b) => scorePlace(board, b.r, b.c, me) - scorePlace(board, a.r, a.c, me));
    return list.slice(0, maxN || list.length);
  }

  function randomPick(candidates) {
    if (!candidates.length) return null;
    return candidates[Math.floor(Math.random() * candidates.length)];
  }

  function negamax(board, depth, alpha, beta, side, root, hard) {
    if (depth === 0) return evaluateBoard(board, root);
    const branch = hard ? (depth >= 2 ? 12 : 16) : depth >= 2 ? 14 : 18;
    const moves = candidateMoves(board, branch, 2, side);
    if (!moves.length) return 0;
    let best = -Infinity;
    for (const m of moves) {
      if (board[m.r][m.c]) continue;
      if (Core.wouldWin(board, m.r, m.c, side)) return 900000 + depth;
      board[m.r][m.c] = side;
      let val;
      if (Core.findWin(board, m.r, m.c, side)) {
        val = 900000 + depth;
      } else {
        val = -negamax(board, depth - 1, -beta, -alpha, Core.opp(side), root, hard);
      }
      board[m.r][m.c] = "";
      if (val > best) best = val;
      if (val > alpha) alpha = val;
      if (alpha >= beta) break;
    }
    return best;
  }

  /**
   * @param {object} opts
   * @param {string[][]} opts.board
   * @param {string} [opts.humanColor] used if side omitted (AI plays opp)
   * @param {string} [opts.side] side to move ('b'|'w')
   * @param {string} [opts.difficulty] easy|normal|hard
   * @returns {{r:number,c:number}|null}
   */
  function aiMove(opts) {
    const board = cloneBoard(opts.board);
    const difficulty = opts.difficulty || "normal";
    const me =
      opts.side === "b" || opts.side === "w"
        ? opts.side
        : Core.opp(opts.humanColor || "b");
    const them = Core.opp(me);
    const SIZE = Core.SIZE;
    let any = false;
    for (let r = 0; r < SIZE; r++)
      for (let c = 0; c < SIZE; c++) if (board[r][c]) any = true;

    if (!any) {
      if (difficulty === "easy") {
        const opts0 = [
          [7, 7],
          [6, 6],
          [6, 8],
          [8, 6],
          [8, 8],
          [7, 6],
          [7, 8],
        ];
        return randomPick(opts0.map(([r, c]) => ({ r, c })));
      }
      return { r: 7, c: 7 };
    }

    const cands = candidateMoves(board, 48, 2, me);
    // Immediate win
    for (const m of cands) {
      if (Core.wouldWin(board, m.r, m.c, me)) return m;
    }
    // Block opponent win
    for (const m of cands) {
      if (Core.wouldWin(board, m.r, m.c, them)) return m;
    }

    if (difficulty === "easy") {
      const scored = cands.map((m) => ({ ...m, s: scorePlace(board, m.r, m.c, me) }));
      scored.sort((a, b) => b.s - a.s);
      const pool = scored.slice(0, Math.min(8, scored.length));
      if (Math.random() < 0.45 && pool.length > 1) {
        return pool[1 + Math.floor(Math.random() * (pool.length - 1))];
      }
      return randomPick(pool.slice(0, 3)) || pool[0];
    }

    // Prefer creating dual threats (forks) before deep search
    if (difficulty === "hard") {
      let bestFork = null;
      let bestForkN = 1;
      for (const m of cands.slice(0, 24)) {
        board[m.r][m.c] = me;
        let n = 0;
        for (let r = 0; r < SIZE; r++)
          for (let c = 0; c < SIZE; c++) {
            if (board[r][c]) continue;
            if (Core.wouldWin(board, r, c, me)) n++;
          }
        board[m.r][m.c] = "";
        if (n >= 2 && n > bestForkN) {
          bestForkN = n;
          bestFork = m;
        }
      }
      if (bestFork) return bestFork;
    }

    const hard = difficulty === "hard";
    const depth = hard ? 3 : 1;
    const topN = hard ? 18 : 20;
    const top = candidateMoves(board, topN, 2, me);
    let bestMove = top[0];
    let bestVal = -Infinity;
    for (const m of top) {
      if (Core.wouldWin(board, m.r, m.c, me)) return m;
      board[m.r][m.c] = me;
      let val;
      if (Core.findWin(board, m.r, m.c, me)) {
        val = 1e6;
      } else {
        val = -negamax(board, depth - 1, -Infinity, Infinity, them, me, hard);
      }
      board[m.r][m.c] = "";
      if (difficulty === "normal") val += (Math.random() - 0.5) * 40;
      if (val > bestVal) {
        bestVal = val;
        bestMove = m;
      }
    }
    return bestMove || top[0] || null;
  }

  /** Hint for the side to move (does not place). */
  function hintMove(opts) {
    return aiMove({
      board: opts.board,
      side: opts.side,
      humanColor: opts.humanColor,
      difficulty: opts.difficulty === "easy" ? "normal" : opts.difficulty || "normal",
    });
  }

  global.GobanAi = {
    aiMove,
    hintMove,
    candidateMoves,
    evaluateBoard,
    cloneBoard,
  };
})(typeof window !== "undefined" ? window : globalThis);
