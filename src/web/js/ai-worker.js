/**
 * Web Worker: C1.c threat-first AI.
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
        timeMs = think === "fast" ? 800 : think === "deep" ? 3500 : 2000;
      } else if (difficulty === "normal") timeMs = 250;
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
