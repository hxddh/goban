(function () {

  const Core = window.GobanCore;
  const SgfMod = window.GobanSgf;
  const Ai = window.GobanAi;
  const Host = window.GobanHost;
  const GameState = window.GobanState;
  const Draw = window.GobanDraw;
  const Audio2 = window.GobanAudio; // "Audio" would shadow the DOM constructor
  const Ui = window.GobanUi;
  const SgfIo = window.GobanSgfIo;
  const Engine = window.GobanEngine;
  const Slots = window.GobanSlots;
  const Review = window.GobanReview;
  const Stats = window.GobanStats;
  const Practice = window.GobanPractice;
  const SIZE = Core.SIZE;
  const WIN = Core.WIN;
  const SAVE_KEY = "goban.v12.save";
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

  // Worker lifecycle + degraded fallback live in GobanEngine (v1.28 split).
  function aiMoveSync(opts) { return Engine.moveSync(opts); }
  function aiMoveSyncSafe(opts) { return Engine.moveSyncSafe(opts); }
  function aiMoveAsync(opts) { return Engine.moveAsync(opts); }
  function restartWorker() { Engine.restartWorker(); }
  function initAiWorker() { return Engine.warmup(); }

  // SGF export lives in GobanSgfIo (v1.28 split); import stays here because it
  // rewrites the whole session, not just the file.
  function buildSgf() { return SgfIo.buildSgf(); }
  function sgfFileName() { return SgfIo.fileName(); }
  function bytesToBase64(str) { return Host.bytesToBase64(str); }
  async function exportSgfString(sgf, name) { return SgfIo.exportString(sgf, name); }
  async function downloadSgf() { return SgfIo.download(); }
  async function copySgfText(sgf) { return SgfIo.copyText(sgf); }
  async function copySgf() { return SgfIo.copy(); }

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
    hintBusy = false;
    clearHint();
    clearAnalysis();
    clearVariation();
    // An import replaces the game outright — cancel any in-progress swap2
    // opening, or its overlay would keep hijacking board clicks.
    swap2 = null;
    hideSwap2Bar();
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
    // Whole-game review shares the same lifetime: every board mutation runs
    // through here, and (gameGen, length) alone would collide after undo+replay.
    Review.invalidate();
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
    // Never kick off analysis while the live AI is thinking — aiMoveAsync
    // rebuilds a busy worker and would resolve the game move as null.
    if (!analysisOn || isLive() || viewIndex < 1 || aiThinking) return;
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
            if (!best) {
              // Worker cancel/timeout → null; do not cache as "最佳一手".
              analysisVerdict = { grade: "ok", text: "分析未完成" };
              analysisCell = null;
              sync();
              return;
            }
            if (best.r !== played.r || best.c !== played.c) {
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
        .catch(() => {
          if (gen !== analysisGen || viewIndex !== i) return;
          // Don't leave the UI wedged on「分析中…」when the engine path fails
          if (!hard) {
            analysisVerdict = { grade: "ok", text: "分析未完成" };
            analysisCell = null;
            sync();
          }
        });
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


  /** Win line for a viewed prefix — last-move findWin misses mid-history fives. */
  function winLineForView(n) {
    if (n <= 0) return null;
    const lastOnly = winLineAt(n);
    if (lastOnly) return lastOnly;
    // Live games end at five; only imports/saves with post-win moves keep
    // result≠play while the last stone is not the winning one.
    if (result === "play") return null;
    return GameState.resultFromBoard(boardAfter(n)).winLine;
  }

  function setViewIndex(n) {
    viewIndex = Math.max(0, Math.min(n, history.length));
    board = boardAfter(viewIndex);
    winLine = winLineForView(viewIndex);
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
      winLine = winLineForView(history.length);
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









  // presentation helpers live in GobanUi (v1.28 split)
  function toast(msg) { Ui.toast(msg); }
  function formatDuration(ms) { return Ui.formatDuration(ms); }
  function formatTime(ts) { return Ui.formatTime(ts); }

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
    if (swap2) return swap2.phase === "place" || swap2.phase === "place2";
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

  // Sound synthesis lives in GobanAudio (js/audio.js); it reads soundOn lazily.
  Audio2.init(() => soundOn);
  function playMoveSound(color) { Audio2.playMove(color); }
  function playWinSound() { Audio2.playWin(); }

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
      // mid-swap2 quits must resume inside the opening protocol, not as a
      // normal game — otherwise the side-choice step is silently swallowed
      swap2Phase: swap2 ? swap2.phase : null,
      // Sticky id so a resumed finished game can unrecord on undo and not
      // double-count if somehow re-finalized without undo.
      statsEndedAt:
        result !== "play" && statsRecordedGen === gameGen && lastStatsEndedAt
          ? lastStatsEndedAt
          : null,
      savedAt: Date.now(),
    };
  }

  function saveGame() {
    try {
      const ok = Host.storageSet(SAVE_KEY, JSON.stringify(serialize()));
      const hint = document.getElementById("save-hint");
      if (hint) hint.textContent = ok ? "已存 " + formatTime(Date.now()) : "存档失败";
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
    // and reject overlapping stones (corrupt / hand-edited saves).
    const seen = Core.emptyBoard();
    for (let i = 0; i < loadedHistory.length; i++) {
      const p = loadedHistory[i];
      if (
        !p ||
        !Number.isInteger(p.r) ||
        !Number.isInteger(p.c) ||
        p.r < 0 || p.r >= SIZE || p.c < 0 || p.c >= SIZE
      ) return false;
      if (seen[p.r][p.c]) return false;
      seen[p.r][p.c] = 1;
    }
    history = loadedHistory;
    mode = s.mode === "pvp" ? "pvp" : "ai";
    if (
      s.difficulty === "easy" || s.difficulty === "normal" ||
      s.difficulty === "hard" || s.difficulty === "extreme"
    ) {
      difficulty = s.difficulty;
    } else {
      difficulty = "normal";
    }
    humanColor = s.humanColor === "w" ? "w" : "b";
    viewIndex = history.length;
    board = boardAfter(history.length);
    turn = history.length % 2 === 0 ? "b" : "w";
    // Full-board outcome (same as import): last-move-only missed mid-history
    // fives and could restore a decided game as "play" → AI continues.
    const outcome = GameState.resultFromBoard(board);
    result = outcome.result;
    winLine = outcome.winLine;
    elapsedBaseMs = typeof s.elapsedBaseMs === "number" ? s.elapsedBaseMs : 0;
    originalStartedAt = typeof s.originalStartedAt === "number"
      ? s.originalStartedAt
      : (Date.now() - elapsedBaseMs);
    startedAt = Date.now();
    lastStatsEndedAt = typeof s.statsEndedAt === "number" ? s.statsEndedAt : null;
    // Drop any in-flight AI: callers bump gameGen, and a stale thinker must
    // not leave aiThinking wedged true (load-during-think deadlock).
    aiThinking = false;
    hintBusy = false;
    // v3+: restore import pause so AI does not auto-continue after import-only save.
    importPaused = s.v >= 3 && !!s.importPaused && result === "play";
    // Loading any snapshot leaves whatever opening protocol was on screen —
    // then restore the saved swap2 phase when it is consistent with history
    // (mid-opening save/restore must resume the choice flow, not skip it).
    swap2 = null;
    hideSwap2Bar();
    if (result === "play" && typeof s.swap2Phase === "string") {
      const len = history.length;
      const phaseOk =
        (s.swap2Phase === "place" && len <= 2) ||
        (s.swap2Phase === "p2choose" && len === 3) ||
        (s.swap2Phase === "place2" && (len === 3 || len === 4)) ||
        (s.swap2Phase === "p1choose" && len === 5);
      if (phaseOk) {
        swap2 = { phase: s.swap2Phase };
        renderSwap2Bar();
        if (s.swap2Phase === "p2choose" && mode === "ai") {
          setTimeout(aiSwap2Choose, 500); // the pending AI side-choice resumes
        }
      }
    }
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

  // --- named save slots: store/render in GobanSlots, game-flow glue here ---
  function saveCurrentAsSlot() {
    if (!history.length) { toast("当前没有可保存的对局"); return; }
    const ok = Slots.add(serialize());
    Slots.render();
    toast(ok ? "已保存到存档" : "保存失败：本地存储空间不足，请删除旧存档");
  }

  async function loadSlotById(id) {
    const slot = Slots.get(id);
    if (!slot) return;
    if (history.length &&
        !(await confirmNative("读取存档将替换当前对局，是否继续？", "读取存档", { ok: "读取", cancel: "取消" }))) {
      return;
    }
    if (!applySnapshot(slot.snap)) { toast("存档已损坏，无法读取"); return; }
    gameGen += 1;
    if (result !== "play" && lastStatsEndedAt) statsRecordedGen = gameGen;
    clearAnalysis();
    closeSlots();
    sync();
    saveGame();
    maybeAiTurn();
    toast("已读取存档");
  }

  async function deleteSlotById(id) {
    const slot = Slots.get(id);
    if (!slot) return;
    if (!(await confirmNative("删除存档「" + slot.name + "」？", "删除存档", { ok: "删除", cancel: "取消" }))) {
      return;
    }
    const ok = Slots.remove(id);
    Slots.render();
    toast(ok ? "存档已删除" : "删除失败：本地存储异常");
  }

  function openSlots() {
    Slots.render();
    const m = document.getElementById("slots-modal");
    if (m) {
      m.classList.add("show");
      const focusEl = document.getElementById("slot-save-current") || document.getElementById("slots-close");
      if (focusEl) setTimeout(() => focusEl.focus(), 0);
    }
  }

  function closeSlots() {
    const m = document.getElementById("slots-modal");
    if (m) m.classList.remove("show");
  }

  // --- whole-game review: analysis/curve/list in GobanReview, glue here ---
  Review.init({
    getHistory: () => history,
    getGameGen: () => gameGen,
    getViewIndex: () => viewIndex,
    boardAfter,
    winLineAt,
    coachFacts,
    evaluateBoard: Ai.evaluateBoard,
  });

  function reviewJump(i) {
    setViewIndex(i);
    closeReview();
  }

  function openReview() {
    Review.render();
    const m = document.getElementById("review-modal");
    if (m) {
      m.classList.add("show");
      const focusEl = document.getElementById("review-close");
      if (focusEl) setTimeout(() => focusEl.focus(), 0);
    }
  }

  function closeReview() {
    const m = document.getElementById("review-modal");
    if (m) m.classList.remove("show");
  }

  /** SGF with per-move 失着 comments + a summary root comment (复盘评注导出). */
  function buildAnnotatedSgf() {
    const rd = Review.compute();
    const comments = {};
    for (const b of rd.blunders) comments[b.i - 1] = "失着 · " + b.reason;
    const s = rd.summary;
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

  function scrollMoveListToCurrent() {
    if (!isPanelOpen()) return;
    Ui.scrollMoveListToCurrent();
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
        let move = m;
        // Worker cancel (analysis/hint restart) or a lost race can yield null
        // while it is still the computer's turn — never leave the side stranded.
        if (!move) {
          move = aiMoveSyncSafe({
            board: boardAfter(history.length),
            humanColor: humanColor,
            difficulty: difficulty,
            think: thinkLevel,
            timeMs: Math.min(600, budgetForDiff(difficulty)),
          });
        }
        if (move) place(move.r, move.c, true);
        else sync();
      }, wait);
    }).catch(() => {
      if (gen !== gameGen) return;
      aiThinking = false;
      const move = aiMoveSyncSafe({
        board: boardAfter(history.length),
        humanColor: humanColor,
        difficulty: difficulty,
        think: thinkLevel,
        timeMs: Math.min(600, budgetForDiff(difficulty)),
      });
      if (move) place(move.r, move.c, true);
      else sync();
    });
  }

  // --- swap2 balanced opening ---
  function startSwap2() {
    swap2 = { phase: "place" };
    renderSwap2Bar();
  }

  function hideSwap2Bar() { Ui.hideSwap2Bar(appEl); }

  function renderSwap2Bar() { Ui.renderSwap2Bar(appEl, swap2, history.length); }

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
    clearAnalysis();
    clearVariation();
    placeAnim = { r: r, c: c, t0: performance.now() };
    ensureAnimLoop();
    playMoveSound(color);
    const target = swap2.phase === "place" ? 3 : 5;
    if (history.length >= target) {
      swap2.phase = swap2.phase === "place" ? "p2choose" : "p1choose";
      if (swap2.phase === "p2choose" && mode === "ai") {
        renderSwap2Bar();
        sync();
        saveGame();
        setTimeout(aiSwap2Choose, 350); // AI (P2) decides its side
        return;
      }
    }
    renderSwap2Bar();
    sync();
    saveGame(); // opening stones + phase persist even on abrupt quit
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
        saveGame(); // phase must persist before place2 stones land
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

  // --- game statistics (store/aggregate/render in GobanStats) ---
  /** Guard: one stats entry per game — undo-after-win + re-win must not double-count. */
  let statsRecordedGen = -1;
  /** Matches Stats.record endedAt so undo / resume can unrecord precisely. */
  let lastStatsEndedAt = null;

  function recordGameEnd() {
    if (gameGen === statsRecordedGen) return;
    statsRecordedGen = gameGen;
    lastStatsEndedAt = Date.now();
    Stats.record({
      mode,
      difficulty: mode === "ai" ? difficulty : null,
      humanColor: mode === "ai" ? humanColor : null,
      result,
      moves: history.length,
      durationMs: nowElapsed(),
      endedAt: lastStatsEndedAt,
    });
  }

  function openStats() {
    Stats.render();
    const m = document.getElementById("stats-modal");
    if (m) {
      m.classList.add("show");
      const focusEl = document.getElementById("stats-close");
      if (focusEl) setTimeout(() => focusEl.focus(), 0);
    }
  }

  function closeStats() {
    const m = document.getElementById("stats-modal");
    if (m) m.classList.remove("show");
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
      recordGameEnd();
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
      recordGameEnd();
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
    const wasOver = result !== "play";
    const wasRecorded = wasOver && statsRecordedGen === gameGen;
    const endedAt = lastStatsEndedAt;
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
    if (wasRecorded) {
      Stats.unrecordByEndedAt(endedAt);
      statsRecordedGen = -1;
      lastStatsEndedAt = null;
    }
    // End-game froze elapsedBaseMs and reset startedAt; returning to play
    // without refreshing startedAt would add post-game idle into the clock.
    if (wasOver) startedAt = Date.now();
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
    hintBusy = false;
    placeAnim = null;
    importPaused = false;
    hoverCell = null;
    statsRecordedGen = -1;
    lastStatsEndedAt = null;
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
    Ui.renderMoveList(history, viewIndex, gameGen);
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
      // Titles track the active difficulty budget (hard ≠ extreme wall times)
      const titles =
        difficulty === "extreme"
          ? { fast: "约 2.5 秒", normal: "约 5 秒", deep: "约 8 秒" }
          : { fast: "约 0.8 秒", normal: "约 2 秒", deep: "约 3.5 秒" };
      document.querySelectorAll("#think-seg button[data-think]").forEach((b) => {
        const t = titles[b.dataset.think];
        if (t) b.title = t;
      });
      const thinkGroup = document.getElementById("think-seg");
      if (thinkGroup) {
        thinkGroup.setAttribute(
          "aria-label",
          difficulty === "extreme" ? "极难思考时间" : "困难思考时间"
        );
      }
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
      if (b) b.disabled = history.length === 0 || aiThinking || hintBusy || !live || !!swap2;
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
        !swap2 &&
        (isLive()
          ? result === "play" && !(mode === "ai" && !isHumanTurn())
          : true);
      hintBtn.disabled = !canHint;
      hintBtn.classList.toggle("busy", hintBusy);
    }

    if (swap2) {
      // Colors are undecided until settleSwap2 — don't show stale 你/电脑
      document.getElementById("black-role").textContent = "待定";
      document.getElementById("white-role").textContent = "待定";
    } else if (mode === "ai") {
      document.getElementById("black-role").textContent = humanColor === "b" ? "你" : "电脑";
      document.getElementById("white-role").textContent = humanColor === "w" ? "你" : "电脑";
    } else {
      document.getElementById("black-role").textContent = "玩家 1";
      document.getElementById("white-role").textContent = "玩家 2";
    }

    const showTurn = live && result === "play" && !swap2;
    blackTurn.hidden = !(showTurn && turn === "b");
    whiteTurn.hidden = !(showTurn && turn === "w");

    const thinkDot = document.getElementById("think-dot");
    if (thinkDot) thinkDot.hidden = !(aiThinking && result === "play");

    // Crosshair only when a click can place; otherwise default (AI/replay/end)
    const placePhase = !!(swap2 && (swap2.phase === "place" || swap2.phase === "place2"));
    canvas.style.cursor = canHoverPlace() || placePhase ? "crosshair" : "default";

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

  const statsEl = document.getElementById("open-stats");
  if (statsEl) statsEl.onclick = () => { openStats(); };

  Engine.init({
    defaults: () => ({
      board: board, humanColor: humanColor, difficulty: difficulty, think: thinkLevel,
    }),
    budgetFor: budgetForDiff,
    engineFor: engineFor,
    toast: toast,
  });

  SgfIo.init({
    getGame: () => ({
      history: history, result: result, mode: mode,
      humanColor: humanColor, originalStartedAt: originalStartedAt,
    }),
    toast: toast,
  });

  // Practice pulls puzzle material from the live game + saved slots; it plays
  // entirely inside its own modal/board and never touches game state.
  Practice.init({
    getHistories: () => [history].concat(
      Slots.load().map((s) => s.snap && s.snap.history).filter(Boolean)
    ),
  });
  Practice.wire();
  const practiceEl = document.getElementById("open-practice");
  if (practiceEl) practiceEl.onclick = () => { Practice.open(); };
  const dailyEl = document.getElementById("open-daily");
  if (dailyEl) dailyEl.onclick = () => { Practice.openDaily(); };
  const statsCloseEl = document.getElementById("stats-close");
  if (statsCloseEl) statsCloseEl.onclick = () => { closeStats(); };
  const statsModalEl = document.getElementById("stats-modal");
  if (statsModalEl) statsModalEl.onclick = (ev) => { if (ev.target === statsModalEl) closeStats(); };
  const statsClearEl = document.getElementById("stats-clear");
  if (statsClearEl) {
    statsClearEl.onclick = async () => {
      if (!(await confirmNative("清空全部对局统计？", "清空统计", { ok: "清空", cancel: "取消" }))) return;
      Stats.clear();
      Stats.render();
      toast("统计已清空");
    };
  }

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
      const rd = Review.getData();
      if (!rd || rd.adv.length < 2) return;
      const rect = reviewCurveEl.getBoundingClientRect();
      const pad = 6;
      const frac = (ev.clientX - rect.left - pad) / Math.max(1, rect.width - pad * 2);
      const i = Math.round(Math.min(1, Math.max(0, frac)) * (rd.adv.length - 1));
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
      if (row) Slots.rename(row.dataset.id, inp.value);
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
          (difficulty === "extreme"
            ? { fast: "快 ~2.5s", normal: "标准 ~5s", deep: "深 ~8s" }
            : { fast: "快 ~0.8s", normal: "标准 ~2s", deep: "深 ~3.5s" })[id]
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
  function openHelp() {
    helpModal.classList.add("show");
    const close = document.getElementById("help-close");
    if (close) setTimeout(() => close.focus(), 0);
  }
  function closeHelp() { helpModal.classList.remove("show"); }
  document.getElementById("help-btn").onclick = openHelp;
  document.getElementById("help-close").onclick = closeHelp;
  helpModal.onclick = (ev) => { if (ev.target === helpModal) closeHelp(); };
  document.getElementById("confirm-ok").onclick = () => finishConfirm(true);
  document.getElementById("confirm-cancel").onclick = () => finishConfirm(false);
  confirmModal.onclick = (ev) => { if (ev.target === confirmModal) finishConfirm(false); };

  function openModalFocusables(modal) { return Ui.modalFocusables(modal); }
  function trapModalTab(ev, modal) { return Ui.trapModalTab(ev, modal); }

  window.addEventListener("keydown", (ev) => {
    const k = ev.key.toLowerCase();
    const slotsModal = document.getElementById("slots-modal");
    const reviewModal = document.getElementById("review-modal");
    const statsModal = document.getElementById("stats-modal");
    const practiceModal = document.getElementById("practice-modal");
    if (ev.key === "Escape") {
      if (confirmModal.classList.contains("show")) { finishConfirm(false); return; }
      if (slotsModal && slotsModal.classList.contains("show")) { closeSlots(); return; }
      if (reviewModal && reviewModal.classList.contains("show")) { closeReview(); return; }
      if (statsModal && statsModal.classList.contains("show")) { closeStats(); return; }
      if (Practice.isOpen()) { Practice.close(); return; }
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
    // Tab stays inside whichever modal is open; other game shortcuts are blocked
    if (slotsModal && slotsModal.classList.contains("show")) {
      trapModalTab(ev, slotsModal);
      return;
    }
    if (reviewModal && reviewModal.classList.contains("show")) {
      trapModalTab(ev, reviewModal);
      return;
    }
    if (statsModal && statsModal.classList.contains("show")) {
      trapModalTab(ev, statsModal);
      return;
    }
    if (practiceModal && practiceModal.classList.contains("show")) {
      trapModalTab(ev, practiceModal);
      return;
    }
    if (helpModal.classList.contains("show")) {
      if (ev.key === "?" || (ev.shiftKey && k === "/")) { closeHelp(); return; }
      trapModalTab(ev, helpModal);
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
    if (result !== "play" && lastStatsEndedAt) statsRecordedGen = gameGen;
    toast("已恢复上次对局");
  } else {
    startedAt = Date.now();
    originalStartedAt = startedAt;
    elapsedBaseMs = 0;
    if (openingRule === "swap2") startSwap2(); // fresh game opens with swap2
  }

  // Build the Blob worker up-front so the first computer reply has no
  // cold-start hitch (and degraded mode is known before it matters)
  initAiWorker();

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
