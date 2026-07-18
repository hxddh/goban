/**
 * Web Worker: run AI off the UI thread.
 * Loads core + ai via importScripts (same directory).
 */
/* global GobanAi */
try {
  importScripts("core.js", "ai.js");
} catch (e) {
  // Some hosts reject relative importScripts — main thread will fall back.
  self.postMessage({ type: "error", error: String(e && e.message ? e.message : e) });
}

self.onmessage = function (ev) {
  const data = ev.data || {};
  const id = data.id;
  try {
    if (!self.GobanAi || typeof self.GobanAi.aiMove !== "function") {
      self.postMessage({ id: id, error: "ai unavailable" });
      return;
    }
    const move = self.GobanAi.aiMove({
      board: data.board,
      humanColor: data.humanColor,
      side: data.side,
      difficulty: data.difficulty,
    });
    self.postMessage({ id: id, move: move });
  } catch (err) {
    self.postMessage({
      id: id,
      error: String(err && err.message ? err.message : err),
    });
  }
};
