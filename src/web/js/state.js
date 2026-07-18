/**
 * Session state factory + pure-ish reducers for import / board views.
 * UI still mutates fields; this documents the shape and shared transitions.
 */
(function (global) {
  const Core = global.GobanCore;

  function createSession() {
    const s = Core.createInitialState();
    s.panelOpen = false;
    return s;
  }

  /**
   * Apply a move list as a loaded/imported game (replay snapshot).
   * Does not start AI — caller decides.
   * @returns {{ ok: true, session: object } | { ok: false, error: string }}
   */
  function sessionFromHistory(history, base) {
    if (!history || !history.length) {
      return { ok: false, error: "没有可导入的落子" };
    }
    const session = base ? Object.assign({}, base) : createSession();
    session.history = history.slice();
    session.viewIndex = history.length;
    session.board = Core.boardAfter(history, history.length);
    session.result = "play";
    session.winLine = null;
    session.aiThinking = false;
    session.gameGen = (session.gameGen || 0) + 1;

    const last = history[history.length - 1];
    const lastColor = (history.length - 1) % 2 === 0 ? "b" : "w";
    const line = Core.findWin(session.board, last.r, last.c, lastColor);
    if (line) {
      session.result = lastColor;
      session.winLine = line;
    } else if (Core.boardFull(session.board)) {
      session.result = "draw";
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

  global.GobanState = {
    createSession,
    sessionFromHistory,
    isLive,
    isHumanTurn,
  };
})(typeof window !== "undefined" ? window : globalThis);
