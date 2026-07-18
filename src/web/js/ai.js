/**
 * Heuristic + shallow α-β AI. Mutates board in place during search; restores.
 * @module ai
 */
(function (global) {
  const Core = global.GobanCore;

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
          if (rr < 0 || rr >= SIZE || cc < 0 || cc >= SIZE || !board[rr][cc]) open++;
          if (n >= 5) score += 100000;
          else if (n === 4 && open === 2) score += 20000;
          else if (n === 4 && open === 1) score += 5000;
          else if (n === 3 && open === 2) score += 2000;
          else if (n === 3 && open === 1) score += 200;
          else if (n === 2 && open === 2) score += 80;
          else if (n === 2 && open === 1) score += 15;
          else score += n * 3;
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
    return shapeScoreFor(board, me) - shapeScoreFor(board, them) * 1.05 + center * 0.5;
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
    if (Core.wouldWin(board, r, c, them)) return 5e5;
    board[r][c] = me;
    const s = evaluateBoard(board, me);
    board[r][c] = "";
    return s;
  }

  /** Order by the side about to move (fixes AI-only sort bias). */
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

  function negamax(board, depth, alpha, beta, side, root) {
    if (depth === 0) return evaluateBoard(board, root);
    const moves = candidateMoves(board, depth >= 2 ? 14 : 18, 2, side);
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
        val = -negamax(board, depth - 1, -beta, -alpha, Core.opp(side), root);
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
   * @param {string} opts.humanColor
   * @param {string} opts.difficulty easy|normal|hard
   */
  function aiMove(opts) {
    const board = opts.board;
    const humanColor = opts.humanColor;
    const difficulty = opts.difficulty || "normal";
    const me = Core.opp(humanColor);
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
        const p = randomPick(opts0.map(([r, c]) => ({ r, c })));
        return p;
      }
      return { r: 7, c: 7 };
    }

    const cands = candidateMoves(board, 40, 2, me);
    for (const m of cands) {
      if (Core.wouldWin(board, m.r, m.c, me)) return m;
    }
    for (const m of cands) {
      if (Core.wouldWin(board, m.r, m.c, humanColor)) return m;
    }

    if (difficulty === "easy") {
      const scored = cands.map((m) => ({ ...m, s: scorePlace(board, m.r, m.c, me) }));
      scored.sort((a, b) => b.s - a.s);
      const pool = scored.slice(0, Math.min(8, scored.length));
      if (Math.random() < 0.4 && pool.length > 1) {
        return pool[1 + Math.floor(Math.random() * (pool.length - 1))];
      }
      return randomPick(pool.slice(0, 3)) || pool[0];
    }

    const depth = difficulty === "hard" ? 2 : 1;
    const top = candidateMoves(board, difficulty === "hard" ? 16 : 20, 2, me);
    let bestMove = top[0];
    let bestVal = -Infinity;
    for (const m of top) {
      if (Core.wouldWin(board, m.r, m.c, me)) return m;
      board[m.r][m.c] = me;
      let val;
      if (Core.findWin(board, m.r, m.c, me)) {
        val = 1e6;
      } else {
        val = -negamax(board, depth - 1, -Infinity, Infinity, Core.opp(me), me);
      }
      board[m.r][m.c] = "";
      if (difficulty === "normal") val += (Math.random() - 0.5) * 30;
      if (val > bestVal) {
        bestVal = val;
        bestMove = m;
      }
    }
    return bestMove || top[0] || null;
  }

  global.GobanAi = { aiMove, candidateMoves, evaluateBoard };
})(typeof window !== "undefined" ? window : globalThis);
