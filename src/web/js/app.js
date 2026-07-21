(function () {

  const Core = window.GobanCore;
  const SgfMod = window.GobanSgf;
  const Ai = window.GobanAi;
  const Host = window.GobanHost;
  const GameState = window.GobanState;
  const Draw = window.GobanDraw;
  const SIZE = Core.SIZE;
  const WIN = Core.WIN;
  const SAVE_KEY = "goban.v12.save";
  const SLOTS_KEY = "goban.v12.slots";
  const SLOTS_MAX = 30;
  const SETTINGS_KEY = "goban.v11.settings";
  const PANEL_KEY = "goban.panelOpen";

  const canvas = document.getElementById("board");
  const ctx = canvas.getContext("2d");
  const appEl = document.getElementById("app");
  const THEMES = Draw.THEMES;

  function emptyBoard() { return Core.emptyBoard(); }
  function opp(t) { return Core.opp(t); }
  function boardAfter(n) { return Core.boardAfter(history, n); }
  function winLineAt(n) { return Core.winLineAt(history, n); }
  function findWin(r, c, color) { return Core.findWin(board, r, c, color); }
  function boardFull() { return Core.boardFull(board); }
  function wouldWin(r, c, color) { return Core.wouldWin(board, r, c, color); }
  /** @type {'fast' | 'normal' | 'deep'} hard-mode think budget */
  let thinkLevel = "normal";

  function hardTimeMs() {
    if (thinkLevel === "fast") return 800;
    if (thinkLevel === "deep") return 3500;
    return 2000;
  }

  function extremeTimeMs() {
    if (thinkLevel === "fast") return 2500;
    if (thinkLevel === "deep") return 8000;
    return 5000;
  }

  function budgetForDiff(diff) {
    if (diff === "extreme") return extremeTimeMs();
    if (diff === "hard") return hardTimeMs();
    if (diff === "normal") return 250;
    return 30;
  }

  /** hard/extreme run the C2 engine; normal/easy keep C1. */
  function engineFor(diff) {
    return (diff === "hard" || diff === "extreme") && window.GobanAi2 ? window.GobanAi2 : Ai;
  }

  function aiMoveSync(opts) {
    const diff = (opts && opts.difficulty) || difficulty;
    const timeMs =
      typeof (opts && opts.timeMs) === "number" ? opts.timeMs : budgetForDiff(diff);
    return engineFor(diff).aiMove({
      board: (opts && opts.board) || board,
      humanColor: (opts && opts.humanColor) || humanColor,
      side: opts && opts.side,
      difficulty: diff,
      timeMs: timeMs,
      think: thinkLevel,
    });
  }

  let aiWorker = null;
  let aiReqId = 0;
  const aiPending = new Map();

  /**
   * aiMoveSync that can never throw: an exception here previously left the
   * caller's promise unsettled — aiThinking stayed true forever.
   */
  function aiMoveSyncSafe(opts) {
    try {
      return aiMoveSync(opts);
    } catch (e) {
      try {
        return Ai.aiMove({
          board: (opts && opts.board) || board,
          humanColor: (opts && opts.humanColor) || humanColor,
          side: opts && opts.side,
          difficulty: "normal",
          timeMs: 200,
        });
      } catch (_) {
        return null;
      }
    }
  }
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

  const WORKER_SRC = ["js/core.js", "js/ai.js", "js/ai2.js", "js/ai-worker.js"];

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

  let pongResolve = null;

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
      if (workerRestarts++ < 1) workerInitPromise = initAiWorker();
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

  async function initAiWorker() {
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

  /** Diagnostic hook for bug reports: state:jobs:fallbacks:restarts. */
  window.__gobanWorker = () =>
    workerState + ":jobs=" + workerJobs + ":fallbacks=" + syncFallbacks + ":restarts=" + workerRestarts;

  /**
   * Run AI off-thread when the Blob worker is healthy; otherwise a DEGRADED
   * main-thread run with a hard 600ms cap — the UI must never freeze for a
   * full hard/extreme budget.
   * @returns {Promise<{r:number,c:number}|null>}
   */
  async function aiMoveAsync(opts) {
    const payload = {
      board: (opts && opts.board) || board,
      humanColor: (opts && opts.humanColor) || humanColor,
      side: opts && opts.side,
      difficulty: (opts && opts.difficulty) || difficulty,
    };
    const useWorker = payload.difficulty !== "easy";
    const timeMs =
      typeof (opts && opts.timeMs) === "number" ? opts.timeMs : budgetForDiff(payload.difficulty);
    const think = (opts && opts.think) || thinkLevel;
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
            finish(
              aiMoveSyncSafe(Object.assign({}, payload, { timeMs: cappedMs, think: think }))
            ),
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
          });
          workerJobs++;
        } catch (e) {
          syncFallbacks++;
          finish(aiMoveSyncSafe(Object.assign({}, payload, { timeMs: cappedMs, think: think })));
          return;
        }
        // safety net: budget + margin. If it fires the worker is wedged on
        // this job — rebuild so the NEXT move is full-strength again.
        setTimeout(() => {
          if (settled) return;
          syncFallbacks++;
          restartWorker();
          finish(
            aiMoveSyncSafe(Object.assign({}, payload, { timeMs: cappedMs, think: think }))
          );
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
      toast("后台计算不可用，已降级速算");
    }
    if (useWorker) syncFallbacks++;
    return new Promise((resolve) => {
      // small delay lets the 思考中 status paint before the sync compute
      setTimeout(
        () =>
          resolve(aiMoveSyncSafe(Object.assign({}, payload, { timeMs: cappedMs, think: think }))),
        30
      );
    });
  }
  function buildSgf() {
    return SgfMod.buildSgf({
      history: history,
      result: result,
      mode: mode,
      humanColor: humanColor,
      originalStartedAt: originalStartedAt,
    });
  }
  function sgfFileName() { return SgfMod.fileNameFromDate(originalStartedAt); }
  function bytesToBase64(str) { return Host.bytesToBase64(str); }
  function downloadSgfBlob(sgf, name) {
    const blob = new Blob([sgf], { type: "application/x-go-sgf" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }
  async function exportSgfString(sgf, name) {
    if (Host.hasZero()) {
      try {
        const path = await Host.saveFileDialog({ title: "导出 SGF", defaultName: name });
        if (path == null) { toast("已取消导出"); return; }
        await Host.writeTextFile(path, sgf);
        await Host.revealPath(path);
        toast("已导出 " + name);
        return;
      } catch (e) {}
    }
    try {
      downloadSgfBlob(sgf, name);
      toast("已导出 " + name);
    } catch (_) {
      try { await copySgfText(sgf); toast("导出受限，SGF 已复制到剪贴板"); }
      catch (e2) { toast("导出失败"); }
    }
  }
  async function downloadSgf() {
    if (!history.length) { toast("还没有棋谱可导出"); return; }
    await exportSgfString(buildSgf(), sgfFileName());
  }
  async function copySgfText(sgf) { await Host.writeClipboard(sgf); }
  async function copySgf() {
    if (!history.length) { toast("还没有棋谱可复制"); return; }
    try {
      await copySgfText(buildSgf());
      toast("SGF 已复制到剪贴板");
    } catch (_) { toast("复制失败，请用导出文件"); }
  }

  async function readTextFile(path) { return Host.readTextFile(path); }

  async function importSgfFromText(text, label) {
    const parsed = SgfMod.parseSgf(text);
    if (parsed.error || !parsed.history || !parsed.history.length) {
      toast(parsed.error || "导入失败：无法解析棋谱");
      return false;
    }
    if (history.length) {
      const ok = await confirmNative(
        "导入棋谱将替换当前对局（仅复盘，不会自动让电脑续下）。是否继续？",
        "导入 SGF",
        { ok: "导入", cancel: "取消" }
      );
      if (!ok) return false;
    }
    const applied = GameState.sessionFromHistory(parsed.history, {
      mode: mode,
      difficulty: difficulty,
      humanColor: humanColor,
      soundOn: soundOn,
      themeId: themeId,
      gameGen: gameGen,
    });
    if (!applied.ok) {
      toast(applied.error || "导入失败");
      return false;
    }
    const s = applied.session;
    history = s.history;
    viewIndex = s.viewIndex;
    board = s.board;
    result = s.result;
    winLine = s.winLine;
    turn = s.turn;
    elapsedBaseMs = s.elapsedBaseMs;
    startedAt = s.startedAt;
    originalStartedAt = s.originalStartedAt;
    aiThinking = false;
    gameGen = s.gameGen;
    placeAnim = null;
    clearHint();
    clearAnalysis();
    clearVariation();
    hoverCell = null;
    importPaused = !!s.importPaused;
    // Review-only: never maybeAiTurn after import until「续下」.
    if (result === "b" || result === "w") triggerWinFlash();
    sync();
    saveGame();
    const tag = label ? " · " + label : "";
    const end =
      result === "b" ? "（黑胜）" : result === "w" ? "（白胜）" : result === "draw" ? "（满盘）" : "（可复盘）";
    const hint = importPaused ? " · 点「续下」可继续" : " · 仅复盘";
    toast("已导入 " + history.length + " 手" + end + tag + hint);
    return true;
  }

  /** After import: resume live play (and AI if needed). */
  function continueFromImport() {
    if (!importPaused || result !== "play" || !history.length) {
      toast(result !== "play" ? "这局已结束，仅可复盘" : "当前无需续下");
      return;
    }
    importPaused = false;
    goLive();
    toast(mode === "ai" && !isHumanTurn() ? "续下：电脑行棋" : "续下：可落子");
    maybeAiTurn();
  }

  async function pasteSgfFromClipboard() {
    let text = "";
    try {
      text = await Host.readClipboard();
    } catch (_) {
      toast("无法读取剪贴板");
      return;
    }
    if (!text || !String(text).trim()) {
      toast("剪贴板为空");
      return;
    }
    await importSgfFromText(String(text), "剪贴板");
  }

  async function importSgfFromPath(path) {
    if (!path) {
      toast("无效的文件路径");
      return;
    }
    try {
      const text = await readTextFile(path);
      if (!text || !String(text).trim()) {
        toast("文件为空");
        return;
      }
      const base = String(path).split(/[/\\]/).pop() || "sgf";
      await importSgfFromText(text, base);
    } catch (e) {
      const msg = (e && e.message) || "";
      toast(msg && msg.length < 48 ? "读取失败：" + msg : "读取文件失败（权限或路径无效）");
    }
  }

  async function pickAndImportSgf() {
    if (!Host.hasZero()) {
      toast("当前环境不支持打开文件");
      return;
    }
    try {
      const files = await Host.openFileDialog({
        title: "导入 SGF",
        allowMultiple: false,
      });
      const paths = Host.normalizePaths(files);
      if (!paths.length) {
        toast("已取消导入");
        return;
      }
      await importSgfFromPath(paths[0]);
    } catch (e) {
      toast("打开文件失败");
    }
  }

  function triggerWinFlash() {
    winFlashUntil = performance.now() + 420;
    appEl.classList.add("board-frame-win");
    ensureAnimLoop();
    setTimeout(() => {
      appEl.classList.remove("board-frame-win");
    }, 450);
  }



  /** @type {(''| 'b' | 'w')[][]} */
  let board = Core.emptyBoard();
  /** @type {'b' | 'w'} */
  let turn = "b";
  /** @type {'play' | 'b' | 'w' | 'draw'} */
  let result = "play";
  /** @type {'ai' | 'pvp'} */
  let mode = "ai";
  /** @type {'easy' | 'normal' | 'hard'} */
  let difficulty = "normal";
  /** @type {'b' | 'w'} human color in AI mode */
  let humanColor = "b";
  /** @type {'standard' | 'swap2'} opening protocol */
  let openingRule = "standard";
  /**
   * swap2 opening state, null outside the opening.
   * phase: 'place' (P1 lays 3) → 'p2choose' → ('place2' P2 lays 2 → 'p1choose') → done.
   * Board stones stay strictly alternating (B,W,B,…) — swap2 only decides who
   * places the opening and which color each player controls afterward.
   * @type {{phase:string}|null}
   */
  let swap2 = null;
  /** @type {{r:number,c:number}[]} */
  let history = [];
  /** @type {{r:number,c:number}[] | null} */
  let winLine = null;
  /** How many moves are currently shown (0..history.length). */
  let viewIndex = 0;
  let startedAt = Date.now();
  let elapsedBaseMs = 0;
  let originalStartedAt = Date.now();
  let clockTimer = null;
  let aiThinking = false;
  /** Bumps on reset/load so late AI timeouts cannot place on a new game. */
  let gameGen = 0;
  let soundOn = true;
  let audioCtx = null;
  /** @type {'wood' | 'night' | 'day' | 'notebook'} */
  let themeId = "wood";
  /** Board coordinate labels (A-O / 15-1). */
  let showCoords = false;
  /** @type {{r:number,c:number,t0:number}|null} */
  let placeAnim = null;
  /** After SGF import: no auto-AI until「续下」or human places. */
  let importPaused = false;
  let winFlashUntil = 0;
  /** @type {{r:number,c:number,color:string}|null} */
  let hoverCell = null;
  /** @type {{r:number,c:number}|null} */
  let hintCell = null;
  let hintBusy = false;

  // --- replay coach analysis ---
  /** Show move-quality verdicts + a better-move marker while browsing replay. */
  let analysisOn = false;
  /** @type {{r:number,c:number}|null} engine's better move at the viewed position */
  let analysisCell = null;
  /** @type {{grade:string, text:string}|null} verdict for the move that led here */
  let analysisVerdict = null;
  /** viewIndex -> {cell, verdict} cache so revisiting a position is instant */
  const analysisCache = new Map();
  let analysisGen = 0;
  let analysisTimer = null;

  function hasZero() { return Host.hasZero(); }

  function clearHint() {
    hintCell = null;
  }

  function clearAnalysis() {
    analysisCell = null;
    analysisVerdict = null;
    if (analysisTimer) { clearTimeout(analysisTimer); analysisTimer = null; }
    analysisGen++;
    analysisCache.clear();
  }

  /**
   * High-confidence verdict for the move that led to position `i`, computed
   * instantly from tactical primitives (no engine think). Returns null when
   * there's no hard call — the soft best/other verdict is decided async.
   */
  function coachFacts(preBoard, sColor, played) {
    const oppC = opp(sColor);
    const playedWins = Core.wouldWin(preBoard, played.r, played.c, sColor);
    if (playedWins) return { grade: "best", text: "制胜一手" };
    // missed win: a five was available but not taken
    const myWins = Ai.listWinCells(preBoard, sColor);
    if (myWins.length) return { grade: "blunder", text: "错失胜着", best: myWins[0] };
    // allowed opponent win-in-1 the move failed to prevent
    const after = preBoard.map((row) => row.slice());
    after[played.r][played.c] = sColor;
    if (Ai.listWinCells(after, oppC).length) return { grade: "blunder", text: "漏防·被反杀" };
    return null;
  }

  /** Analyze the move that led to the currently-viewed replay position. */
  function scheduleAnalysis() {
    if (analysisTimer) { clearTimeout(analysisTimer); analysisTimer = null; }
    analysisCell = null;
    analysisVerdict = null;
    if (!analysisOn || isLive() || viewIndex < 1) return;
    const i = viewIndex;
    if (analysisCache.has(i)) {
      const c = analysisCache.get(i);
      analysisCell = c.cell;
      analysisVerdict = c.verdict;
      return;
    }
    const played = history[i - 1];
    const sColor = (i - 1) % 2 === 0 ? "b" : "w";
    const preBoard = boardAfter(i - 1);
    const hard = coachFacts(preBoard, sColor, played);
    // show the instant verdict right away; the better-move marker fills in async
    analysisVerdict = hard || { grade: "pending", text: "分析中…" };
    analysisCell = hard && hard.best ? hard.best : null;
    const gen = ++analysisGen;
    const diff = difficulty === "easy" ? "normal" : difficulty === "extreme" ? "hard" : difficulty;
    analysisTimer = setTimeout(() => {
      analysisTimer = null;
      aiMoveAsync({ board: preBoard, side: sColor, difficulty: diff, timeMs: 600 })
        .then((best) => {
          if (gen !== analysisGen || viewIndex !== i) return; // stale
          let verdict = hard;
          let cell = analysisCell;
          if (!hard) {
            if (best && (best.r !== played.r || best.c !== played.c)) {
              cell = best;
              verdict = { grade: "ok", text: "有更优 · 虚线处" };
            } else {
              cell = null;
              verdict = { grade: "best", text: "最佳一手" };
            }
          } else if (!hard.best && best && (best.r !== played.r || best.c !== played.c)) {
            cell = best; // pair a blunder verdict with the recommended move
          }
          analysisVerdict = verdict;
          analysisCell = cell;
          analysisCache.set(i, { cell: cell, verdict: verdict });
          sync();
        })
        .catch(() => {});
    }, 220);
  }

  let confirmResolver = null;

  /**
   * In-app confirm (reliable in WKWebView). Avoids native dialog bridge
   * quirks that made 「新局」 look like a no-op when history was non-empty.
   * @param {string} message
   * @param {string} [title]
   * @param {{ ok?: string, cancel?: string }} [buttons]
   * @returns {Promise<boolean>}
   */
  function confirmNative(message, title, buttons) {
    const okLabel = (buttons && buttons.ok) || "确定";
    const cancelLabel = (buttons && buttons.cancel) || "取消";
    const modal = document.getElementById("confirm-modal");
    const titleEl = document.getElementById("confirm-title");
    const msgEl = document.getElementById("confirm-message");
    const okBtn = document.getElementById("confirm-ok");
    const cancelBtn = document.getElementById("confirm-cancel");
    if (!modal || !okBtn || !cancelBtn) {
      try {
        return Promise.resolve(!!window.confirm(message));
      } catch (_) {
        return Promise.resolve(true);
      }
    }
    if (confirmResolver) {
      confirmResolver(false);
      confirmResolver = null;
    }
    titleEl.textContent = title || "确认";
    msgEl.textContent = message;
    okBtn.textContent = okLabel;
    cancelBtn.textContent = cancelLabel;
    modal.classList.add("show");
    setTimeout(() => okBtn.focus(), 0);
    return new Promise((resolve) => {
      confirmResolver = resolve;
    });
  }

  function finishConfirm(value) {
    const modal = document.getElementById("confirm-modal");
    if (modal) modal.classList.remove("show");
    // Avoid leaving focus on a now-hidden dialog button (can surface off-screen UI).
    try {
      if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
    } catch (_) {}
    if (confirmResolver) {
      const r = confirmResolver;
      confirmResolver = null;
      r(!!value);
    }
  }

  async function requestNewGame() {
    if (history.length) {
      const ok = await confirmNative(
        "开始新局？当前进度会写入存档为新局。",
        "新局",
        { ok: "新局", cancel: "取消" }
      );
      if (!ok) return;
    }
    // reset() bumps gameGen so any in-flight AI timeout cannot place.
    reset();
    toast("新局已开始");
  }

  function applyTheme(id) {
    if (!THEMES[id]) id = "wood";
    themeId = id;
    document.documentElement.setAttribute("data-theme", id);
    saveSettings();
    syncSettingsUI();
    draw();
  }

  function isLive() {
    return viewIndex === history.length;
  }

  /** Board state after the first `n` moves. */


  function setViewIndex(n) {
    viewIndex = Math.max(0, Math.min(n, history.length));
    board = boardAfter(viewIndex);
    winLine = viewIndex > 0 ? winLineAt(viewIndex) : null;
    hoverCell = null;
    clearHint();
    clearVariation();
    scheduleAnalysis();
    sync();
  }

  function goLive() {
    viewIndex = history.length;
    board = boardAfter(history.length);
    if (result === "play") {
      turn = history.length % 2 === 0 ? "b" : "w";
      winLine = null;
    } else {
      winLine = winLineAt(history.length);
    }
    hoverCell = null;
    clearHint();
    clearVariation();
    scheduleAnalysis();
    sync();
  }

  async function requestHint() {
    if (swap2) { toast("开局选择阶段"); return; }
    if (aiThinking || hintBusy) {
      toast("请稍候…");
      return;
    }
    const live = isLive();
    if (live) {
      if (result !== "play") {
        toast("对局已结束");
        return;
      }
      if (importPaused && mode === "ai" && !isHumanTurn()) {
        toast("请先点「续下」");
        return;
      }
      // Hint for the side to move (human's turn in AI mode, or either in pvp)
      if (mode === "ai" && !isHumanTurn()) {
        toast("轮到电脑时无需提示");
        return;
      }
    } else if (winLineAt(viewIndex)) {
      // analysis mode works on any browsed position, except a finished one
      toast("此局面已成五");
      return;
    }
    hintBusy = true;
    hoverCell = null;
    sync();
    const reqView = live ? history.length : viewIndex;
    const side = reqView % 2 === 0 ? "b" : "w";
    const gen = gameGen;
    const histLen = history.length;
    const liveBoard = boardAfter(reqView);
    // pvp has no difficulty knob visible — always hint at full strength there
    const hintDiff = mode === "pvp" ? "hard" : difficulty === "easy" ? "normal" : difficulty;
    // extreme hints would take 5s+; hard-level hints are plenty
    const hintDiff2 = hintDiff === "extreme" ? "hard" : hintDiff;
    try {
      const m = await aiMoveAsync({
        board: liveBoard,
        side: side,
        difficulty: hintDiff2,
        think: thinkLevel,
        timeMs: budgetForDiff(hintDiff2),
      });
      const stillHere =
        gen === gameGen &&
        (live ? histLen === history.length && isLive() : viewIndex === reqView);
      if (!stillHere) {
        // discarded late result (new game / stone placed / view moved)
      } else if (!m) {
        toast("没有可用提示");
        hintCell = null;
      } else {
        hintCell = { r: m.r, c: m.c };
        toast("提示：" + (side === "b" ? "黑" : "白") + " · 虚线十字");
      }
    } catch (_) {
      if (gen === gameGen) {
        toast("提示失败");
        hintCell = null;
      }
    } finally {
      hintBusy = false;
      if (gen === gameGen) sync();
    }
  }









  function toast(msg) {
    const el = document.getElementById("toast");
    el.textContent = msg;
    el.classList.add("show");
    clearTimeout(toast._t);
    toast._t = setTimeout(() => el.classList.remove("show"), 2200);
  }

  function formatDuration(ms) {
    const s = Math.max(0, Math.floor(ms / 1000));
    const m = Math.floor(s / 60);
    const ss = s % 60;
    const h = Math.floor(m / 60);
    if (h > 0) {
      return h + ":" + String(m % 60).padStart(2, "0") + ":" + String(ss).padStart(2, "0");
    }
    return String(m).padStart(2, "0") + ":" + String(ss).padStart(2, "0");
  }

  function formatTime(ts) {
    const d = new Date(ts);
    const p = (n) => String(n).padStart(2, "0");
    return p(d.getMonth() + 1) + "-" + p(d.getDate()) + " " + p(d.getHours()) + ":" + p(d.getMinutes());
  }

  function nowElapsed() {
    if (result !== "play") return elapsedBaseMs;
    return elapsedBaseMs + (Date.now() - startedAt);
  }

  function loadSettings() {
    try {
      const raw = Host.storageGet(SETTINGS_KEY);
      if (!raw) return;
      const s = JSON.parse(raw);
      if (s.mode === "ai" || s.mode === "pvp") mode = s.mode;
      if (
        s.difficulty === "easy" || s.difficulty === "normal" ||
        s.difficulty === "hard" || s.difficulty === "extreme"
      ) difficulty = s.difficulty;
      if (s.humanColor === "b" || s.humanColor === "w") humanColor = s.humanColor;
      if (typeof s.soundOn === "boolean") soundOn = s.soundOn;
      if (s.themeId && THEMES[s.themeId]) themeId = s.themeId;
      if (s.thinkLevel === "fast" || s.thinkLevel === "normal" || s.thinkLevel === "deep") {
        thinkLevel = s.thinkLevel;
      }
      if (typeof s.showCoords === "boolean") showCoords = s.showCoords;
      if (typeof s.analysisOn === "boolean") analysisOn = s.analysisOn;
      if (s.openingRule === "standard" || s.openingRule === "swap2") openingRule = s.openingRule;
    } catch (_) {}
  }

  function saveSettings() {
    Host.storageSet(
      SETTINGS_KEY,
      JSON.stringify({ mode, difficulty, humanColor, soundOn, themeId, thinkLevel, showCoords, analysisOn, openingRule })
    );
  }

  /** True when human may place on the live board (hover preview allowed). */
  function canHoverPlace() {
    if (result !== "play" || !isLive() || aiThinking) return false;
    if (importPaused && mode === "ai" && !isHumanTurn()) return false;
    return isHumanTurn();
  }

  function nextPlaceColor() {
    return history.length % 2 === 0 ? "b" : "w";
  }

  function setHoverFromEvent(ev) {
    if (!canHoverPlace()) {
      if (hoverCell) {
        hoverCell = null;
        draw();
      }
      return;
    }
    const { x, y } = canvasPoint(ev);
    const cell = cellAt(x, y);
    if (!cell || board[cell.r][cell.c]) {
      if (hoverCell) {
        hoverCell = null;
        draw();
      }
      return;
    }
    const color = nextPlaceColor();
    if (
      hoverCell &&
      hoverCell.r === cell.r &&
      hoverCell.c === cell.c &&
      hoverCell.color === color
    ) {
      return;
    }
    hoverCell = { r: cell.r, c: cell.c, color: color };
    draw();
  }

  function clearHover() {
    if (!hoverCell) return;
    hoverCell = null;
    draw();
  }

  function ensureAudio() {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === "suspended") audioCtx.resume();
    return audioCtx;
  }

  /** Cached short white-noise buffer — reused for every stone's "clack". */
  let noiseBuf = null;
  function noiseBuffer(ctx) {
    if (noiseBuf) return noiseBuf;
    const n = Math.floor(ctx.sampleRate * 0.06);
    noiseBuf = ctx.createBuffer(1, n, ctx.sampleRate);
    const d = noiseBuf.getChannelData(0);
    let seed = 0x2545f491; // deterministic — no Math.random needed
    for (let i = 0; i < n; i++) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      d[i] = (seed / 0x40000000 - 1) * (1 - i / n); // fade toward silence
    }
    return noiseBuf;
  }

  // A stone on a wooden board is a percussive click (bandpassed noise) plus a
  // short woody body resonance — far more tactile than a bare sine beep.
  function playMoveSound(color) {
    if (!soundOn) return;
    try {
      const ctx = ensureAudio();
      const t0 = ctx.currentTime;
      // 1) the clack: brief bandpassed noise burst
      const src = ctx.createBufferSource();
      src.buffer = noiseBuffer(ctx);
      const bp = ctx.createBiquadFilter();
      bp.type = "bandpass";
      bp.frequency.value = color === "b" ? 1900 : 2300;
      bp.Q.value = 0.9;
      const ng = ctx.createGain();
      ng.gain.setValueAtTime(0.22, t0);
      ng.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.05);
      src.connect(bp); bp.connect(ng); ng.connect(ctx.destination);
      src.start(t0); src.stop(t0 + 0.06);
      // 2) the body: fast-decaying woody tone, black lower than white
      const osc = ctx.createOscillator();
      const g = ctx.createGain();
      osc.type = "triangle";
      osc.frequency.setValueAtTime(color === "b" ? 250 : 340, t0);
      osc.frequency.exponentialRampToValueAtTime(color === "b" ? 180 : 250, t0 + 0.08);
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(0.1, t0 + 0.008);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.12);
      osc.connect(g); g.connect(ctx.destination);
      osc.start(t0); osc.stop(t0 + 0.13);
    } catch (_) {}
  }

  function playWinSound() {
    if (!soundOn) return;
    try {
      const ctx = ensureAudio();
      // rising major arpeggio, then a soft sustained chord to land on
      const arp = [523.25, 659.25, 783.99, 1046.5];
      arp.forEach((f, i) => {
        const t0 = ctx.currentTime + i * 0.085;
        const osc = ctx.createOscillator();
        const g = ctx.createGain();
        osc.type = "triangle";
        osc.frequency.value = f;
        g.gain.setValueAtTime(0.0001, t0);
        g.gain.exponentialRampToValueAtTime(0.11, t0 + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.24);
        osc.connect(g); g.connect(ctx.destination);
        osc.start(t0); osc.stop(t0 + 0.26);
      });
      const tc = ctx.currentTime + arp.length * 0.085 + 0.02;
      [523.25, 659.25, 783.99].forEach((f) => {
        const osc = ctx.createOscillator();
        const g = ctx.createGain();
        osc.type = "sine";
        osc.frequency.value = f;
        g.gain.setValueAtTime(0.0001, tc);
        g.gain.exponentialRampToValueAtTime(0.06, tc + 0.04);
        g.gain.exponentialRampToValueAtTime(0.0001, tc + 0.6);
        osc.connect(g); g.connect(ctx.destination);
        osc.start(tc); osc.stop(tc + 0.64);
      });
    } catch (_) {}
  }

  /** Point users at real macOS window chrome — not web Fullscreen API. */
  function toggleFullscreen() {
    toast("全屏：菜单 View → Enter Full Screen（⌘⌃F）· 放大：窗口绿键 Zoom");
  }

  function serialize() {
    return {
      v: 3,
      board,
      turn,
      result,
      mode,
      difficulty,
      humanColor,
      history,
      winLine,
      startedAt,
      elapsedBaseMs: nowElapsed(),
      originalStartedAt,
      importPaused: !!importPaused,
      savedAt: Date.now(),
    };
  }

  function saveGame() {
    try {
      Host.storageSet(SAVE_KEY, JSON.stringify(serialize()));
      const hint = document.getElementById("save-hint");
      if (hint) hint.textContent = "已存 " + formatTime(Date.now());
    } catch (_) {}
  }

  function clearSave() {
    Host.storageRemove(SAVE_KEY);
    Host.storageRemove("goban.v11.save");
    const hint = document.getElementById("save-hint");
    if (hint) hint.textContent = "无存档";
  }

  /**
   * Load a parsed snapshot (from autosave or a named slot) into live game
   * state. Recomputes result/win-line from history — stale save fields are
   * never trusted. @returns {boolean} true when applied.
   */
  function applySnapshot(s) {
    if (!s || (s.v !== 1 && s.v !== 2 && s.v !== 3)) return false;
    // Resume only with a move list — board-only snapshots cannot place safely.
    const loadedHistory = Array.isArray(s.history) ? s.history : [];
    if (!loadedHistory.length) return false;
    // Validate move coords (strict: `undefined < 0` is false, so type-check too)
    for (let i = 0; i < loadedHistory.length; i++) {
      const p = loadedHistory[i];
      if (
        !p ||
        !Number.isInteger(p.r) ||
        !Number.isInteger(p.c) ||
        p.r < 0 || p.r >= SIZE || p.c < 0 || p.c >= SIZE
      ) return false;
    }
    history = loadedHistory;
    mode = s.mode === "pvp" ? "pvp" : "ai";
    difficulty = s.difficulty || "normal";
    humanColor = s.humanColor === "w" ? "w" : "b";
    viewIndex = history.length;
    board = boardAfter(history.length);
    // Recompute result / win line from history (do not trust stale save fields)
    turn = history.length % 2 === 0 ? "b" : "w";
    result = "play";
    winLine = null;
    if (history.length) {
      const last = history[history.length - 1];
      const lastColor = (history.length - 1) % 2 === 0 ? "b" : "w";
      const line = Core.findWin(board, last.r, last.c, lastColor);
      if (line) {
        result = lastColor;
        winLine = line;
      } else if (Core.boardFull(board)) {
        result = "draw";
      }
    }
    elapsedBaseMs = typeof s.elapsedBaseMs === "number" ? s.elapsedBaseMs : 0;
    originalStartedAt = typeof s.originalStartedAt === "number"
      ? s.originalStartedAt
      : (Date.now() - elapsedBaseMs);
    startedAt = Date.now();
    // v3+: restore import pause so AI does not auto-continue after import-only save.
    importPaused = s.v >= 3 && !!s.importPaused && result === "play";
    hoverCell = null;
    clearHint();
    return true;
  }

  function tryLoadSave() {
    try {
      const raw = Host.storageGet(SAVE_KEY) || Host.storageGet("goban.v11.save");
      if (!raw) return false;
      return applySnapshot(JSON.parse(raw));
    } catch (_) {
      return false;
    }
  }

  // --- named save slots (manual, alongside the single autosave) ---
  function loadSlots() {
    try {
      const raw = Host.storageGet(SLOTS_KEY);
      if (!raw) return [];
      const arr = JSON.parse(raw);
      return Array.isArray(arr) ? arr.filter((s) => s && s.snap) : [];
    } catch (_) {
      return [];
    }
  }

  function persistSlots(arr) {
    try {
      Host.storageSet(SLOTS_KEY, JSON.stringify(arr.slice(0, SLOTS_MAX)));
    } catch (_) {}
  }

  function resultLabel(r) {
    return r === "b" ? "黑胜" : r === "w" ? "白胜" : r === "draw" ? "平局" : "进行中";
  }

  function slotDate(ts) {
    const d = new Date(ts || Date.now());
    const p = (n) => String(n).padStart(2, "0");
    return p(d.getMonth() + 1) + "-" + p(d.getDate()) + " " + p(d.getHours()) + ":" + p(d.getMinutes());
  }

  function slotMetaText(snap) {
    const moves = (snap.history && snap.history.length) || 0;
    return moves + "手 · " + resultLabel(snap.result) + " · " + slotDate(snap.savedAt);
  }

  function genSlotId() {
    return Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 6);
  }

  /** Save the current game as a new named slot. */
  function saveCurrentAsSlot() {
    if (!history.length) { toast("当前没有可保存的对局"); return; }
    const snap = serialize();
    const slot = {
      id: genSlotId(),
      name: "对局 " + slotDate(Date.now()),
      savedAt: Date.now(),
      snap,
    };
    const arr = loadSlots();
    arr.unshift(slot);
    persistSlots(arr);
    renderSlots();
    toast("已保存到存档");
  }

  async function loadSlotById(id) {
    const arr = loadSlots();
    const slot = arr.find((s) => s.id === id);
    if (!slot) return;
    if (history.length &&
        !(await confirmNative("读取存档将替换当前对局，是否继续？", "读取存档", { ok: "读取", cancel: "取消" }))) {
      return;
    }
    if (!applySnapshot(slot.snap)) { toast("存档已损坏，无法读取"); return; }
    gameGen += 1;
    clearAnalysis();
    closeSlots();
    sync();
    saveGame();
    maybeAiTurn();
    toast("已读取存档");
  }

  async function deleteSlotById(id) {
    const arr = loadSlots();
    const slot = arr.find((s) => s.id === id);
    if (!slot) return;
    if (!(await confirmNative("删除存档「" + slot.name + "」？", "删除存档", { ok: "删除", cancel: "取消" }))) {
      return;
    }
    persistSlots(arr.filter((s) => s.id !== id));
    renderSlots();
    toast("存档已删除");
  }

  function renameSlot(id, name) {
    const arr = loadSlots();
    const slot = arr.find((s) => s.id === id);
    if (!slot) return;
    const clean = (name || "").trim().slice(0, 40);
    slot.name = clean || ("对局 " + slotDate(slot.savedAt));
    persistSlots(arr);
  }

  function renderSlots() {
    const list = document.getElementById("slots-list");
    const empty = document.getElementById("slots-empty");
    if (!list) return;
    const arr = loadSlots();
    if (empty) empty.hidden = arr.length > 0;
    list.innerHTML = "";
    for (const slot of arr) {
      const row = document.createElement("div");
      row.className = "slot-row";
      row.dataset.id = slot.id;
      const nameEl = document.createElement("input");
      nameEl.className = "slot-name";
      nameEl.value = slot.name;
      nameEl.maxLength = 40;
      nameEl.setAttribute("aria-label", "存档名");
      const meta = document.createElement("div");
      meta.className = "slot-meta";
      meta.textContent = slotMetaText(slot.snap);
      const ops = document.createElement("div");
      ops.className = "slot-ops";
      ops.innerHTML =
        '<button type="button" class="text-link slot-load" data-id="' + slot.id + '">读取</button>' +
        '<button type="button" class="text-link danger slot-del" data-id="' + slot.id + '">删除</button>';
      row.appendChild(nameEl);
      row.appendChild(meta);
      row.appendChild(ops);
      list.appendChild(row);
    }
  }

  function openSlots() {
    renderSlots();
    const m = document.getElementById("slots-modal");
    if (m) m.classList.add("show");
  }

  function closeSlots() {
    const m = document.getElementById("slots-modal");
    if (m) m.classList.remove("show");
  }

  // --- whole-game review (复盘 2.0): eval curve + blunder list ---
  const REVIEW_SQUASH = 1200;   // static-eval scale → tanh spread
  const REVIEW_BLUNDER_DROP = 0.3; // squashed-advantage loss that flags a mistake
  let reviewData = null;

  /** Signed advantage from Black's perspective at ply i, squashed to [-1,1]. */
  function advAt(i) {
    if (i > 0 && winLineAt(i)) return (i - 1) % 2 === 0 ? 1 : -1; // someone just won
    const raw = Ai.evaluateBoard(boardAfter(i), "b");
    return Math.tanh(raw / REVIEW_SQUASH);
  }

  /** Analyze the whole game: per-ply Black-advantage + flagged blunders. */
  function computeReview() {
    const N = history.length;
    const adv = [];
    for (let i = 0; i <= N; i++) adv.push(advAt(i));
    const blunders = [];
    let bCount = 0, wCount = 0;
    for (let i = 1; i <= N; i++) {
      const color = (i - 1) % 2 === 0 ? "b" : "w";
      const hard = coachFacts(boardAfter(i - 1), color, history[i - 1]);
      let reason = null;
      if (hard && hard.grade === "blunder") reason = hard.text;
      else {
        // advantage from the mover's own perspective before vs after
        const before = color === "b" ? adv[i - 1] : -adv[i - 1];
        const after = color === "b" ? adv[i] : -adv[i];
        if (before - after >= REVIEW_BLUNDER_DROP) reason = "评分下滑";
      }
      if (reason) {
        blunders.push({ i, color, reason });
        if (color === "b") bCount++; else wCount++;
      }
    }
    reviewData = { adv, blunders, summary: { b: bCount, w: wCount } };
    return reviewData;
  }

  function drawReviewCurve() {
    const cv = document.getElementById("review-curve");
    if (!cv || !reviewData) return;
    const dpr = window.devicePixelRatio || 1;
    const cssW = cv.clientWidth || 320;
    const cssH = cv.clientHeight || 96;
    cv.width = Math.round(cssW * dpr);
    cv.height = Math.round(cssH * dpr);
    const g = cv.getContext("2d");
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, cssW, cssH);
    const adv = reviewData.adv;
    const n = adv.length;
    const pad = 6;
    const w = cssW - pad * 2;
    const h = cssH - pad * 2;
    const x = (i) => pad + (n <= 1 ? 0 : (i / (n - 1)) * w);
    const y = (v) => pad + (1 - (v + 1) / 2) * h; // +1 top (black), −1 bottom (white)
    const css = getComputedStyle(document.documentElement);
    const line = css.getPropertyValue("--accent").trim() || "#3b82f6";
    const mid = css.getPropertyValue("--card-border").trim() || "#ccc";
    // zero (even) midline
    g.strokeStyle = mid; g.lineWidth = 1;
    g.beginPath(); g.moveTo(pad, y(0)); g.lineTo(pad + w, y(0)); g.stroke();
    // advantage area
    g.beginPath();
    g.moveTo(x(0), y(adv[0]));
    for (let i = 1; i < n; i++) g.lineTo(x(i), y(adv[i]));
    g.lineTo(x(n - 1), y(0)); g.lineTo(x(0), y(0)); g.closePath();
    g.fillStyle = (line || "#3b82f6") + "22";
    g.fill();
    // advantage line
    g.beginPath();
    g.moveTo(x(0), y(adv[0]));
    for (let i = 1; i < n; i++) g.lineTo(x(i), y(adv[i]));
    g.strokeStyle = line; g.lineWidth = 1.8; g.lineJoin = "round";
    g.stroke();
    // blunder dots
    for (const b of reviewData.blunders) {
      g.beginPath();
      g.arc(x(b.i), y(adv[b.i]), 3, 0, Math.PI * 2);
      g.fillStyle = css.getPropertyValue("--win").trim() || "#c0392b";
      g.fill();
    }
    // current view marker
    if (viewIndex >= 0 && viewIndex < n) {
      g.strokeStyle = line; g.globalAlpha = 0.4; g.lineWidth = 1;
      g.beginPath(); g.moveTo(x(viewIndex), pad); g.lineTo(x(viewIndex), pad + h); g.stroke();
      g.globalAlpha = 1;
    }
  }

  function reviewJump(i) {
    setViewIndex(i);
    closeReview();
  }

  function renderReview() {
    const empty = document.getElementById("review-empty");
    const body = document.getElementById("review-body");
    if (history.length < 2) {
      if (empty) empty.hidden = false;
      if (body) body.hidden = true;
      return;
    }
    computeReview();
    if (empty) empty.hidden = true;
    if (body) body.hidden = false;
    const stat = document.getElementById("review-stat");
    if (stat) {
      const s = reviewData.summary;
      stat.textContent = "失着 · 黑 " + s.b + " · 白 " + s.w +
        (s.b + s.w === 0 ? " · 双方无明显失误" : "");
    }
    const list = document.getElementById("review-blunders");
    if (list) {
      list.innerHTML = "";
      if (!reviewData.blunders.length) {
        const p = document.createElement("div");
        p.className = "muted review-none";
        p.textContent = "没有检出明显失着 👍";
        list.appendChild(p);
      }
      for (const b of reviewData.blunders) {
        const row = document.createElement("button");
        row.type = "button";
        row.className = "review-blunder-row";
        row.dataset.i = b.i;
        const who = b.color === "b" ? "黑" : "白";
        row.innerHTML =
          '<span class="rb-move">第' + b.i + '手 ' + who + '</span>' +
          '<span class="rb-reason">' + b.reason + '</span>';
        list.appendChild(row);
      }
    }
    // draw after layout so clientWidth is real
    requestAnimationFrame(drawReviewCurve);
  }

  function openReview() {
    renderReview();
    const m = document.getElementById("review-modal");
    if (m) m.classList.add("show");
  }

  function closeReview() {
    const m = document.getElementById("review-modal");
    if (m) m.classList.remove("show");
  }

  /** SGF with per-move 失着 comments + a summary root comment (复盘评注导出). */
  function buildAnnotatedSgf() {
    computeReview();
    const comments = {};
    for (const b of reviewData.blunders) comments[b.i - 1] = "失着 · " + b.reason;
    const s = reviewData.summary;
    const rootComment =
      "复盘评注 · 失着 黑" + s.b + " 白" + s.w +
      (s.b + s.w === 0 ? "（双方无明显失误）" : "") +
      " · 共" + history.length + "手";
    return SgfMod.buildSgf({
      history, result, mode, humanColor, originalStartedAt,
      comments, rootComment,
    });
  }

  async function exportReviewSgf() {
    if (history.length < 2) { toast("对局太短，无可评注内容"); return; }
    await exportSgfString(buildAnnotatedSgf(), "review-" + sgfFileName());
  }

  // --- principal-variation preview (主变推演) ---
  const PV_PLIES = 6;
  const PV_NODE_BUDGET = 6000; // deterministic per-ply cap → snappy, repeatable
  let variationCells = null; // [{r,c,color,n}] | null

  function clearVariation() {
    if (variationCells) { variationCells = null; }
  }

  /** Engine's best line forward from ply `fromIndex`, as ghost stones. */
  function computePV(fromIndex) {
    if (fromIndex > 0 && winLineAt(fromIndex)) return []; // already decided
    const bd = boardAfter(fromIndex);
    if (Core.boardFull(bd)) return [];
    let side = fromIndex % 2 === 0 ? "b" : "w";
    const pv = [];
    for (let k = 0; k < PV_PLIES; k++) {
      const mv = Ai.aiMove({ board: bd, side: side, difficulty: "hard", nodeBudget: PV_NODE_BUDGET });
      if (!mv || bd[mv.r][mv.c]) break;
      bd[mv.r][mv.c] = side;
      pv.push({ r: mv.r, c: mv.c, color: side, n: k + 1 });
      if (Core.findWin(bd, mv.r, mv.c, side)) break; // line reaches a five
      side = opp(side);
    }
    return pv;
  }

  function runVariation() {
    const pv = computePV(viewIndex);
    variationCells = pv.length ? pv : null;
    closeReview();
    sync();
    toast(pv.length ? "推演 " + pv.length + " 手（虚影）" : "此局面无可推演着法");
  }

  let panelAnimUntil = 0;
  let panelAnimActive = false;

  function isPanelOpen() {
    return appEl.classList.contains("panel-open");
  }

  function setPanelOpen(open) {
    const want = !!open;
    const was = isPanelOpen();
    appEl.classList.toggle("panel-open", want);
    appEl.classList.toggle("scrim-on", want && window.innerWidth < 900);
    Host.storageSet(PANEL_KEY, want ? "1" : "0");
    // Keep closed sidebar out of tab order / a11y tree (also stops focus-driven reveals).
    const side = document.getElementById("side");
    if (side) {
      if (want) {
        side.removeAttribute("inert");
        side.setAttribute("aria-hidden", "false");
      } else {
        side.setAttribute("inert", "");
        side.setAttribute("aria-hidden", "true");
        // Drop focus that may sit on a control inside the off-screen panel.
        if (side.contains(document.activeElement) && document.activeElement.blur) {
          document.activeElement.blur();
        }
      }
    }
    // Follow the .28s CSS layout transition frame-by-frame, then settle —
    // a single mid-transition resize left the canvas at a stale size.
    panelAnimUntil = performance.now() + 340;
    if (!panelAnimActive) {
      panelAnimActive = true;
      const tick = () => {
        resizeCanvas();
        draw();
        if (performance.now() < panelAnimUntil) requestAnimationFrame(tick);
        else {
          panelAnimActive = false;
          // After open animation, scroll move list without using scrollIntoView on page.
          if (want) scrollMoveListToCurrent();
        }
      };
      requestAnimationFrame(tick);
    } else if (want && !was) {
      // Already animating; still schedule list scroll after settle.
      setTimeout(() => {
        if (isPanelOpen()) scrollMoveListToCurrent();
      }, 320);
    }
  }

  function togglePanel() {
    setPanelOpen(!isPanelOpen());
  }

  /** Scroll #move-list only — never element.scrollIntoView (pulls closed panel into view in WKWebView). */
  function scrollMoveListToCurrent() {
    const el = document.getElementById("move-list");
    if (!el || !isPanelOpen()) return;
    const cur = el.querySelector("button.cur");
    if (!cur) return;
    const listH = el.clientHeight;
    if (listH <= 0) return;
    const top = cur.offsetTop - listH / 2 + cur.offsetHeight / 2;
    el.scrollTop = Math.max(0, Math.min(top, el.scrollHeight - listH));
  }

  Draw.attach(canvas, ctx, () => ({
    board: board,
    history: history,
    viewIndex: viewIndex,
    themeId: themeId,
    placeAnim: placeAnim,
    winLine: winLine,
    winFlashUntil: winFlashUntil,
    hover: hoverCell,
    hint: hintCell,
    analysis: analysisCell,
    variation: variationCells,
    coords: showCoords,
    clearPlaceAnim: () => { placeAnim = null; },
  }));

  function resizeCanvas() { Draw.resizeCanvas(); }
  function cellAt(x, y) { return Draw.cellAt(x, y); }
  function draw() { Draw.draw(); }
  function ensureAnimLoop() { Draw.ensureAnimLoop(); }

  function isHumanTurn() {
    if (mode === "pvp") return true;
    return turn === humanColor;
  }

  function maybeAiTurn() {
    if (importPaused || swap2) return;
    if (mode !== "ai" || result !== "play" || isHumanTurn() || aiThinking) return;
    aiThinking = true;
    hoverCell = null;
    clearHint();
    const gen = gameGen;
    sync();
    // Perceived pacing: instant forced replies read as "didn't think" and
    // jolt the rhythm — keep a small floor even when compute is fast.
    const delay =
      difficulty === "hard" || difficulty === "extreme"
        ? 320
        : difficulty === "normal" ? 240 : 160;
    const t0 = performance.now();
    aiMoveAsync({
      board: boardAfter(history.length),
      humanColor: humanColor,
      difficulty: difficulty,
      think: thinkLevel,
      timeMs: budgetForDiff(difficulty),
    }).then((m) => {
      if (gen !== gameGen) return;
      const spent = performance.now() - t0;
      const wait = Math.max(0, delay - spent);
      setTimeout(() => {
        if (gen !== gameGen) return;
        aiThinking = false;
        if (m) place(m.r, m.c, true);
        else sync();
      }, wait);
    }).catch(() => {
      if (gen !== gameGen) return;
      aiThinking = false;
      // fallback sync path
      const m = aiMoveSync({ humanColor: humanColor, difficulty: difficulty });
      if (m) place(m.r, m.c, true);
      else sync();
    });
  }

  // --- swap2 balanced opening ---
  function startSwap2() {
    swap2 = { phase: "place" };
    renderSwap2Bar();
  }

  function hideSwap2Bar() {
    const bar = document.getElementById("swap2-bar");
    if (bar) bar.hidden = true;
  }

  function renderSwap2Bar() {
    const bar = document.getElementById("swap2-bar");
    const msg = document.getElementById("swap2-msg");
    const btns = document.getElementById("swap2-btns");
    if (!bar || !msg || !btns) return;
    if (!swap2) { bar.hidden = true; return; }
    if (swap2.phase === "place" || swap2.phase === "place2") {
      const target = swap2.phase === "place" ? 3 : 5;
      btns.innerHTML = "";
      msg.textContent = "平衡开局 · 请落第 " + (history.length + 1) + " 子（共 " + target + "）";
      bar.hidden = false;
      return;
    }
    let items;
    if (swap2.phase === "p2choose") {
      msg.textContent = "开局已布 3 子 · 由你选择：";
      items = [["black", "执黑"], ["white", "执白"], ["add2", "加两手"]];
    } else { // p1choose
      msg.textContent = "对手已加两手 · 请选择执子：";
      items = [["black", "执黑"], ["white", "执白"]];
    }
    btns.innerHTML = "";
    for (const it of items) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "swap2-btn";
      b.dataset.kind = it[0];
      b.textContent = it[1];
      btns.appendChild(b);
    }
    bar.hidden = false;
  }

  /** Lay one opening stone (strictly alternating by parity). */
  function swap2PlaceStone(r, c, fromAi) {
    if (!swap2) return;
    if (fromAi) return; // AI's 加两手 stones are placed programmatically
    board = boardAfter(history.length);
    if (board[r][c]) return;
    const color = history.length % 2 === 0 ? "b" : "w";
    board[r][c] = color;
    history.push({ r: r, c: c });
    viewIndex = history.length;
    hoverCell = null;
    placeAnim = { r: r, c: c, t0: performance.now() };
    ensureAnimLoop();
    playMoveSound(color);
    const target = swap2.phase === "place" ? 3 : 5;
    if (history.length >= target) {
      swap2.phase = swap2.phase === "place" ? "p2choose" : "p1choose";
      if (swap2.phase === "p2choose" && mode === "ai") {
        renderSwap2Bar();
        sync();
        setTimeout(aiSwap2Choose, 350); // AI (P2) decides its side
        return;
      }
    }
    renderSwap2Bar();
    sync();
  }

  /** AI (P2) takes whichever side its static eval values higher. */
  function aiSwap2Choose() {
    if (!swap2 || swap2.phase !== "p2choose") return;
    const bd = boardAfter(history.length);
    const evalB = Ai.evaluateBoard(bd, "b");
    const evalW = Ai.evaluateBoard(bd, "w");
    const aiTakesWhite = evalW >= evalB; // white also moves next → tempo
    toast(aiTakesWhite ? "电脑选择执白" : "电脑选择执黑");
    settleSwap2(aiTakesWhite ? "b" : "w"); // human gets the other side
  }

  /** Human clicked a swap2 choice button. */
  function swap2Choose(kind) {
    if (!swap2) return;
    if (swap2.phase === "p2choose") {
      if (kind === "add2") {
        swap2.phase = "place2";
        renderSwap2Bar();
        sync();
        return;
      }
      const p2Color = kind === "black" ? "b" : "w";
      settleSwap2(opp(p2Color)); // P1 (human, in AI mode) gets the opposite side
      return;
    }
    if (swap2.phase === "p1choose") {
      settleSwap2(kind === "black" ? "b" : "w"); // P1 chooses own side
    }
  }

  function settleSwap2(humanColorAfter) {
    if (mode === "ai") humanColor = humanColorAfter;
    swap2 = null;
    hideSwap2Bar();
    turn = history.length % 2 === 0 ? "b" : "w"; // white to move after opening
    result = "play";
    winLine = null;
    viewIndex = history.length;
    board = boardAfter(history.length);
    saveGame();
    sync();
    maybeAiTurn();
  }

  function place(r, c, fromAi) {
    if (swap2) {
      if (swap2.phase === "place" || swap2.phase === "place2") swap2PlaceStone(r, c, fromAi);
      return; // choice phases: board clicks do nothing
    }
    if (result !== "play") return;
    if (!isLive()) {
      if (!fromAi) {
        toast("请先「回到最新一手」再落子");
        return;
      }
      // AI reply landed while the user browses the replay: snap to live and
      // apply it — dropping the move would deadlock the game (AI never re-fires).
      viewIndex = history.length;
    }
    // live board must match full history
    board = boardAfter(history.length);
    turn = history.length % 2 === 0 ? "b" : "w";
    if (board[r][c]) return;
    if (!fromAi && !isHumanTurn()) return;
    // Human/AI place ends import pause
    if (importPaused) importPaused = false;

    board[r][c] = turn;
    history.push({ r, c });
    viewIndex = history.length;
    hoverCell = null;
    clearHint();
    clearAnalysis();
    clearVariation();
    placeAnim = { r, c, t0: performance.now() };
    ensureAnimLoop();
    playMoveSound(turn);
    const line = findWin(r, c, turn);
    if (line) {
      result = turn;
      winLine = line;
      elapsedBaseMs = nowElapsed();
      startedAt = Date.now();
      playWinSound();
      triggerWinFlash();
      ensureAnimLoop();
      sync();
      saveGame();
      return;
    }
    if (boardFull()) {
      result = "draw";
      winLine = null;
      elapsedBaseMs = nowElapsed();
      startedAt = Date.now();
      sync();
      saveGame();
      return;
    }
    turn = opp(turn);
    winLine = null;
    sync();
    saveGame();
    maybeAiTurn();
  }

  function undo() {
    if (swap2) return; // no undo mid-opening
    if (!history.length || aiThinking || hintBusy) return;
    // Always return to the live tip before undoing moves.
    if (!isLive()) {
      goLive();
    }
    if (mode === "ai") {
      // Pop until it is the human's turn again (undo AI reply + human move).
      do {
        history.pop();
      } while (history.length && (history.length % 2 === 0 ? "b" : "w") !== humanColor);
    } else {
      history.pop();
    }
    turn = history.length % 2 === 0 ? "b" : "w";
    result = "play";
    winLine = null;
    placeAnim = null;
    clearHint();
    clearAnalysis();
    clearVariation();
    hoverCell = null;
    importPaused = false;
    viewIndex = history.length;
    board = boardAfter(history.length);
    sync();
    saveGame();
    // e.g. human plays white: undo to empty → black (AI) must move
    maybeAiTurn();
  }

  function reset(opts) {
    gameGen += 1;
    board = emptyBoard();
    turn = "b";
    result = "play";
    history = [];
    winLine = null;
    viewIndex = 0;
    elapsedBaseMs = 0;
    startedAt = Date.now();
    originalStartedAt = startedAt;
    aiThinking = false;
    placeAnim = null;
    importPaused = false;
    hoverCell = null;
    clearHint();
    clearAnalysis();
    clearVariation();
    swap2 = null;
    if (openingRule === "swap2") startSwap2();
    saveSettings();
    sync();
    saveGame();
    maybeAiTurn();
  }

  /** Sidebar move list: rebuilt when moves change, highlight follows view. */
  let mlSig = "";
  function renderMoveList() {
    const el = document.getElementById("move-list");
    if (!el) return;
    const last = history.length ? history[history.length - 1] : null;
    const sig = history.length + ":" + (last ? last.r + "," + last.c : "") + ":" + gameGen;
    if (sig !== mlSig) {
      mlSig = sig;
      let html = "";
      for (let i = 0; i < history.length; i++) {
        const p = history[i];
        const lab = String.fromCharCode(65 + p.c) + (SIZE - p.r);
        // tabindex=-1: list is navigated by click / replay keys, not Tab-steal from board
        html +=
          '<button type="button" tabindex="-1" data-i="' +
          (i + 1) +
          '">' +
          (i + 1) +
          ". " +
          lab +
          "</button>";
      }
      el.innerHTML = html;
    }
    const btns = el.children;
    for (let i = 0; i < btns.length; i++) {
      btns[i].classList.toggle("cur", i + 1 === viewIndex);
    }
    // Only adjust scroll when the panel is actually open. scrollIntoView on an
    // off-screen (translateX(100%)) button makes WKWebView yank the sidebar
    // partially into view every move — the "auto pop incomplete panel" bug.
    if (isPanelOpen()) scrollMoveListToCurrent();
  }

  function updateClock() {
    const el = formatDuration(nowElapsed());
    const c1 = document.getElementById("clock");
    const c2 = document.getElementById("info-time");
    if (c1) c1.textContent = el;
    if (c2) c2.textContent = el;
  }

  function syncSettingsUI() {
    document.querySelectorAll("#mode-seg button").forEach((b) => {
      b.classList.toggle("active", b.dataset.mode === mode);
    });
    document.querySelectorAll("#diff-seg button").forEach((b) => {
      b.classList.toggle("active", b.dataset.diff === difficulty);
    });
    document.querySelectorAll("#think-seg button").forEach((b) => {
      b.classList.toggle("active", b.dataset.think === thinkLevel);
    });
    document.querySelectorAll("#color-seg button").forEach((b) => {
      b.classList.toggle("active", b.dataset.human === humanColor);
    });
    document.querySelectorAll("#theme-seg button").forEach((b) => {
      b.classList.toggle("active", b.dataset.theme === themeId);
    });
    document.querySelectorAll("#opening-seg button").forEach((b) => {
      b.classList.toggle("active", b.dataset.opening === openingRule);
    });
    const aiOnly = mode === "ai";
    const diffField = document.getElementById("diff-field");
    const thinkField = document.getElementById("think-field");
    const colorField = document.getElementById("color-field");
    if (diffField) diffField.hidden = !aiOnly;
    if (thinkField) {
      thinkField.hidden = !(aiOnly && (difficulty === "hard" || difficulty === "extreme"));
    }
    // swap2 decides the human's color via the opening protocol, so hide 执子 then
    if (colorField) colorField.hidden = !aiOnly || openingRule === "swap2";
    const sbOn = document.getElementById("opt-sound");
    if (sbOn) {
      sbOn.classList.toggle("active", soundOn);
      sbOn.setAttribute("aria-pressed", soundOn ? "true" : "false");
    }
    const cdOn = document.getElementById("opt-coords");
    if (cdOn) {
      cdOn.classList.toggle("active", showCoords);
      cdOn.setAttribute("aria-pressed", showCoords ? "true" : "false");
    }
    const anOn = document.getElementById("opt-analysis");
    if (anOn) {
      anOn.classList.toggle("active", analysisOn);
      anOn.setAttribute("aria-pressed", analysisOn ? "true" : "false");
    }
  }

  function sync() {
    draw();
    const status = document.getElementById("status");
    const moves = document.getElementById("moves");
    const blackTurn = document.getElementById("black-turn");
    const whiteTurn = document.getElementById("white-turn");
    const undoBtns = [document.getElementById("undo"), document.getElementById("undo2")].filter(Boolean);
    const live = isLive();

    moves.textContent = viewIndex + "/" + history.length;
    document.getElementById("info-moves").textContent =
      history.length + (live ? "" : "·看" + viewIndex);
    const modeEl = document.getElementById("info-mode");
    if (modeEl) {
      modeEl.textContent = mode === "pvp"
        ? "双人"
        : ({ easy: "简单", normal: "普通", hard: "困难", extreme: "极难" }[difficulty] || difficulty);
    }
    document.getElementById("replay-pos").textContent = viewIndex + " / " + history.length;
    const verdictEl = document.getElementById("coach-verdict");
    if (verdictEl) {
      const show = analysisOn && !live && analysisVerdict;
      verdictEl.hidden = !show;
      if (show) {
        const who = (viewIndex - 1) % 2 === 0 ? "黑" : "白";
        verdictEl.textContent = "第" + viewIndex + "手 " + who + "：" + analysisVerdict.text;
        verdictEl.className = "coach-verdict grade-" + (analysisVerdict.grade || "ok");
      }
    }
    renderMoveList();
    updateClock();

    undoBtns.forEach((b) => {
      if (b) b.disabled = history.length === 0 || aiThinking || hintBusy || !live;
    });
    document.getElementById("rep-start").disabled = viewIndex <= 0;
    document.getElementById("rep-prev").disabled = viewIndex <= 0;
    document.getElementById("rep-next").disabled = viewIndex >= history.length;
    document.getElementById("rep-end").disabled = viewIndex >= history.length;
    document.getElementById("rep-live").disabled = live;
    document.getElementById("sgf-copy").disabled = history.length === 0;
    document.getElementById("sgf-download").disabled = history.length === 0;
    const contBtn = document.getElementById("sgf-continue");
    if (contBtn) {
      const showCont = importPaused && result === "play" && history.length > 0;
      contBtn.hidden = !showCont;
      contBtn.disabled = !showCont || aiThinking;
    }
    const hintBtn = document.getElementById("btn-hint");
    if (hintBtn) {
      const canHint =
        !aiThinking &&
        !hintBusy &&
        (isLive()
          ? result === "play" && !(mode === "ai" && !isHumanTurn())
          : true);
      hintBtn.disabled = !canHint;
      hintBtn.classList.toggle("busy", hintBusy);
    }

    if (mode === "ai") {
      document.getElementById("black-role").textContent = humanColor === "b" ? "你" : "电脑";
      document.getElementById("white-role").textContent = humanColor === "w" ? "你" : "电脑";
    } else {
      document.getElementById("black-role").textContent = "玩家 1";
      document.getElementById("white-role").textContent = "玩家 2";
    }

    const showTurn = live && result === "play";
    blackTurn.hidden = !(showTurn && turn === "b");
    whiteTurn.hidden = !(showTurn && turn === "w");

    const thinkDot = document.getElementById("think-dot");
    if (thinkDot) thinkDot.hidden = !(aiThinking && result === "play");

    status.classList.toggle("win", live && (result === "b" || result === "w"));
    status.classList.toggle("thinking", live && result === "play" && aiThinking);
    status.classList.toggle("replay", !live);
    if (swap2) {
      status.textContent =
        swap2.phase === "place" || swap2.phase === "place2"
          ? "平衡开局 · 布子中"
          : "平衡开局 · 待选边";
    } else if (!live) {
      status.textContent = "复盘 " + viewIndex + "/" + history.length;
      if (winLine) status.textContent += " · 已成五";
    } else if (result === "b") status.textContent = "黑棋胜";
    else if (result === "w") status.textContent = "白棋胜";
    else if (result === "draw") status.textContent = "平局";
    else if (importPaused) {
      status.textContent =
        mode === "ai" && !isHumanTurn()
          ? "导入复盘 · 点「续下」让电脑走"
          : "导入复盘 · 可落子或点「续下」";
    }
    else if (aiThinking) status.textContent = "电脑思考中…";
    else if (hintBusy) status.textContent = "计算提示…";
    else if (hintCell) status.textContent = (turn === "b" ? "黑棋落子" : "白棋落子") + " · 有提示";
    else status.textContent = turn === "b" ? "黑棋落子" : "白棋落子";

    syncSettingsUI();
  }

  function canvasPoint(ev) {
    const rect = canvas.getBoundingClientRect();
    return {
      x: (ev.clientX - rect.left) * (canvas.width / rect.width),
      y: (ev.clientY - rect.top) * (canvas.height / rect.height),
    };
  }

  canvas.addEventListener("click", (ev) => {
    const { x, y } = canvasPoint(ev);
    const cell = cellAt(x, y);
    if (!cell) return;
    place(cell.r, cell.c, false);
  });
  let hoverRafId = 0;
  let lastHoverEvt = null;
  canvas.addEventListener("mousemove", (ev) => {
    // coalesce high-frequency mousemove into one repaint per frame
    lastHoverEvt = { clientX: ev.clientX, clientY: ev.clientY };
    if (hoverRafId) return;
    hoverRafId = requestAnimationFrame(() => {
      hoverRafId = 0;
      if (lastHoverEvt) setHoverFromEvent(lastHoverEvt);
    });
  });
  canvas.addEventListener("mouseleave", () => { clearHover(); });
  canvas.style.cursor = "crosshair";

  document.getElementById("undo").onclick = undo;
  const undo2 = document.getElementById("undo2");
  if (undo2) undo2.onclick = undo;
  document.getElementById("btn-new").onclick = () => { requestNewGame(); };
  const hintBtnEl = document.getElementById("btn-hint");
  if (hintBtnEl) hintBtnEl.onclick = () => { requestHint(); };
  const reset2 = document.getElementById("reset2");
  if (reset2) reset2.onclick = () => { requestNewGame(); };
  document.getElementById("clear-save").onclick = async () => {
    if (!(await confirmNative("清除自动存档并开始新局？", "清除存档", { ok: "清除", cancel: "取消" }))) return;
    clearSave();
    reset();
    toast("存档已清除");
  };
  document.getElementById("toggle-panel").onclick = togglePanel;
  document.getElementById("collapse").onclick = () => setPanelOpen(false);
  document.getElementById("scrim").onclick = () => setPanelOpen(false);

  const mlEl = document.getElementById("move-list");
  if (mlEl) {
    mlEl.onclick = (ev) => {
      const b = ev.target.closest("button[data-i]");
      if (b) setViewIndex(Number(b.dataset.i));
    };
  }
  document.getElementById("rep-start").onclick = () => setViewIndex(0);
  document.getElementById("rep-prev").onclick = () => setViewIndex(viewIndex - 1);
  document.getElementById("rep-next").onclick = () => setViewIndex(viewIndex + 1);
  document.getElementById("rep-end").onclick = () => setViewIndex(history.length);
  document.getElementById("rep-live").onclick = () => {
    goLive();
    toast("已回到最新一手");
  };
  document.getElementById("sgf-copy").onclick = () => { copySgf(); };
  document.getElementById("sgf-download").onclick = () => { downloadSgf(); };
  const contEl = document.getElementById("sgf-continue");
  if (contEl) contEl.onclick = () => { continueFromImport(); };
  const pasteEl = document.getElementById("sgf-paste");
  if (pasteEl) pasteEl.onclick = () => { pasteSgfFromClipboard(); };

  const slotsEl = document.getElementById("sgf-slots");
  if (slotsEl) slotsEl.onclick = () => { openSlots(); };

  const reviewEl = document.getElementById("sgf-review");
  if (reviewEl) reviewEl.onclick = () => { openReview(); };
  const reviewCloseEl = document.getElementById("review-close");
  if (reviewCloseEl) reviewCloseEl.onclick = () => { closeReview(); };
  const reviewExportEl = document.getElementById("review-export");
  if (reviewExportEl) reviewExportEl.onclick = () => { exportReviewSgf(); };
  const reviewPvEl = document.getElementById("review-pv");
  if (reviewPvEl) reviewPvEl.onclick = () => { runVariation(); };
  const reviewModalEl = document.getElementById("review-modal");
  if (reviewModalEl) reviewModalEl.onclick = (ev) => { if (ev.target === reviewModalEl) closeReview(); };
  const reviewBlundersEl = document.getElementById("review-blunders");
  if (reviewBlundersEl) {
    reviewBlundersEl.addEventListener("click", (ev) => {
      const b = ev.target.closest("[data-i]");
      if (b) reviewJump(Number(b.dataset.i));
    });
  }
  const reviewCurveEl = document.getElementById("review-curve");
  if (reviewCurveEl) {
    reviewCurveEl.addEventListener("click", (ev) => {
      if (!reviewData || reviewData.adv.length < 2) return;
      const rect = reviewCurveEl.getBoundingClientRect();
      const pad = 6;
      const frac = (ev.clientX - rect.left - pad) / Math.max(1, rect.width - pad * 2);
      const i = Math.round(Math.min(1, Math.max(0, frac)) * (reviewData.adv.length - 1));
      reviewJump(i);
    });
  }
  const slotSaveEl = document.getElementById("slot-save-current");
  if (slotSaveEl) slotSaveEl.onclick = () => { saveCurrentAsSlot(); };
  const slotsCloseEl = document.getElementById("slots-close");
  if (slotsCloseEl) slotsCloseEl.onclick = () => { closeSlots(); };
  const slotsModalEl = document.getElementById("slots-modal");
  if (slotsModalEl) slotsModalEl.onclick = (ev) => { if (ev.target === slotsModalEl) closeSlots(); };
  const slotsListEl = document.getElementById("slots-list");
  if (slotsListEl) {
    slotsListEl.addEventListener("click", (ev) => {
      const b = ev.target.closest("button[data-id]");
      if (!b) return;
      if (b.classList.contains("slot-load")) loadSlotById(b.dataset.id);
      else if (b.classList.contains("slot-del")) deleteSlotById(b.dataset.id);
    });
    // rename persists on commit (Enter / blur), not on every keystroke
    const commitRename = (ev) => {
      const inp = ev.target.closest(".slot-name");
      if (!inp) return;
      const row = inp.closest(".slot-row");
      if (row) renameSlot(row.dataset.id, inp.value);
    };
    slotsListEl.addEventListener("change", commitRename);
    slotsListEl.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter" && ev.target.classList.contains("slot-name")) {
        ev.preventDefault();
        ev.target.blur();
      }
    });
  }

  document.getElementById("mode-seg").onclick = async (ev) => {
    const b = ev.target.closest("button[data-mode]");
    if (!b) return;
    if (b.dataset.mode === mode) return;
    if (history.length && !(await confirmNative("切换模式将开始新局，是否继续？", "切换模式", { ok: "切换", cancel: "取消" }))) return;
    mode = b.dataset.mode;
    saveSettings();
    reset({ keepSettings: true });
    toast(mode === "ai" ? "人机对战" : "双人对战");
  };
  document.getElementById("diff-seg").onclick = (ev) => {
    const b = ev.target.closest("button[data-diff]");
    if (!b) return;
    difficulty = b.dataset.diff;
    saveSettings();
    syncSettingsUI();
    toast("难度：" + ({ easy: "简单", normal: "普通", hard: "困难", extreme: "极难" })[difficulty]);
  };
  const thinkSeg = document.getElementById("think-seg");
  if (thinkSeg) {
    thinkSeg.onclick = (ev) => {
      const b = ev.target.closest("button[data-think]");
      if (!b) return;
      const id = b.dataset.think;
      if (id !== "fast" && id !== "normal" && id !== "deep") return;
      if (thinkLevel === id) return;
      thinkLevel = id;
      saveSettings();
      syncSettingsUI();
      toast(
        "思考：" +
          ({ fast: "快 ~0.8s", normal: "标准 ~2s", deep: "深 ~3.5s" })[id]
      );
    };
  }
  document.getElementById("theme-seg").onclick = (ev) => {
    const b = ev.target.closest("button[data-theme]");
    if (!b) return;
    applyTheme(b.dataset.theme);
    const names = { wood: "木盘", night: "夜盘", day: "日间", notebook: "练习本" };
    toast("主题：" + (names[themeId] || themeId));
  };
  document.getElementById("opt-sound").onclick = () => {
    soundOn = !soundOn;
    saveSettings();
    syncSettingsUI();
    if (soundOn) playMoveSound("b");
    toast(soundOn ? "音效已开" : "音效已关");
  };
  const coordsBtn = document.getElementById("opt-coords");
  if (coordsBtn) {
    coordsBtn.onclick = () => {
      showCoords = !showCoords;
      saveSettings();
      syncSettingsUI();
      draw();
      toast(showCoords ? "坐标已开" : "坐标已关");
    };
  }
  const analysisBtn = document.getElementById("opt-analysis");
  if (analysisBtn) {
    analysisBtn.onclick = () => {
      analysisOn = !analysisOn;
      saveSettings();
      syncSettingsUI();
      if (!analysisOn) clearAnalysis();
      else scheduleAnalysis();
      sync();
      toast(analysisOn ? "复盘分析已开" : "复盘分析已关");
    };
  }
  document.getElementById("color-seg").onclick = async (ev) => {
    const b = ev.target.closest("button[data-human]");
    if (!b) return;
    if (b.dataset.human === humanColor) return;
    if (mode === "ai" && history.length && !(await confirmNative("更换执子将开始新局，是否继续？", "更换执子", { ok: "更换", cancel: "取消" }))) return;
    humanColor = b.dataset.human;
    saveSettings();
    if (mode === "ai") {
      reset({ keepSettings: true });
      toast(humanColor === "b" ? "你执黑" : "你执白（电脑先手）");
    } else {
      syncSettingsUI();
    }
  };

  const openingSeg = document.getElementById("opening-seg");
  if (openingSeg) {
    openingSeg.onclick = async (ev) => {
      const b = ev.target.closest("button[data-opening]");
      if (!b) return;
      const val = b.dataset.opening;
      if (val !== "standard" && val !== "swap2") return;
      if (val === openingRule) return;
      if (history.length && !(await confirmNative("切换开局规则将开始新局，是否继续？", "切换开局", { ok: "切换", cancel: "取消" }))) return;
      openingRule = val;
      saveSettings();
      reset({ keepSettings: true });
      toast(val === "swap2" ? "平衡开局 swap2" : "标准开局");
    };
  }

  const swap2Btns = document.getElementById("swap2-btns");
  if (swap2Btns) {
    swap2Btns.addEventListener("click", (ev) => {
      const b = ev.target.closest("button[data-kind]");
      if (b) swap2Choose(b.dataset.kind);
    });
  }

  const helpModal = document.getElementById("help-modal");
  const confirmModal = document.getElementById("confirm-modal");
  function openHelp() { helpModal.classList.add("show"); }
  function closeHelp() { helpModal.classList.remove("show"); }
  document.getElementById("help-btn").onclick = openHelp;
  document.getElementById("help-close").onclick = closeHelp;
  helpModal.onclick = (ev) => { if (ev.target === helpModal) closeHelp(); };
  document.getElementById("confirm-ok").onclick = () => finishConfirm(true);
  document.getElementById("confirm-cancel").onclick = () => finishConfirm(false);
  confirmModal.onclick = (ev) => { if (ev.target === confirmModal) finishConfirm(false); };

  window.addEventListener("keydown", (ev) => {
    const k = ev.key.toLowerCase();
    const slotsModal = document.getElementById("slots-modal");
    const reviewModal = document.getElementById("review-modal");
    if (ev.key === "Escape") {
      if (confirmModal.classList.contains("show")) { finishConfirm(false); return; }
      if (slotsModal && slotsModal.classList.contains("show")) { closeSlots(); return; }
      if (reviewModal && reviewModal.classList.contains("show")) { closeReview(); return; }
      if (helpModal.classList.contains("show")) { closeHelp(); return; }
      if (appEl.classList.contains("panel-open")) setPanelOpen(false);
      return;
    }
    if (confirmModal.classList.contains("show")) {
      if (ev.key === "Enter") { ev.preventDefault(); finishConfirm(true); }
      else if (ev.key === "Tab") {
        // keep focus inside the dialog, toggling between the two buttons
        ev.preventDefault();
        const ok = document.getElementById("confirm-ok");
        const ca = document.getElementById("confirm-cancel");
        (document.activeElement === ok ? ca : ok).focus();
      }
      return;
    }
    // Ignore game shortcuts while a modal is open (Esc closes it above)
    if (slotsModal && slotsModal.classList.contains("show")) return;
    if (reviewModal && reviewModal.classList.contains("show")) return;
    if (helpModal.classList.contains("show")) {
      if (ev.key === "?" || (ev.shiftKey && k === "/")) { closeHelp(); return; }
      return;
    }
    if (ev.key === "?" || (ev.shiftKey && k === "/")) { openHelp(); return; }
    if (ev.key === "Tab") {
      // Tab = panel toggle only when not chorded (Shift+Tab etc. still toggle — intentional).
      // Ignore when focus is already in a text field (future-proof).
      const tag = (document.activeElement && document.activeElement.tagName) || "";
      if (tag === "INPUT" || tag === "TEXTAREA" || (document.activeElement && document.activeElement.isContentEditable)) {
        return;
      }
      ev.preventDefault();
      togglePanel();
      return;
    }
    if (ev.key === "ArrowLeft") { ev.preventDefault(); setViewIndex(viewIndex - 1); return; }
    if (ev.key === "ArrowRight") { ev.preventDefault(); setViewIndex(viewIndex + 1); return; }
    if (ev.key === "Home") { ev.preventDefault(); setViewIndex(0); return; }
    if (ev.key === "End") { ev.preventDefault(); setViewIndex(history.length); return; }
    if ((ev.metaKey || ev.ctrlKey) && k === "z") { ev.preventDefault(); undo(); }
    else if ((ev.metaKey || ev.ctrlKey) && k === "n") { ev.preventDefault(); requestNewGame(); }
    else if ((ev.metaKey || ev.ctrlKey) && k === "1") {
      ev.preventDefault();
      if (mode === "pvp") return;
      (async () => {
        if (history.length && !(await confirmNative("切换到双人对战将开始新局，是否继续？", "切换模式", { ok: "切换", cancel: "取消" }))) return;
        mode = "pvp";
        saveSettings();
        reset({ keepSettings: true });
        toast("双人对战");
      })();
    } else if ((ev.metaKey || ev.ctrlKey) && k === "2") {
      ev.preventDefault();
      if (mode === "ai") return;
      (async () => {
        if (history.length && !(await confirmNative("切换到人机对战将开始新局，是否继续？", "切换模式", { ok: "切换", cancel: "取消" }))) return;
        mode = "ai";
        saveSettings();
        reset({ keepSettings: true });
        toast("人机对战");
      })();
    } else if (k === "z" && !ev.metaKey && !ev.ctrlKey) undo();
    else if (k === "n" && !ev.metaKey && !ev.ctrlKey) requestNewGame();
    else if (k === "h" && !ev.metaKey && !ev.ctrlKey && !ev.altKey) {
      ev.preventDefault();
      requestHint();
    }
    else if (k === "[") setPanelOpen(false);
    else if (k === "]") setPanelOpen(true);
    else if (k === "f" && !ev.metaKey && !ev.ctrlKey && !ev.altKey) {
      toggleFullscreen();
    }
  });

  window.addEventListener("resize", () => {
    appEl.classList.toggle("scrim-on", appEl.classList.contains("panel-open") && window.innerWidth < 900);
    resizeCanvas();
    draw();
  });

  window.addEventListener("beforeunload", () => saveGame());
  window.addEventListener("pagehide", () => saveGame());
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") saveGame();
  });

  function handleNativeCommand(id) {
    if (!id) return;
    if (id === "goban.new") requestNewGame();
    else if (id === "goban.undo") undo();
    else if (id === "goban.sgf-copy") copySgf();
    else if (id === "goban.sgf-export") downloadSgf();
    else if (id === "goban.sgf-paste") pasteSgfFromClipboard();
    else if (id === "goban.sgf-continue") continueFromImport();
    else if (id === "goban.hint") requestHint();
    else if (id === "goban.toggle-panel") togglePanel();
    else if (id === "goban.fullscreen") toggleFullscreen(); // system FS hint toast
  }

  if (hasZero() && typeof window.zero.on === "function") {
    try {
      window.zero.on("app:deactivate", () => { saveGame(); });
      window.zero.on("app:activate", () => { updateClock(); });
      window.zero.on("shortcut", (detail) => {
        const id = (detail && (detail.id || detail.command)) || "";
        handleNativeCommand(id);
      });
    } catch (_) {}
  }

  // boot
  loadSettings();
  document.documentElement.setAttribute("data-theme", themeId);
  const savedPanel = Host.storageGet(PANEL_KEY);
  // Restore only if user left panel open; always run setPanelOpen so inert/aria apply.
  setPanelOpen(savedPanel === "1");

  const resumed = tryLoadSave();
  if (resumed) {
    gameGen += 1;
    toast("已恢复上次对局");
  } else {
    startedAt = Date.now();
    originalStartedAt = startedAt;
    elapsedBaseMs = 0;
    if (openingRule === "swap2") startSwap2(); // fresh game opens with swap2
  }

  // Build the Blob worker up-front so the first computer reply has no
  // cold-start hitch (and degraded mode is known before it matters)
  workerInitPromise = initAiWorker();

  resizeCanvas();
  sync();
  saveSettings();
  if (!resumed) saveGame();
  maybeAiTurn();


  const sgfImport = document.getElementById("sgf-import");
  if (sgfImport) sgfImport.onclick = () => { pickAndImportSgf(); };
  Host.onDropFiles((detail) => {
    const paths = Host.normalizePaths((detail && detail.paths) || detail);
    const sgfPath = paths.find((p) => /\.sgf$/i.test(p));
    if (sgfPath) importSgfFromPath(sgfPath);
    else if (paths.length) toast("请拖入 .sgf 棋谱文件");
  });
clockTimer = setInterval(updateClock, 500);

})();
