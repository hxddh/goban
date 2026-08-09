/**
 * Pure gomoku rules & board helpers (no DOM).
 * @module core
 */
(function (global) {
  const SIZE = 15;
  const WIN = 5;
  const DIRS = [
    [0, 1],
    [1, 0],
    [1, 1],
    [1, -1],
  ];

  function emptyBoard() {
    const b = [];
    for (let r = 0; r < SIZE; r++) {
      const row = [];
      for (let c = 0; c < SIZE; c++) row.push("");
      b.push(row);
    }
    return b;
  }

  function opp(t) {
    return t === "b" ? "w" : "b";
  }

  function boardAfter(history, n) {
    const b = emptyBoard();
    const lim = Math.max(0, Math.min(n, history.length));
    for (let i = 0; i < lim; i++) {
      const p = history[i];
      b[p.r][p.c] = i % 2 === 0 ? "b" : "w";
    }
    return b;
  }

  function countDir(board, r, c, dr, dc, color) {
    let n = 0;
    let rr = r + dr,
      cc = c + dc;
    while (rr >= 0 && rr < SIZE && cc >= 0 && cc < SIZE && board[rr][cc] === color) {
      n++;
      rr += dr;
      cc += dc;
    }
    return n;
  }

  /** Same-colour run through (r,c) on one axis, counting (r,c) itself. */
  function lineLen(board, r, c, dr, dc, color) {
    return (
      1 + countDir(board, r, c, dr, dc, color) + countDir(board, r, c, -dr, -dc, color)
    );
  }

  /** The stones of that run, centre first, then forward, then backward. */
  function collectLine(board, r, c, dr, dc, color) {
    const line = [{ r, c }];
    let rr = r + dr,
      cc = c + dc;
    while (rr >= 0 && rr < SIZE && cc >= 0 && cc < SIZE && board[rr][cc] === color) {
      line.push({ r: rr, c: cc });
      rr += dr;
      cc += dc;
    }
    rr = r - dr;
    cc = c - dc;
    while (rr >= 0 && rr < SIZE && cc >= 0 && cc < SIZE && board[rr][cc] === color) {
      line.push({ r: rr, c: cc });
      rr -= dr;
      cc -= dc;
    }
    return line;
  }

  function findWin(board, r, c, color) {
    for (const [dr, dc] of DIRS) {
      if (lineLen(board, r, c, dr, dc, color) >= WIN) {
        return collectLine(board, r, c, dr, dc, color);
      }
    }
    return null;
  }

  /* ── 连珠(Renju)禁手 ────────────────────────────────────────────────
   * 只约束黑:长连(≥6)、双四、双三三条,成五优先于全部禁手。
   *   四   = 该方向上存在一个空点,补上后成**恰好**五
   *   活四 = 该方向上有两个不同的成五点
   *   活三 = 该方向上存在一个**合法**空点,补上后成活四
   * 「合法」这一层就是递归所在:一条只能靠禁手点长成活四的三,不是活三,
   * 因此不参与双三。递归深度封顶;到顶按「不禁」处理 —— 宁可漏判也不误判,
   * 因为误判会拦掉一手本来能走的棋,而漏判只是少标一个点。
   */
  const RENJU_DEPTH = 4;

  function inBounds(r, c) {
    return r >= 0 && r < SIZE && c >= 0 && c < SIZE;
  }

  /** Empty points within four steps of (r,c) along one axis. */
  function axisEmpties(board, r, c, dr, dc) {
    const out = [];
    for (let k = -4; k <= 4; k++) {
      if (k === 0) continue;
      const rr = r + dr * k,
        cc = c + dc * k;
      if (inBounds(rr, cc) && !board[rr][cc]) out.push([rr, cc]);
    }
    return out;
  }

  /* 下面三个判据都从**落子点自己**量,不从补进去的那个空点量 —— 那是 v1.54 首版
   * 的 bug:补子后只检查「过 (rr,cc) 的连子是不是五」,而那条五可能根本不含落子点。
   * 实测:黑在 7 行 0–3 与 7 列 0–3 各有一条四,天元 (7,7) 离两条各三格、碰都碰不到,
   * 却被判成双四 —— 于是 UI 画上标记并拒绝这一手**合法棋**。这正是「误判会拦掉一手
   * 本来能走的棋」那条,所以判据换成:补子之后,**过落子点的连子**恰好成五。
   * 落子点在那条五里是构造保证的,不必再验一次。 */

  /** With the stone already down at (r,c): does this axis hold a four through it? */
  function axisIsFour(board, r, c, dr, dc) {
    for (const [rr, cc] of axisEmpties(board, r, c, dr, dc)) {
      board[rr][cc] = "b";
      const five = lineLen(board, r, c, dr, dc, "b") === WIN;
      board[rr][cc] = "";
      if (five) return true;
    }
    return false;
  }

  function axisIsOpenFour(board, r, c, dr, dc) {
    let n = 0;
    for (const [rr, cc] of axisEmpties(board, r, c, dr, dc)) {
      board[rr][cc] = "b";
      if (lineLen(board, r, c, dr, dc, "b") === WIN) n++;
      board[rr][cc] = "";
      if (n >= 2) return true;
    }
    return false;
  }

  function axisIsOpenThree(board, r, c, dr, dc, depth) {
    for (const [rr, cc] of axisEmpties(board, r, c, dr, dc)) {
      board[rr][cc] = "b";
      // 活四同样从 (r,c) 量:要的是「这条三能长成含落子点的活四」
      const grows = axisIsOpenFour(board, r, c, dr, dc);
      board[rr][cc] = "";
      if (!grows) continue;
      // 该点自己是禁手的话,这条三长不成活四,不算活三
      if (depth < RENJU_DEPTH && forbiddenAt(board, rr, cc, depth + 1)) continue;
      return true;
    }
    return false;
  }

  function forbiddenAt(board, r, c, depth) {
    if (board[r][c]) return null;
    board[r][c] = "b";
    try {
      let overline = false;
      for (const [dr, dc] of DIRS) {
        const n = lineLen(board, r, c, dr, dc, "b");
        if (n === WIN) return null; // 成五优先,一切禁手让路
        if (n > WIN) overline = true;
      }
      if (overline) return "overline";
      let fours = 0,
        threes = 0;
      for (const [dr, dc] of DIRS) {
        if (axisIsFour(board, r, c, dr, dc)) fours++;
        else if (axisIsOpenThree(board, r, c, dr, dc, depth)) threes++;
      }
      if (fours >= 2) return "double4";
      if (threes >= 2) return "double3";
      return null;
    } finally {
      board[r][c] = "";
    }
  }

  /**
   * Is black playing (r,c) a forbidden move under Renju?
   * @returns {null|'overline'|'double4'|'double3'}
   */
  function renjuForbidden(board, r, c) {
    return forbiddenAt(board, r, c, 0);
  }

  /** Every empty point black may not play. @returns {{r,c,why}[]} */
  function renjuForbiddenPoints(board) {
    const out = [];
    for (let r = 0; r < SIZE; r++) {
      for (let c = 0; c < SIZE; c++) {
        if (board[r][c]) continue;
        const why = forbiddenAt(board, r, c, 0);
        if (why) out.push({ r, c, why });
      }
    }
    return out;
  }

  /**
   * Win line under a rule set. Under Renju black needs **exactly** five:
   * a six is 长连禁手, not a win — so a black six on the board (import, or a
   * position built before the rule was switched) decides nothing.
   */
  function findWinRule(board, r, c, color, renju) {
    if (!renju || color !== "b") return findWin(board, r, c, color);
    for (const [dr, dc] of DIRS) {
      if (lineLen(board, r, c, dr, dc, "b") === WIN) {
        return collectLine(board, r, c, dr, dc, "b");
      }
    }
    return null;
  }

  function boardFull(board) {
    for (let r = 0; r < SIZE; r++)
      for (let c = 0; c < SIZE; c++) if (!board[r][c]) return false;
    return true;
  }

  function wouldWin(board, r, c, color) {
    if (board[r][c]) return false;
    board[r][c] = color;
    const w = !!findWin(board, r, c, color);
    board[r][c] = "";
    return w;
  }

  function winLineAt(history, n, renju) {
    if (n <= 0) return null;
    const b = boardAfter(history, n);
    const last = history[n - 1];
    const color = (n - 1) % 2 === 0 ? "b" : "w";
    return findWinRule(b, last.r, last.c, color, renju);
  }

  function createInitialState() {
    return {
      board: emptyBoard(),
      turn: "b",
      result: "play",
      mode: "ai",
      difficulty: "normal",
      ruleSet: "free",
      humanColor: "b",
      history: [],
      winLine: null,
      viewIndex: 0,
      startedAt: Date.now(),
      elapsedBaseMs: 0,
      originalStartedAt: Date.now(),
      aiThinking: false,
      gameGen: 0,
      soundOn: true,
      themeId: "wood",
    };
  }

  global.GobanCore = {
    SIZE,
    WIN,
    emptyBoard,
    opp,
    boardAfter,
    countDir,
    lineLen,
    findWin,
    findWinRule,
    renjuForbidden,
    renjuForbiddenPoints,
    boardFull,
    wouldWin,
    winLineAt,
    createInitialState,
  };
})(typeof window !== "undefined" ? window : globalThis);
