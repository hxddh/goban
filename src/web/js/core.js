/**
 * Pure gomoku rules & board helpers (no DOM).
 * @module core
 */
(function (global) {
  const SIZE = 15;
  const WIN = 5;

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

  function findWin(board, r, c, color) {
    const dirs = [
      [0, 1],
      [1, 0],
      [1, 1],
      [1, -1],
    ];
    for (const [dr, dc] of dirs) {
      const a = countDir(board, r, c, dr, dc, color);
      const b = countDir(board, r, c, -dr, -dc, color);
      if (1 + a + b >= WIN) {
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

  function winLineAt(history, n) {
    if (n <= 0) return null;
    const b = boardAfter(history, n);
    const last = history[n - 1];
    const color = (n - 1) % 2 === 0 ? "b" : "w";
    return findWin(b, last.r, last.c, color);
  }

  function createInitialState() {
    return {
      board: emptyBoard(),
      turn: "b",
      result: "play",
      mode: "ai",
      difficulty: "normal",
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
    findWin,
    boardFull,
    wouldWin,
    winLineAt,
    createInitialState,
  };
})(typeof window !== "undefined" ? window : globalThis);
