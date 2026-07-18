/**
 * Web Worker: C1.b AI off the UI thread.
 */
/* global GobanAi */
try {
  importScripts("core.js", "ai.js");
} catch (e) {
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
    const difficulty = data.difficulty || "normal";
    const think = data.think || "normal";
    let timeMs = data.timeMs;
    if (typeof timeMs !== "number") {
      if (difficulty === "hard") {
        timeMs = think === "fast" ? 400 : think === "deep" ? 1200 : 700;
      } else if (difficulty === "normal") timeMs = 120;
      else timeMs = 30;
    }
    const move = self.GobanAi.aiMove({
      board: data.board,
      humanColor: data.humanColor,
      side: data.side,
      difficulty: difficulty,
      timeMs: timeMs,
      think: think,
    });
    self.postMessage({ id: id, move: move });
  } catch (err) {
    self.postMessage({
      id: id,
      error: String(err && err.message ? err.message : err),
    });
  }
};
