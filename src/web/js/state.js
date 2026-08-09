/**
 * Session state factory + pure-ish reducers for import / board views.
 * UI still mutates fields; this documents the shape and shared transitions.
 */
(function (global) {
  const t = (k, p) => (global.GobanI18n ? global.GobanI18n.t(k, p) : k);
  const Core = global.GobanCore;
  const SIZE = Core.SIZE;

  /**
   * Scan the whole board for a win. Under Renju a black six is 长连禁手 rather
   * than a win, so the rule has to reach this scan too — otherwise a loaded
   * game would be called a black win the live board would never have allowed.
   * @returns {{color,line}|null}
   */
  function boardWinLine(board, renju) {
    for (let r = 0; r < SIZE; r++) {
      for (let c = 0; c < SIZE; c++) {
        const s = board[r][c];
        if (!s) continue;
        const line = Core.findWinRule(board, r, c, s, renju);
        if (line) return { color: s, line: line };
      }
    }
    return null;
  }

  /**
   * Outcome of a static board (import / save restore). Full-board scan — not
   * last-move-only — so a five mid-history with stray continuations still
   * counts as finished.
   * @returns {{ result: 'play'|'b'|'w'|'draw', winLine: object[]|null }}
   */
  function resultFromBoard(board, renju) {
    const won = boardWinLine(board, renju);
    if (won) return { result: won.color, winLine: won.line };
    if (Core.boardFull(board)) return { result: "draw", winLine: null };
    return { result: "play", winLine: null };
  }

  function createSession() {
    const s = Core.createInitialState();
    s.panelOpen = false;
    s.importPaused = false;
    return s;
  }

  /**
   * Apply a move list as a loaded/imported game (replay snapshot).
   * Does not start AI — caller decides. Sets importPaused so UI can offer「续下」.
   * @returns {{ ok: true, session: object } | { ok: false, error: string }}
   */
  function sessionFromHistory(history, base) {
    if (!history || !history.length) {
      return { ok: false, error: t("state.err.noMoves") };
    }
    const session = base ? Object.assign({}, base) : createSession();
    session.history = history.slice();
    session.viewIndex = history.length;
    session.board = Core.boardAfter(history, history.length);
    session.result = "play";
    session.winLine = null;
    session.aiThinking = false;
    session.gameGen = (session.gameGen || 0) + 1;
    session.importPaused = true;

    // A five anywhere on the board ends the game — not only on the last move.
    // Hand-edited or non-standard SGFs can carry a win mid-history followed by
    // more stones; checking only the last move would import that as "playable"
    // and let 续下 continue a decided position.
    const outcome = resultFromBoard(session.board, session.ruleSet === "renju");
    session.result = outcome.result;
    session.winLine = outcome.winLine;
    if (outcome.result !== "play") {
      session.importPaused = false; // finished game: only review
    }
    session.turn = history.length % 2 === 0 ? "b" : "w";
    session.elapsedBaseMs = 0;
    session.startedAt = Date.now();
    session.originalStartedAt = Date.now();
    return { ok: true, session };
  }

  function isLive(session) {
    return session.viewIndex === session.history.length;
  }

  function isHumanTurn(session) {
    if (session.mode === "pvp") return true;
    return session.turn === session.humanColor;
  }

  /** Import can resume play (not finished, still paused for AI/human resume). */
  function canContinuePlay(session) {
    return !!(
      session &&
      session.importPaused &&
      session.result === "play" &&
      session.history &&
      session.history.length
    );
  }

  /**
   * Clear import pause so play / AI may proceed.
   * Mutates and returns session for chaining.
   */
  function resumeFromImport(session) {
    if (!session) return session;
    session.importPaused = false;
    session.viewIndex = session.history ? session.history.length : 0;
    if (session.result === "play" && session.history) {
      session.turn = session.history.length % 2 === 0 ? "b" : "w";
      session.board = Core.boardAfter(session.history, session.history.length);
      session.winLine = null;
    }
    return session;
  }

  global.GobanState = {
    createSession,
    sessionFromHistory,
    boardWinLine,
    resultFromBoard,
    isLive,
    isHumanTurn,
    canContinuePlay,
    resumeFromImport,
  };
})(typeof window !== "undefined" ? window : globalThis);
