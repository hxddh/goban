/**
 * Engine bridge split out of app.js (v1.28): the Blob worker's lifecycle, the
 * degraded main-thread fallback, and the safety nets around both.
 *
 * This is the piece of app.js with the most intricate failure handling —
 * v1.25.2/v1.25.3 both landed fixes in here (stuck「思考中」, a wedged worker
 * quietly demoting every later move to the capped fallback). Isolating it
 * gives that logic one file and one contract instead of living inside the
 * game loop.
 *
 * Everything it needs from the game is read through `deps` at call time, so
 * no game state moved with it.
 * @module engine
 */
(function (global) {
  // named `tr`: initWorker() has a local `const t = setTimeout(...)` that would shadow it
  const tr = (k, p) => (global.GobanI18n ? global.GobanI18n.t(k, p) : k);
  const C1 = global.GobanAi;

  /**
   * deps: {
   *   defaults(): {board, humanColor, difficulty, think, renju},
   *   budgetFor(diff): number,
   *   engineFor(diff): {aiMove},
   *   toast(msg),
   * }
   */
  let deps = null;
  function init(d) { deps = d; }

  let aiWorker = null;
  let aiReqId = 0;
  const aiPending = new Map();

  /**
   * 'init' | 'ready' | 'failed'. The packaged WKWebView cannot load classic
   * worker scripts through the zero:// custom-scheme handler (workers bypass
   * WKURLSchemeHandler), so the worker is built from a Blob of the engine
   * sources fetched by the page — the page context CAN fetch them.
   */
  let workerState = "init";
  let workerInitPromise = null;
  let workerRestarts = 0;
  let degradeToastShown = false;
  /** Blob URL cached so a busy worker can be rebuilt instantly. */
  let workerBlobUrl = null;
  /** Jobs posted to the worker and not yet answered (stale ones included). */
  let workerJobs = 0;
  /** Times a move had to come from the capped main-thread fallback. */
  let syncFallbacks = 0;
  let pongResolve = null;

  const WORKER_SRC = ["js/core.js", "js/ai.js", "js/ai2.js", "js/ai-worker.js"];

  function withDefaults(opts) {
    const d = deps.defaults();
    return {
      board: (opts && opts.board) || d.board,
      humanColor: (opts && opts.humanColor) || d.humanColor,
      side: opts && opts.side,
      difficulty: (opts && opts.difficulty) || d.difficulty,
      // 禁手规则要一路带到引擎:引擎在交货口验这一手是否合法(见 legalizeRenju)
      renju: !!(opts && opts.renju !== undefined ? opts.renju : d.renju),
    };
  }

  function moveSync(opts) {
    const d = deps.defaults();
    const diff = (opts && opts.difficulty) || d.difficulty;
    const timeMs =
      typeof (opts && opts.timeMs) === "number" ? opts.timeMs : deps.budgetFor(diff);
    return deps.engineFor(diff).aiMove({
      board: (opts && opts.board) || d.board,
      humanColor: (opts && opts.humanColor) || d.humanColor,
      side: opts && opts.side,
      difficulty: diff,
      timeMs: timeMs,
      think: d.think,
      renju: !!(opts && opts.renju !== undefined ? opts.renju : d.renju),
    });
  }

  /**
   * moveSync that can never throw: an exception here previously left the
   * caller's promise unsettled — aiThinking stayed true forever.
   */
  function moveSyncSafe(opts) {
    try {
      return moveSync(opts);
    } catch (e) {
      const d = deps.defaults();
      try {
        return C1.aiMove({
          board: (opts && opts.board) || d.board,
          humanColor: (opts && opts.humanColor) || d.humanColor,
          side: opts && opts.side,
          difficulty: "normal",
          timeMs: 200,
          renju: !!(opts && opts.renju !== undefined ? opts.renju : d.renju),
        });
      } catch (_) {
        return null;
      }
    }
  }

  function rejectAllPending(reason) {
    const pend = Array.from(aiPending.values());
    aiPending.clear();
    pend.forEach((p) => {
      try { p.reject(new Error(reason)); } catch (_) {}
    });
  }

  function dropWorker(permanent) {
    if (aiWorker) {
      try { aiWorker.terminate(); } catch (_) {}
    }
    aiWorker = null;
    if (permanent) workerState = "failed";
    rejectAllPending("worker unavailable");
  }

  function attachWorkerHandlers(w) {
    w.onmessage = (ev) => {
      const data = ev.data || {};
      if (data.pong) {
        if (pongResolve) {
          const r = pongResolve;
          pongResolve = null;
          r(!!data.engines);
        }
        return;
      }
      if (data.type === "error" && !data.id) {
        // bootstrap failure: reject waiters NOW instead of leaving them to
        // the safety timeout (the old gap behind "stuck thinking")
        dropWorker(true);
        return;
      }
      if (workerJobs > 0) workerJobs--;
      const pending = aiPending.get(data.id);
      if (!pending) return;
      aiPending.delete(data.id);
      if (data.error) pending.reject(new Error(data.error));
      else pending.resolve(data.move || null);
    };
    w.onerror = () => {
      dropWorker(false);
      workerState = "init";
      workerJobs = 0;
      // one rebuild for transient faults, then give up for the session
      if (workerRestarts++ < 1) workerInitPromise = initWorker();
      else workerState = "failed";
    };
  }

  /**
   * The worker runs jobs serially with no cancellation: a stale job (hint
   * discarded by a placed stone, request abandoned on new game, safety
   * timeout) would keep it busy for a full budget and every later move
   * would drop to the capped fallback — the "gets dumber mid-game" spiral.
   * Rebuilding from the cached Blob URL clears the backlog instantly.
   */
  function restartWorker() {
    if (!workerBlobUrl || workerState !== "ready") return;
    if (aiWorker) {
      try { aiWorker.terminate(); } catch (_) {}
    }
    // stale pendings resolve null; caller-side gen/histLen guards discard them
    const pend = Array.from(aiPending.values());
    aiPending.clear();
    workerJobs = 0;
    pend.forEach((p) => {
      try { p.resolve(null); } catch (_) {}
    });
    try {
      aiWorker = new Worker(workerBlobUrl);
      attachWorkerHandlers(aiWorker);
    } catch (_) {
      aiWorker = null;
      workerState = "failed";
    }
  }

  async function initWorker() {
    if (aiWorker || workerState === "failed" || typeof Worker === "undefined") return;
    // debug/diagnostic switch: force the degraded main-thread path
    if (/[?&]noworker=1/.test(window.location.search)) {
      workerState = "failed";
      return;
    }
    try {
      // Embedded source is primary: the zero:// scheme handler returns bare
      // NSURLResponse objects that <script> accepts but spec-strict fetch()
      // rejects — so the packaged app cannot fetch its own assets. worker-src.js
      // (generated at build time) carries the sources in via a script tag.
      let src = typeof window.GOBAN_WORKER_SRC === "string" && window.GOBAN_WORKER_SRC
        ? window.GOBAN_WORKER_SRC
        : null;
      if (!src) {
        const texts = await Promise.all(
          WORKER_SRC.map((path) =>
            fetch(path).then((r) => {
              if (!r.ok) throw new Error("fetch " + path + ": " + r.status);
              return r.text();
            })
          )
        );
        src = texts.join("\n;\n");
      }
      const blob = new Blob([src], { type: "text/javascript" });
      workerBlobUrl = URL.createObjectURL(blob);
      const w = new Worker(workerBlobUrl);
      attachWorkerHandlers(w);
      const healthy = await new Promise((resolve) => {
        const t = setTimeout(() => resolve(false), 1500);
        pongResolve = (ok) => {
          clearTimeout(t);
          resolve(ok);
        };
        try {
          w.postMessage({ ping: true });
        } catch (_) {
          resolve(false);
        }
      });
      if (!healthy || workerState === "failed") {
        try { w.terminate(); } catch (_) {}
        if (workerState !== "failed") workerState = "failed";
        return;
      }
      aiWorker = w;
      workerState = "ready";
    } catch (_) {
      workerState = "failed";
    }
  }

  /** Build the worker up-front so the first computer reply has no cold start. */
  function warmup() {
    workerInitPromise = initWorker();
    return workerInitPromise;
  }

  /**
   * Run AI off-thread when the Blob worker is healthy; otherwise a DEGRADED
   * main-thread run with a hard 600ms cap — the UI must never freeze for a
   * full hard/extreme budget.
   * @returns {Promise<{r:number,c:number}|null>}
   */
  async function moveAsync(opts) {
    const payload = withDefaults(opts);
    const d = deps.defaults();
    const useWorker = payload.difficulty !== "easy";
    const timeMs =
      typeof (opts && opts.timeMs) === "number" ? opts.timeMs : deps.budgetFor(payload.difficulty);
    const think = (opts && opts.think) || d.think;
    if (useWorker && workerState === "init" && workerInitPromise) {
      // bounded wait: a fetch that neither resolves nor rejects must not
      // wedge the game — after 3s we proceed degraded
      try {
        await Promise.race([
          workerInitPromise,
          new Promise((r) => setTimeout(r, 3000)),
        ]);
      } catch (_) {}
    }
    // a busy worker at this point only holds STALE jobs (app flow is serial
    // per intent) — rebuild so this request starts immediately
    if (useWorker && workerState === "ready" && workerJobs > 0) restartWorker();
    const w = useWorker && workerState === "ready" ? aiWorker : null;
    const cappedMs = Math.min(600, timeMs);
    if (w) {
      return new Promise((resolve) => {
        const id = ++aiReqId;
        let settled = false;
        const finish = (move) => {
          if (settled) return;
          settled = true;
          aiPending.delete(id);
          resolve(move);
        };
        aiPending.set(id, {
          resolve: (move) => finish(move),
          // worker died mid-request: capped main-thread fallback
          reject: () =>
            finish(moveSyncSafe(Object.assign({}, payload, { timeMs: cappedMs, think: think }))),
        });
        try {
          w.postMessage({
            id: id,
            board: payload.board,
            humanColor: payload.humanColor,
            side: payload.side,
            difficulty: payload.difficulty,
            timeMs: timeMs,
            think: think,
            renju: payload.renju,
          });
          workerJobs++;
        } catch (e) {
          syncFallbacks++;
          finish(moveSyncSafe(Object.assign({}, payload, { timeMs: cappedMs, think: think })));
          return;
        }
        // safety net: budget + margin. If it fires the worker is wedged on
        // this job — rebuild so the NEXT move is full-strength again.
        // Detach this id BEFORE restartWorker: restart resolves remaining
        // pendings with null, which would settle us first and drop the
        // Safe fallback (AI turn stranded with no stone).
        setTimeout(() => {
          if (settled) return;
          syncFallbacks++;
          aiPending.delete(id);
          const fallback = moveSyncSafe(
            Object.assign({}, payload, { timeMs: cappedMs, think: think })
          );
          restartWorker();
          finish(fallback);
        }, timeMs + 2000);
      });
    }
    // degraded path
    if (
      useWorker &&
      workerState === "failed" &&
      (payload.difficulty === "hard" || payload.difficulty === "extreme") &&
      !degradeToastShown
    ) {
      degradeToastShown = true;
      deps.toast(tr("engine.degraded"));
    }
    if (useWorker) syncFallbacks++;
    return new Promise((resolve) => {
      // small delay lets the 思考中 status paint before the sync compute
      setTimeout(
        () => resolve(moveSyncSafe(Object.assign({}, payload, { timeMs: cappedMs, think: think }))),
        30
      );
    });
  }

  /** Diagnostic hook for bug reports: state:jobs:fallbacks:restarts. */
  function diagnostics() {
    return workerState + ":jobs=" + workerJobs + ":fallbacks=" + syncFallbacks +
      ":restarts=" + workerRestarts;
  }

  global.GobanEngine = {
    init, warmup, moveAsync, moveSync, moveSyncSafe, restartWorker, diagnostics,
    state: () => workerState,
  };
  global.__gobanWorker = diagnostics;
})(typeof window !== "undefined" ? window : globalThis);
