(function () {

  const Core = window.GobanCore;
  const SgfMod = window.GobanSgf;
  const Ai = window.GobanAi;
  const Host = window.GobanHost;
  const GameState = window.GobanState;
  const Draw = window.GobanDraw;
  const Audio2 = window.GobanAudio; // "Audio" would shadow the DOM constructor
  const I18n = window.GobanI18n;
  const t = (k, p) => I18n.t(k, p);
  const Ui = window.GobanUi;
  const SgfIo = window.GobanSgfIo;
  const Engine = window.GobanEngine;
  const Slots = window.GobanSlots;
  const Review = window.GobanReview;
  const Stats = window.GobanStats;
  const Backup = window.GobanBackup;
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
  function winLineAt(n) { return Core.winLineAt(history, n, isRenju()); }
  function findWin(r, c, color) { return Core.findWinRule(board, r, c, color, isRenju()); }
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
      toast(parsed.error || t("import.parseFail"));
      return false;
    }
    if (history.length) {
      const ok = await confirmNative(
        t("import.confirm"),
        t("import.title"),
        { ok: t("import.ok"), cancel: t("dlg.cancel") }
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
      ruleSet: ruleSet,
    });
    if (!applied.ok) {
      toast(applied.error || t("import.fail"));
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
      t(result === "b" ? "import.end.b" : result === "w" ? "import.end.w" : result === "draw" ? "import.end.draw" : "import.end.open");
    const hint = t(importPaused ? "import.hint.continue" : "import.hint.reviewOnly");
    toast(t("import.done", { n: history.length, end: end, tag: tag, hint: hint }));
    return true;
  }

  /** After import: resume live play (and AI if needed). */
  function continueFromImport() {
    if (!importPaused || result !== "play" || !history.length) {
      toast(t(result !== "play" ? "continue.finished" : "continue.none"));
      return;
    }
    importPaused = false;
    goLive();
    toast(t(mode === "ai" && !isHumanTurn() ? "continue.aiTurn" : "continue.yourTurn"));
    maybeAiTurn();
  }

  async function pasteSgfFromClipboard() {
    let text = "";
    try {
      text = await Host.readClipboard();
    } catch (_) {
      toast(t("clip.fail"));
      return;
    }
    if (!text || !String(text).trim()) {
      toast(t("clip.empty"));
      return;
    }
    await importSgfFromText(String(text), t("clip.label"));
  }

  async function importSgfFromPath(path) {
    if (!path) {
      toast(t("file.badPath"));
      return;
    }
    try {
      const text = await readTextFile(path);
      if (!text || !String(text).trim()) {
        toast(t("file.empty"));
        return;
      }
      const base = String(path).split(/[/\\]/).pop() || "sgf";
      await importSgfFromText(text, base);
    } catch (e) {
      const msg = (e && e.message) || "";
      toast(msg && msg.length < 48 ? t("file.readFail", { msg: msg }) : t("file.readFailGeneric"));
    }
  }

  async function pickAndImportSgf() {
    if (!Host.hasZero()) {
      toast(t("file.unsupported"));
      return;
    }
    try {
      const files = await Host.openFileDialog({
        title: t("import.title"),
        allowMultiple: false,
      });
      const paths = Host.normalizePaths(files);
      if (!paths.length) {
        toast(t("file.cancelled"));
        return;
      }
      await importSgfFromPath(paths[0]);
    } catch (e) {
      toast(t("file.openFail"));
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
   * 'free' = 无禁手五子棋(黑六连也算胜);'renju' = 连珠,黑受长连/双四/双三
   * 三条禁手约束、且只有恰好五连才算胜。两个引擎都不认识禁手 —— 实测执黑时
   * 会有三成到四成的对局走出禁手 —— 所以 renju 档下只开双人。
   * @type {'free' | 'renju'}
   */
  let ruleSet = "free";
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
  /** performance.now() when the current computer move started; 0 when idle. */
  let thinkStartedAt = 0;
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
    if (playedWins) return { grade: "best", text: t("coach.winning") };
    // missed win: a five was available but not taken
    const myWins = Ai.listWinCells(preBoard, sColor);
    if (myWins.length) return { grade: "blunder", text: t("coach.missedWin"), best: myWins[0] };
    // allowed opponent win-in-1 the move failed to prevent
    const after = preBoard.map((row) => row.slice());
    after[played.r][played.c] = sColor;
    if (Ai.listWinCells(after, oppC).length) return { grade: "blunder", text: t("coach.missedBlock") };
    return null;
  }

  /** Analyze the move that led to the currently-viewed replay position. */
  function scheduleAnalysis() {
    if (analysisTimer) { clearTimeout(analysisTimer); analysisTimer = null; }
    analysisCell = null;
    analysisVerdict = null;
    // Never kick off analysis while the live AI is thinking — aiMoveAsync
    // rebuilds a busy worker and would resolve the game move as null.
    if (!analysisOn || viewIndex < 1 || aiThinking || !engineAdviceOk()) return;
    // 只在**棋还在下**的时候封住头部那一手 —— 那时候评它等于给提示。
    //
    // 此前的判据是光秃秃的 isLive()，它不区分「棋还在下」和「棋已经下完」，于是
    // 终局之后、以及导入的纯复盘里，最后一手也被一并封了口 —— 而那一手往往正是
    // 最该有评语的：要么是制胜一手，要么是葬送全局的那一步。
    //
    // 更糟的是两处视图会自相矛盾：review.js 的循环是 `for (i = 1; i <= N; i++)`，
    // **包含**最后一手，所以整局复盘照列不误。实测走过一遍：面板列出「第 9 手
    // 黑错失胜着」，面板自己写着「点下方失着可跳转」，点下去跳到 9/9 —— 然后这一栏
    // 一片空白。同一个功能，两套说法。
    //
    // importPaused 是导入 SGF 后的纯复盘态（落第一子即清除）：那不是在对局，而且
    // 整局复盘早就把同样的评语公示了，谈不上剧透。
    if (isLive() && result === "play" && !importPaused) return;
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
    analysisVerdict = hard || { grade: "pending", text: t("coach.pending") };
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
              analysisVerdict = { grade: "ok", text: t("coach.incomplete") };
              analysisCell = null;
              sync();
              return;
            }
            if (best.r !== played.r || best.c !== played.c) {
              cell = best;
              verdict = { grade: "ok", text: t("coach.better") };
            } else {
              cell = null;
              verdict = { grade: "best", text: t("coach.best") };
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
            analysisVerdict = { grade: "ok", text: t("coach.incomplete") };
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
    const okLabel = (buttons && buttons.ok) || t("dlg.ok");
    const cancelLabel = (buttons && buttons.cancel) || t("dlg.cancel");
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
    titleEl.textContent = title || t("dlg.confirm");
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
        t("newgame.confirm"),
        t("newgame.ok"),
        { ok: t("newgame.ok"), cancel: t("dlg.cancel") }
      );
      if (!ok) return;
    }
    // reset() bumps gameGen so any in-flight AI timeout cannot place.
    reset();
    toast(t("newgame.started"));
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
    return GameState.resultFromBoard(boardAfter(n), isRenju()).winLine;
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
    if (!engineAdviceOk()) { toast(t("advice.renju")); return; }
    if (swap2) { toast(t("hint.swap2")); return; }
    if (aiThinking || hintBusy) {
      toast(t("hint.wait"));
      return;
    }
    const live = isLive();
    if (live) {
      if (result !== "play") {
        toast(t("hint.over"));
        return;
      }
      if (importPaused && mode === "ai" && !isHumanTurn()) {
        toast(t("hint.needContinue"));
        return;
      }
      // Hint for the side to move (human's turn in AI mode, or either in pvp)
      if (mode === "ai" && !isHumanTurn()) {
        toast(t("hint.aiTurn"));
        return;
      }
    } else if (winLineAt(viewIndex)) {
      // analysis mode works on any browsed position, except a finished one
      toast(t("hint.alreadyFive"));
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
        toast(t("hint.none"));
        hintCell = null;
      } else {
        hintCell = { r: m.r, c: m.c };
        toast(t("hint.shown", { color: t(side === "b" ? "side.black" : "side.white") }));
      }
    } catch (_) {
      if (gen === gameGen) {
        toast(t("hint.fail"));
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
      if (s.ruleSet === "free" || s.ruleSet === "renju") ruleSet = s.ruleSet;
      // 存下来的两个字段各存各的,组合可能是旧版本写的,也可能是手改的。侧栏那
      // 一格是三选一,所以这里把不可能被选出来的组合收回去:禁手档没有引擎(恢复
      // 成人机等于让一个不认识禁手的引擎执黑),也不叠 swap2(两者都是平衡手段)。
      if (ruleSet === "renju") {
        applyMode("pvp");
        openingRule = "standard";
      }
    } catch (_) {}
  }

  function saveSettings() {
    Host.storageSet(
      SETTINGS_KEY,
      JSON.stringify({ mode, difficulty, humanColor, soundOn, themeId, thinkLevel, showCoords, analysisOn, openingRule, ruleSet })
    );
  }

  function isRenju() { return ruleSet === "renju"; }

  /**
   * 引擎的一切建议 —— 提示、复盘分析标记、复盘报告 —— 都从同一套自由式静态
   * 评估来:它会把黑的六连当成胜,也会把禁手点当成好点。在禁手档下这些建议
   * 不是「略有偏差」,而是可能直接指向一个本应用自己拒绝落的点。与其给错的,
   * 先不给 —— 引擎认得禁手之后(下一版)再开回来。
   */
  function engineAdviceOk() { return !isRenju(); }

  /**
   * 唯一改 mode 的入口。人机与禁手互斥(见 ruleSet),切到人机就把规则一并带回
   * 自由 —— 分段控件、⌘1、⌘2 三个入口共用这一处,否则总会漏掉一个。
   * @returns {boolean} 规则是否被一并改回了自由
   */
  function applyMode(next) {
    mode = next;
    const followed = next === "ai" && isRenju();
    if (followed) ruleSet = "free";
    return followed;
  }

  /**
   * 侧栏那一格三选一映射到的两个内部字段。swap2 与禁手都是「黑先手占优,拿
   * 什么补」的答案,所以它们互斥;而 openingRule 与 ruleSet 分开存,是因为
   * swap2 的协议和禁手的判定是两套互不相干的代码。
   * @returns {'free'|'swap2'|'renju'}
   */
  function ruleChoice() {
    if (isRenju()) return "renju";
    return openingRule === "swap2" ? "swap2" : "free";
  }

  /** @returns {boolean} 是否顺带把模式切成了双人 */
  function applyRuleChoice(val) {
    ruleSet = val === "renju" ? "renju" : "free";
    openingRule = val === "swap2" ? "swap2" : "standard";
    if (isRenju() && mode === "ai") {
      applyMode("pvp");
      return true;
    }
    return false;
  }

  /**
   * 黑在 (r,c) 落子的禁手原因,没有则 null。白方与自由式一律 null。
   * @returns {null|'overline'|'double4'|'double3'}
   */
  function forbiddenReason(bd, r, c, color) {
    if (!isRenju() || color !== "b") return null;
    return Core.renjuForbidden(bd, r, c);
  }

  /** 当前活盘上黑不能落的点,按局面缓存 —— draw 每帧都会问一次。 */
  let forbidSig = "";
  let forbidPts = [];
  function forbiddenPoints() {
    if (!isRenju() || result !== "play" || !isLive() || turn !== "b") {
      forbidSig = "";
      forbidPts = [];
      return forbidPts;
    }
    const sig = history.length + "|" + gameGen;
    if (sig !== forbidSig) {
      forbidSig = sig;
      forbidPts = Core.renjuForbiddenPoints(board);
    }
    return forbidPts;
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
  /**
   * 一局结束的声音,按**用户**的处境选,不是按「有人赢了」。
   *
   * 之前这里是无条件的 playWin():电脑赢棋时应用照样奏那段上行大调琶音。
   * 实测两次对局的音频图逐个音符相同 —— 你输的每一局,它都在庆祝。
   * 判断所需的东西一直都在作用域里(mode / humanColor),只是没人用。
   *
   * 对弈(pvp)两边都是人,谁赢都是人赢,所以仍然是 win —— 这不是偷懒,是
   * 「站在用户角度」这条规则在双人局面下的正确答案。
   *
   * @param {'b'|'w'|null} winner null 表示和局
   */
  function playEndSound(winner) {
    if (!winner) { Audio2.playEnd("draw"); return; }
    if (mode === "ai" && winner !== humanColor) { Audio2.playEnd("loss"); return; }
    Audio2.playEnd("win");
  }

  /** Point users at real macOS window chrome — not web Fullscreen API. */
  function toggleFullscreen() {
    toast(t("fs.tip"));
  }

  function serialize() {
    return {
      v: 4,
      board,
      turn,
      result,
      mode,
      difficulty,
      humanColor,
      // v4 起随存档走:胜负规则决定这盘棋怎么读。不存的话,一盘禁手棋在自由档下
      // 载入,黑的六连会被重算成黑胜;反过来,一盘人机棋在禁手档下载入会把 mode
      // 恢复成 ai —— 那正是「人机 + 禁手」这个不该存在的组合,而引擎走出的禁手
      // 会被落子那一关拦下,电脑再也不出手,棋局就卡死在那里。
      ruleSet,
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
      if (hint) hint.textContent = ok ? t("save.at", { time: formatTime(Date.now()) }) : t("save.failed");
    } catch (_) {}
  }

  function clearSave() {
    Host.storageRemove(SAVE_KEY);
    Host.storageRemove("goban.v11.save");
    const hint = document.getElementById("save-hint");
    if (hint) hint.textContent = t("save.none");
  }

  /**
   * Load a parsed snapshot (from autosave or a named slot) into live game
   * state. Recomputes result/win-line from history — stale save fields are
   * never trusted. @returns {boolean} true when applied.
   */
  function applySnapshot(s) {
    if (!s || (s.v !== 1 && s.v !== 2 && s.v !== 3 && s.v !== 4)) return false;
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
    // 规则要在算胜负**之前**恢复。v3 及更早没有这个字段,那时只有自由式一种规则,
    // 所以缺省成 free 就是它们当初实际用的规则。恢复完再把不可能的组合收回去 ——
    // 与 loadSettings 同一处不变量。
    ruleSet = s.ruleSet === "renju" ? "renju" : "free";
    if (isRenju()) {
      applyMode("pvp");
      openingRule = "standard";
    }
    viewIndex = history.length;
    board = boardAfter(history.length);
    turn = history.length % 2 === 0 ? "b" : "w";
    // Full-board outcome (same as import): last-move-only missed mid-history
    // fives and could restore a decided game as "play" → AI continues.
    const outcome = GameState.resultFromBoard(board, isRenju());
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
  async function saveCurrentAsSlot() {
    if (!history.length) { toast(t("slot.nothing")); return; }
    // 存档满了再存,会把最早的那个挤掉。此前这一步是静默的:列表仍是 30 条,
    // 最老的那个不见了,而 toast 照说「已保存」。这些存档是用户亲手命名的,
    // 清除存档和恢复备份都要确认,挤掉一个存档是同一类动作。
    const doomed = Slots.wouldEvict();
    if (doomed) {
      const ok = await confirmNative(
        t("slot.fullConfirm", { max: Slots.MAX, name: doomed.name }),
        t("slot.fullTitle"),
        { ok: t("slot.fullOk"), cancel: t("dlg.cancel") });
      if (!ok) { toast(t("slot.fullCancelled")); return; }
    }
    const ok = Slots.add(serialize());
    Slots.render();
    toast(t(ok ? "slot.saved" : "slot.saveFail"));
  }

  async function loadSlotById(id) {
    const slot = Slots.get(id);
    if (!slot) return;
    if (history.length &&
        !(await confirmNative(t("slot.loadConfirm"), t("slot.loadTitle"), { ok: t("slot.loadOk"), cancel: t("dlg.cancel") }))) {
      return;
    }
    if (!applySnapshot(slot.snap)) { toast(t("slot.corrupt")); return; }
    gameGen += 1;
    if (result !== "play" && lastStatsEndedAt) statsRecordedGen = gameGen;
    clearAnalysis();
    closeSlots();
    sync();
    saveGame();
    maybeAiTurn();
    toast(t("slot.loaded"));
  }

  async function deleteSlotById(id) {
    const slot = Slots.get(id);
    if (!slot) return;
    if (!(await confirmNative(t("slot.delConfirm", { name: slot.name }), t("slot.delTitle"), { ok: t("slot.delOk"), cancel: t("dlg.cancel") }))) {
      return;
    }
    const ok = Slots.remove(id);
    Slots.render();
    toast(t(ok ? "slot.deleted" : "slot.delFail"));
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
    if (!engineAdviceOk()) { toast(t("advice.renju")); return; }
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
    for (const b of rd.blunders) comments[b.i - 1] = t("review.cmt.blunder", { reason: b.reason });
    const s = rd.summary;
    const rootComment =
      t("review.cmt.root", {
        b: s.b, w: s.w, n: history.length,
        clean: s.b + s.w === 0 ? t("review.cmt.clean") : "",
      });
    return SgfMod.buildSgf({
      history, result, mode, humanColor, originalStartedAt,
      ruleSet, comments, rootComment,
    });
  }

  async function exportReviewSgf() {
    if (history.length < 2) { toast(t("review.tooShort")); return; }
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
    toast(pv.length ? t("pv.done", { n: pv.length }) : t("pv.none"));
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
          syncScrollEdges();
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
    forbidden: forbiddenPoints(),
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
    thinkStartedAt = performance.now();
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
        thinkStartedAt = 0;
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
      thinkStartedAt = 0;
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
    toast(t(aiTakesWhite ? "swap2.aiWhite" : "swap2.aiBlack"));
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
        toast(t("place.needLive"));
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
    // 禁手:拦下不让走,而不是判负。判负要求对手看着你踩进去,一个人对着屏幕
    // 下棋时那只是把棋局作废;拦下来还能顺带把原因说出来,规则才学得会。
    // 对 fromAi 一并生效:禁手档下按构造没有电脑(规则一选中就切双人,读设置时也
    // 收口),真走到这里说明那条约束破了 —— 那时宁可拦住,也不让引擎破规则。
    const why = forbiddenReason(board, r, c, turn);
    if (why) {
      toast(t("renju.blocked." + why));
      return;
    }
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
      // 顺序要紧:nowElapsed() 在 result !== "play" 时直接返回 elapsedBaseMs,
      // 所以必须**先**把这一段走过的时间累进去,再把 result 设成终局。
      // 反过来写(v1.9 起就是反的)等于把本局用时整个丢掉:实测一盘走了 00:09 的棋,
      // 终局时钟跳回 00:00、统计记 durationMs = 0,于是「总时长」这一项从来都是 0。
      elapsedBaseMs = nowElapsed();
      startedAt = Date.now();
      result = turn;
      winLine = line;
      recordGameEnd();
      playEndSound(turn);
      triggerWinFlash();
      ensureAnimLoop();
      sync();
      saveGame();
      return;
    }
    if (boardFull()) {
      elapsedBaseMs = nowElapsed();   // 同上:先累加,再置终局
      startedAt = Date.now();
      result = "draw";
      winLine = null;
      recordGameEnd();
      // 和局此前是三种结局里唯一无声的一种:棋盘填满,最后一颗子的落子声之后
      // 什么都没有,你得看状态栏才知道这局已经完了。
      playEndSound(null);
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

  /**
   * Cancel the computer's pending move. 极限 budgets are 5s (深 8s) per move,
   * during which the only status was a static "电脑思考中…" and 悔棋 was
   * disabled — a misclick meant sitting through the whole budget. Bumping
   * gameGen makes every pending continuation drop its result (the same guard
   * reset/load already rely on), and the worker is restarted so it stops
   * burning CPU on a move nobody will use. Safe for stats: the computer only
   * thinks while result === "play", so nothing has been recorded yet.
   */
  function abortThinking() {
    if (!aiThinking) return false;
    gameGen += 1;
    aiThinking = false;
    thinkStartedAt = 0;
    restartWorker();
    return true;
  }

  function undo() {
    if (swap2) return; // no undo mid-opening
    // The guards come FIRST, and that ordering is the whole point. v1.33.0
    // aborted before them, so pressing z while the computer thought its
    // opening move (human plays white ⇒ thinking with an empty history) killed
    // the think and then returned early: nothing called maybeAiTurn(), so the
    // computer never moved again, and nothing called sync(), so the pill stayed
    // frozen on "电脑思考中…" forever. The button is disabled in that state,
    // but z / Cmd-Z / the native menu item all reach undo() directly.
    if (!history.length || hintBusy) return;
    // Undo doubles as the way out of a long think: cancel first, then retract
    // the move that triggered it. Every path below ends in sync() + maybeAiTurn().
    abortThinking();
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

  /** Static text for the first second, then a live count so a 5–8s 极限 think
   *  reads as progress rather than a hang. */
  function thinkingText() {
    const ms = thinkStartedAt ? performance.now() - thinkStartedAt : 0;
    if (ms < 1000) return t("status.thinking");
    return t("status.thinkingElapsed", { s: Math.floor(ms / 1000) });
  }

  function updateClock() {
    const el = formatDuration(nowElapsed());
    const c1 = document.getElementById("clock");
    const c2 = document.getElementById("info-time");
    if (c1) c1.textContent = el;
    if (c2) c2.textContent = el;
    // The same 500ms tick advances the think counter; sync() only runs at the
    // start and end of a think, so without this the seconds would never move.
    if (aiThinking) {
      const st = document.getElementById("status");
      if (st) st.textContent = thinkingText();
    }
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
    document.querySelectorAll("#lang-seg button").forEach((b) => {
      b.classList.toggle("active", b.dataset.lang === I18n.lang());
    });
    document.querySelectorAll("#theme-seg button").forEach((b) => {
      b.classList.toggle("active", b.dataset.theme === themeId);
    });
    document.querySelectorAll("#rule-seg button").forEach((b) => {
      b.classList.toggle("active", b.dataset.rule === ruleChoice());
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
          ? { fast: t("think.fast.max.title"), normal: t("think.normal.max.title"), deep: t("think.deep.max.title") }
          : { fast: t("think.fast.hard.title"), normal: t("think.normal.hard.title"), deep: t("think.deep.hard.title") };
      document.querySelectorAll("#think-seg button[data-think]").forEach((b) => {
        const t = titles[b.dataset.think];
        if (t) b.title = t;
      });
      const thinkGroup = document.getElementById("think-seg");
      if (thinkGroup) {
        thinkGroup.setAttribute(
          "aria-label",
          t(difficulty === "extreme" ? "aria.thinkMax" : "aria.think")
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

  /**
   * The sidebar's scroll region has no edge of its own: it just stops, cutting
   * whatever row sits at the boundary in half. styles.css fades that edge, but
   * only the side that actually has content past it — which is a fact about
   * scroll position, so it has to be maintained here. Cheap enough to call from
   * sync(); scroll/resize call it directly.
   */
  function syncScrollEdges() {
    const el = document.getElementById("side-scroll");
    if (!el) return;
    const max = el.scrollHeight - el.clientHeight;
    const scrollable = max > 1;
    el.dataset.above = scrollable && el.scrollTop > 1 ? "1" : "0";
    el.dataset.below = scrollable && el.scrollTop < max - 1 ? "1" : "0";
  }

  function sync() {
    draw();
    syncScrollEdges();
    const status = document.getElementById("status");
    const moves = document.getElementById("moves");
    const blackTurn = document.getElementById("black-turn");
    const whiteTurn = document.getElementById("white-turn");
    const undoBtns = [document.getElementById("undo"), document.getElementById("undo2")].filter(Boolean);
    const live = isLive();

    moves.textContent = viewIndex + "/" + history.length;
    document.getElementById("info-moves").textContent =
      history.length + (live ? "" : t("info.viewing", { n: viewIndex }));
    const modeEl = document.getElementById("info-mode");
    if (modeEl) {
      modeEl.textContent = mode === "pvp"
        ? t("mode.pvp")
        : t("diff." + difficulty + ".full");
    }
    document.getElementById("replay-pos").textContent = viewIndex + " / " + history.length;
    const verdictEl = document.getElementById("coach-verdict");
    if (verdictEl) {
      // 与 scheduleAnalysis 的判据必须同一套 —— 否则会算了却不显示，或显示一条
      // 陈旧的。封口只封「棋还在下、且停在头部」。
      const show = analysisOn && analysisVerdict && !(live && result === "play" && !importPaused);
      verdictEl.hidden = !show;
      if (show) {
        const who = t((viewIndex - 1) % 2 === 0 ? "side.black" : "side.white");
        verdictEl.textContent = t("coach.line", { n: viewIndex, who: who, text: analysisVerdict.text });
        verdictEl.className = "coach-verdict grade-" + (analysisVerdict.grade || "ok");
      }
    }
    renderMoveList();
    updateClock();

    undoBtns.forEach((b) => {
      // NOT disabled while aiThinking — 悔棋 is the cancel affordance (see abortThinking).
      if (b) b.disabled = history.length === 0 || hintBusy || !live || !!swap2;
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
      document.getElementById("black-role").textContent = t("role.pending");
      document.getElementById("white-role").textContent = t("role.pending");
    } else if (mode === "ai") {
      document.getElementById("black-role").textContent = t(humanColor === "b" ? "role.you" : "role.computer");
      document.getElementById("white-role").textContent = t(humanColor === "w" ? "role.you" : "role.computer");
    } else {
      document.getElementById("black-role").textContent = t("role.p1");
      document.getElementById("white-role").textContent = t("role.p2");
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
          ? t("swap2.placing")
          : t("swap2.choosing");
    } else if (!live) {
      status.textContent = t("status.replay", { n: viewIndex, total: history.length });
      if (winLine) status.textContent += t("status.five");
    } else if (result === "b") status.textContent = t("status.blackWin");
    else if (result === "w") status.textContent = t("status.whiteWin");
    else if (result === "draw") status.textContent = t("result.draw");
    else if (importPaused) {
      status.textContent =
        mode === "ai" && !isHumanTurn()
          ? t("status.importAi")
          : t("status.importYou");
    }
    else if (aiThinking) status.textContent = thinkingText();
    else if (hintBusy) status.textContent = t("status.hintCalc");
    else if (hintCell) status.textContent = t("status.withHint", { turn: t(turn === "b" ? "status.blackTurn" : "status.whiteTurn") });
    else status.textContent = t(turn === "b" ? "status.blackTurn" : "status.whiteTurn");

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
    if (!(await confirmNative(t("save.clearConfirm"), t("save.clearTitle"), { ok: t("save.clearOk"), cancel: t("dlg.cancel") }))) return;
    clearSave();
    reset();
    toast(t("save.cleared"));
  };
  document.getElementById("toggle-panel").onclick = togglePanel;
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
    toast(t("replay.backToLive"));
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
      ruleSet: ruleSet,
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
      if (!(await confirmNative(t("stats.clearConfirm"), t("stats.clearTitle"), { ok: t("stats.clear"), cancel: t("dlg.cancel") }))) return;
      Stats.clear();
      Stats.render();
      toast(t("stats.cleared"));
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
      // Every other write path reports a failed persist; this one used to
      // swallow it, so a rename that hit the storage quota looked applied
      // until the next launch put the old name back.
      if (row && !Slots.rename(row.dataset.id, inp.value)) toast(t("slot.saveFail"));
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
    if (history.length && !(await confirmNative(t("confirm.switchMode"), t("confirm.switchModeTitle"), { ok: t("confirm.switchOk"), cancel: t("dlg.cancel") }))) return;
    // 两边都能点,点了就把另一边带过去,而不是摆一个点不动的灰按钮让人猜为什么。
    const ruleFollowed = applyMode(b.dataset.mode);
    saveSettings();
    reset({ keepSettings: true });
    toast(t(ruleFollowed ? "toast.modeAiFree" : mode === "ai" ? "toast.modeAi" : "toast.modePvp"));
  };

  const ruleSeg = document.getElementById("rule-seg");
  if (ruleSeg) {
    ruleSeg.onclick = async (ev) => {
      const b = ev.target.closest("button[data-rule]");
      if (!b) return;
      const val = b.dataset.rule;
      if (val !== "free" && val !== "swap2" && val !== "renju") return;
      if (val === ruleChoice()) return;
      if (history.length && !(await confirmNative(t("confirm.switchRule"), t("confirm.switchRuleTitle"), { ok: t("confirm.switchOk"), cancel: t("dlg.cancel") }))) return;
      const modeFollowed = applyRuleChoice(val);
      saveSettings();
      reset({ keepSettings: true });
      toast(t(
        modeFollowed ? "toast.ruleRenjuPvp"
          : val === "renju" ? "toast.ruleRenju"
          : val === "swap2" ? "toast.ruleSwap2" : "toast.ruleFree"
      ));
    };
  }
  document.getElementById("diff-seg").onclick = (ev) => {
    const b = ev.target.closest("button[data-diff]");
    if (!b) return;
    difficulty = b.dataset.diff;
    saveSettings();
    syncSettingsUI();
    toast(t("toast.difficulty", { name: t("diff." + difficulty + ".full") }));
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
        t("toast.think", {
          name: (difficulty === "extreme"
            ? { fast: t("think.fast.maxName"), normal: t("think.normal.maxName"), deep: t("think.deep.maxName") }
            : { fast: t("think.fast.name"), normal: t("think.normal.name"), deep: t("think.deep.name") })[id],
        })
      );
    };
  }
  const langSeg = document.getElementById("lang-seg");
  if (langSeg) langSeg.onclick = (ev) => {
    const b = ev.target.closest("button[data-lang]");
    if (!b || b.dataset.lang === I18n.lang()) return;
    I18n.setLang(b.dataset.lang); // rewrites the static markup
    // …and everything drawn from state has to be rebuilt in the new language
    mlSig = "";
    syncSettingsUI();
    sync();
    toast(t("toast.language"));
  };
  document.getElementById("theme-seg").onclick = (ev) => {
    const b = ev.target.closest("button[data-theme]");
    if (!b) return;
    applyTheme(b.dataset.theme);
    const names = {
      wood: t("theme.wood.title"), night: t("theme.night.title"),
      day: t("theme.day.title"), notebook: t("theme.notebook.title"),
    };
    toast(t("toast.theme", { name: names[themeId] || themeId }));
  };
  document.getElementById("opt-sound").onclick = () => {
    soundOn = !soundOn;
    saveSettings();
    syncSettingsUI();
    if (soundOn) playMoveSound("b");
    toast(t(soundOn ? "toast.soundOn" : "toast.soundOff"));
  };
  const coordsBtn = document.getElementById("opt-coords");
  if (coordsBtn) {
    coordsBtn.onclick = () => {
      showCoords = !showCoords;
      saveSettings();
      syncSettingsUI();
      draw();
      toast(t(showCoords ? "toast.coordsOn" : "toast.coordsOff"));
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
      toast(t(analysisOn ? "toast.analysisOn" : "toast.analysisOff"));
    };
  }
  document.getElementById("color-seg").onclick = async (ev) => {
    const b = ev.target.closest("button[data-human]");
    if (!b) return;
    if (b.dataset.human === humanColor) return;
    if (mode === "ai" && history.length && !(await confirmNative(t("confirm.changeColor"), t("confirm.changeColorTitle"), { ok: t("confirm.changeColorOk"), cancel: t("dlg.cancel") }))) return;
    humanColor = b.dataset.human;
    saveSettings();
    if (mode === "ai") {
      reset({ keepSettings: true });
      toast(t(humanColor === "b" ? "toast.playBlack" : "toast.playWhite"));
    } else {
      syncSettingsUI();
    }
  };

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

  // 设置弹层（v1.51：外观那五项从常驻侧栏搬进来）。控件本身一个都没改，
  // 全部按 id 绑定（#theme-seg / #opt-coords / #opt-analysis / #lang-seg /
  // #opt-sound），所以搬家对它们的行为是透明的。
  const settingsModal = document.getElementById("settings-modal");
  function openSettings() {
    settingsModal.classList.add("show");
    const close = document.getElementById("settings-close");
    if (close) setTimeout(() => close.focus(), 0);
  }
  function closeSettings() { settingsModal.classList.remove("show"); }
  document.getElementById("settings-btn").onclick = openSettings;
  document.getElementById("settings-close").onclick = closeSettings;
  settingsModal.onclick = (ev) => { if (ev.target === settingsModal) closeSettings(); };
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
      if (settingsModal.classList.contains("show")) { closeSettings(); return; }
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
    if (settingsModal.classList.contains("show")) {
      trapModalTab(ev, settingsModal);
      return;
    }
    if (helpModal.classList.contains("show")) {
      if (ev.key === "?" || (ev.shiftKey && k === "/")) { closeHelp(); return; }
      trapModalTab(ev, helpModal);
      return;
    }
    if (ev.key === "?" || (ev.shiftKey && k === "/")) { openHelp(); return; }
    // Tab is deliberately NOT bound here any more. Through v1.31 it toggled the
    // sidebar, which meant focus never moved: 40 visible buttons, every one of
    // them focusable, and no key that could reach any of them — while the
    // dialogs had a full focus trap since v1.25.2. The sidebar already has
    // three other affordances (☰, [ and ], Esc), so Tab goes back to being Tab.
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
        if (history.length && !(await confirmNative(t("confirm.switchToPvp"), t("confirm.switchModeTitle"), { ok: t("confirm.switchOk"), cancel: t("dlg.cancel") }))) return;
        applyMode("pvp");
        saveSettings();
        reset({ keepSettings: true });
        toast(t("toast.modePvp"));
      })();
    } else if ((ev.metaKey || ev.ctrlKey) && k === "2") {
      ev.preventDefault();
      if (mode === "ai") return;
      (async () => {
        if (history.length && !(await confirmNative(t("confirm.switchToAi"), t("confirm.switchModeTitle"), { ok: t("confirm.switchOk"), cancel: t("dlg.cancel") }))) return;
        const ruleFollowed = applyMode("ai");
        saveSettings();
        reset({ keepSettings: true });
        toast(t(ruleFollowed ? "toast.modeAiFree" : "toast.modeAi"));
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
    syncScrollEdges();
  });

  {
    const sc = document.getElementById("side-scroll");
    if (sc) sc.addEventListener("scroll", syncScrollEdges, { passive: true });
    syncScrollEdges();
  }

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
  I18n.load();
  I18n.apply();
  // Version was invisible in-app through v1.29 — the only place it appeared
  // was the AP[] stamp inside an exported 棋谱. Same single source (version.js).
  const verEl = document.getElementById("app-version");
  if (verEl) verEl.textContent = window.GOBAN_VERSION || "—";
  document.documentElement.setAttribute("lang", I18n.lang() === "en" ? "en" : "zh-CN");
  document.documentElement.setAttribute("data-theme", themeId);
  const savedPanel = Host.storageGet(PANEL_KEY);
  // Restore the user's own choice; always run setPanelOpen so inert/aria apply.
  // First run stores nothing, and a closed sidebar leaves exactly five buttons
  // on screen (悔棋/提示/新局/?/☰) — 练习/每日/复盘/统计/存档 all sit behind ☰
  // with nothing pointing at it. So open it once, and only where it can sit
  // beside the board: under 900px it becomes a sheet over the board, which is
  // a worse first impression than an entry the user has not found yet.
  setPanelOpen(savedPanel == null ? window.innerWidth >= 900 : savedPanel === "1");

  const resumed = tryLoadSave();
  if (resumed) {
    gameGen += 1;
    if (result !== "play" && lastStatsEndedAt) statsRecordedGen = gameGen;
    toast(t("game.restored"));
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

  // --- whole-app backup / restore ---
  const backupExport = document.getElementById("backup-export");
  if (backupExport) backupExport.onclick = async () => {
    try {
      const text = Backup.serialize(Host);
      const n = Object.keys(JSON.parse(text).data).length;
      await SgfIo.exportString(text, Backup.fileName());
      toast(t("backup.done", { n: n }));
    } catch (_) {
      toast(t("backup.fail"));
    }
  };

  const backupImport = document.getElementById("backup-import");
  if (backupImport) backupImport.onclick = async () => {
    if (!Host.hasZero()) { toast(t("file.unsupported")); return; }
    let text;
    try {
      const files = await Host.openFileDialog({ title: t("backup.import"), allowMultiple: false });
      const paths = Host.normalizePaths(files);
      if (!paths.length) { toast(t("file.cancelled")); return; }
      text = await readTextFile(paths[0]);
    } catch (_) {
      toast(t("file.openFail"));
      return;
    }
    // Validate BEFORE asking: no point warning about an irreversible
    // overwrite that the file cannot perform anyway.
    const chk = Backup.inspect(text);
    if (!chk.ok) {
      toast(t(chk.error === "version" ? "backup.badVersion" : chk.error === "empty" ? "backup.empty" : "backup.badFile"));
      return;
    }
    const go = await confirmNative(t("backup.confirm"), t("backup.confirmTitle"),
      { ok: t("backup.confirmOk"), cancel: t("dlg.cancel") });
    if (!go) return;
    const res = Backup.restore(Host, text);
    if (!res.ok) { toast(t("backup.badFile")); return; }
    toast(t("backup.restored", { n: res.restored }));
    // Reload rather than re-wire: every module read its key at boot, and
    // rebuilding all of that state in place is far more code — and far more
    // ways to leave half the app looking at the old profile.
    setTimeout(() => window.location.reload(), 600);
  };
  Host.onDropFiles((detail) => {
    const paths = Host.normalizePaths((detail && detail.paths) || detail);
    const sgfPath = paths.find((p) => /\.sgf$/i.test(p));
    if (sgfPath) importSgfFromPath(sgfPath);
    else if (paths.length) toast(t("file.dropSgfOnly"));
  });
clockTimer = setInterval(updateClock, 500);

})();
