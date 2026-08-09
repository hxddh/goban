/**
 * Web Worker tail: C1/C2 engine dispatch.
 *
 * Normally this file is CONCATENATED after core.js + ai.js + ai2.js into a
 * Blob worker (see app.js initAiWorker) — WKWebView cannot load worker
 * scripts through the zero:// custom-scheme handler, so classic
 * `new Worker(url)` + importScripts never worked in the packaged app.
 * The importScripts below only runs when this file is loaded standalone
 * (e.g. plain HTTP during development).
 */
/* global GobanAi, GobanAi2 */
if (!self.GobanAi && typeof importScripts === "function") {
  try {
    importScripts("core.js", "ai.js", "ai2.js");
  } catch (e) {
    self.postMessage({ type: "error", error: String(e && e.message ? e.message : e) });
  }
}

self.onmessage = function (ev) {
  const data = ev.data || {};
  const id = data.id;
  // health check: lets the app verify the worker actually booted
  if (data.ping) {
    self.postMessage({ pong: true, engines: !!(self.GobanAi && self.GobanAi2) });
    return;
  }
  try {
    if (!self.GobanAi || typeof self.GobanAi.aiMove !== "function") {
      self.postMessage({ id: id, error: "ai unavailable" });
      return;
    }
    const difficulty = data.difficulty || "normal";
    const think = data.think || "normal";
    let timeMs = data.timeMs;
    if (typeof timeMs !== "number") {
      if (difficulty === "extreme") {
        timeMs = think === "fast" ? 2500 : think === "deep" ? 8000 : 5000;
      } else if (difficulty === "hard") {
        timeMs = think === "fast" ? 800 : think === "deep" ? 3500 : 2000;
      } else if (difficulty === "normal") timeMs = 250;
      else timeMs = 30;
    }
    const engine =
      (difficulty === "hard" || difficulty === "extreme") && self.GobanAi2
        ? self.GobanAi2
        : self.GobanAi;
    const move = engine.aiMove({
      board: data.board,
      humanColor: data.humanColor,
      side: data.side,
      difficulty: difficulty,
      timeMs: timeMs,
      think: think,
      renju: !!data.renju,
    });
    self.postMessage({ id: id, move: move });
  } catch (err) {
    self.postMessage({
      id: id,
      error: String(err && err.message ? err.message : err),
    });
  }
};
