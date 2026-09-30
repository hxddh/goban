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
  const Review = window.GobanReview;
  const Stats = window.GobanStats;
  const Backup = window.GobanBackup;
  const Practice = window.GobanPractice;
  const Archive = window.GobanArchive;
  const Session = window.GobanSession;
  const SIZE = Core.SIZE;
  const WIN = Core.WIN;
  const SAVE_KEY = "goban.v12.save";
  const SETTINGS_KEY = "goban.v11.settings";

  const canvas = document.getElementById("board");
  const ctx = canvas.getContext("2d");
  const appEl = document.getElementById("app");
  // v1.74:「新局」卡片与「⋯」菜单(接线在 wireMenus)
  const sheetEl = document.getElementById("new-sheet");
  const menuEl = document.getElementById("more-menu");
  /** 卡片里还没生效的选择;null = 卡片关着(四格显示偏好)。 */
  let sheet = null;
  /** v1.75:练习开着时顶栏那一句(题集 · 进度);空串 = 没在练习 */
  let practiceStatus = "";
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
    if (diff === "normal") return 400; // v1.65:普档换成 C3,预算 250 → 400ms
    return 240; // v1.66:入门换成 C3,240ms 让普对入门约七成半(REVIEW-v1.65 §3 E2)
  }

  /** 档位 → 引擎只有一张表:GobanTier(ai3.js)。v1.66 起四档都走 C3。 */
  function engineFor(diff) {
    return window.GobanTier ? window.GobanTier.engineFor(diff) : Ai;
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
    // 规则随棋谱走(v1.63):RU[Renju] 的棋谱在自由档下也按连珠读,反之亦然。
    // 没写 RU 的棋谱保持当前规则。切换只影响这一局,设置里的档位不动。
    const importRule = parsed.ruleSet === "renju" || parsed.ruleSet === "free" ? parsed.ruleSet : ruleSet;
    const applied = GameState.sessionFromHistory(parsed.history, {
      mode: mode,
      difficulty: difficulty,
      humanColor: humanColor,
      soundOn: soundOn,
      themeId: themeId,
      gameGen: gameGen,
      ruleSet: importRule,
    });
    if (!applied.ok) {
      toast(applied.error || t("import.fail"));
      return false;
    }
    const s = applied.session;
    const ruleSwitched = importRule !== ruleSet;
    if (ruleSwitched) {
      ruleSet = importRule;
      if (isRenju()) openingRule = "standard";
    }
    endRetry(false);
    hideEndCard();
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
    const hint = t(importPaused ? "import.hint.continue" : "import.hint.reviewOnly")
      + (ruleSwitched ? t(isRenju() ? "import.hint.ruleRenju" : "import.hint.ruleFree") : "");
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
   * 三条禁手约束、且只有恰好五连才算胜。
   *
   * v1.54 里 renju 档只开双人:两个引擎不认识禁手,实测执黑 24 局有 8(C1)/
   * 10(C2)局走出禁手。v1.55 起引擎在**交货口**验一次(见 GobanAi.legalizeRenju)
   * —— 12 局自战违规手 0,所以人机档开了回来。搜索内部仍按自由式算,那一层的
   * 动态判定要在引擎自己的扁平棋盘上重写,不在这一版。
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

  function hasZero() { return Host.hasZero(); }

  function clearHint() {
    hintCell = null;
  }

  // v1.72:「复盘分析」开关连同它的逐手评语一起退役(复盘面板已逐手解释失着)。
  // 名字留着:每一处改棋盘的地方都经过这里,整局复盘的缓存跟着失效。
  function clearAnalysis() {
    Review.invalidate();
  }

  /**
   * High-confidence verdict for the move that led to position `i`, computed
   * instantly from tactical primitives (no engine think). Returns null when
   * there's no hard call — the soft best/other verdict is decided async.
   */
  /**
   * 成五的点在连珠下**永远不是禁手**(成五优先于一切禁手),所以黑的「五」照旧算胜;
   * 被规则拿掉的只有六连 —— 自由式当胜,连珠是长连禁手。这里把两处硬判定都换成
   * 规则版,`listWinCells` 的结果也照同一条筛一遍。白方不受影响,原样返回。
   */
  function winCellsRule(board, color) {
    const cells = Ai.listWinCells(board, color);
    if (!isRenju() || color !== "b") return cells;
    return cells.filter((m) => Core.wouldWinRule(board, m.r, m.c, "b", true));
  }

  function coachFacts(preBoard, sColor, played) {
    const oppC = opp(sColor);
    const playedWins = Core.wouldWinRule(preBoard, played.r, played.c, sColor, isRenju());
    if (playedWins) return { grade: "best", key: "coach.winning" };
    // missed win: a five was available but not taken
    const myWins = winCellsRule(preBoard, sColor);
    if (myWins.length) return { grade: "blunder", kind: "missedWin", key: "coach.missedWin", best: myWins[0] };
    // allowed opponent win-in-1 the move failed to prevent
    const after = preBoard.map((row) => row.slice());
    after[played.r][played.c] = sColor;
    if (winCellsRule(after, oppC).length) return { grade: "blunder", kind: "missedBlock", key: "coach.missedBlock" };
    return null;
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
    // v1.71:下完的局早已自动存进对局记录,不必再问「放弃当前对局?」
    if (history.length && result === "play") {
      const ok = await confirmNative(
        t("newgame.confirm"),
        t("newgame.ok"),
        { ok: t("newgame.ok"), cancel: t("dlg.cancel") }
      );
      if (!ok) return;
    }
    // reset() bumps gameGen so any in-flight AI timeout cannot place.
    reset(); // v1.71:棋盘清空就是反馈,不再弹「新局已开始」
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
    sync();
  }

  async function requestHint() {
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
        hintCell = { r: m.r, c: m.c }; // 虚线十字本身就是反馈;状态胶囊写着「· 有提示」
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

  /**
   * 用时从**第一颗子**算起,不从打开应用算起(v1.63)。此前 startedAt 在开局态就
   * 开始走,盘上一子未落时钟已经在跑,于是「本局用时」里混着发呆的时间。
   */
  function nowElapsed() {
    if (result !== "play") return elapsedBaseMs;
    if (!history.length && !swap2) return elapsedBaseMs;
    return elapsedBaseMs + (Date.now() - startedAt);
  }

  /** 设置存储里从来没有东西 = 第一次启动(启动末尾会写一次,所以第二次就不是了) */
  let firstRun = false;

  function loadSettings() {
    try {
      const raw = Host.storageGet(SETTINGS_KEY);
      if (!raw) { firstRun = true; return; }
      const s = JSON.parse(raw);
      prefs = Session.readPrefs(s);
      if (s.lastHumanColor === "b" || s.lastHumanColor === "w") lastHumanColor = s.lastHumanColor;
      if (typeof s.soundOn === "boolean") soundOn = s.soundOn;
      if (s.themeId && THEMES[s.themeId]) themeId = s.themeId;
      if (s.thinkLevel === "fast" || s.thinkLevel === "normal" || s.thinkLevel === "deep") {
        thinkLevel = s.thinkLevel;
      }
      if (typeof s.showCoords === "boolean") showCoords = s.showCoords;
      /* v1.72:analysisOn 已退役,旧设置里的这一项忽略 */
    } catch (_) {}
    gameFromPrefs();
  }

  function saveSettings() {
    // 存的是**偏好**,不是这一局(见 session.js):导入的棋谱、库里的旧局、重下都会
    // 临时改掉这一局的模式 / 执子 / 规则,但不该顺手改掉玩家在侧栏选的那几格。
    Host.storageSet(
      SETTINGS_KEY,
      JSON.stringify(Object.assign(Session.prefsToStore(prefs), { soundOn, themeId, thinkLevel, showCoords, lastHumanColor }))
    );
  }

  /**
   * 新局从偏好开:这一局的五个字段整份抄自偏好。执子「轮流」时看上一局(v1.67):
   * prevPlayed = 被替换的那一局玩家落过子;只有落过子才换色,空盘上调设置、启动恢复都不换。
   */
  function gameFromPrefs(prevPlayed, prevColor) {
    ({ mode, difficulty, humanColor, ruleSet, openingRule } =
      Session.gameFromPrefs(prefs, { last: prevColor || lastHumanColor, prevPlayed: !!prevPlayed }));
    if (mode === "ai" && humanColor !== lastHumanColor) {
      lastHumanColor = humanColor;
      return true;
    }
    return false;
  }

  function isRenju() { return ruleSet === "renju"; }

  /**
   * 唯一改 mode 的入口。三个入口(分段控件、⌘1、⌘2)共用这一处,否则总会漏掉一个。
   *
   * v1.54 时这里还要把规则一并带回自由 —— 那时禁手只开双人。v1.55 起引擎交货口
   * 已保证合法,禁手与人机是一个正常组合,这层联动连同它的返回值一起没了。
   */
  function applyMode(next) { mode = next; prefs.mode = next; }

  /**
   * 侧栏那一格三选一映射到的两个内部字段。swap2 与禁手都是「黑先手占优,拿
   * 什么补」的答案,所以它们互斥;而 openingRule 与 ruleSet 分开存,是因为
   * swap2 的协议和禁手的判定是两套互不相干的代码。
   * @returns {'free'|'swap2'|'renju'}
   */
  function ruleChoice() { return Session.ruleOf(ruleSet, openingRule); }

  /**
   * 侧栏四格(模式 / 难度 / 执子 / 规则)的选择。mode / difficulty / humanColor /
   * ruleSet / openingRule 是**这一局**的,可以被棋谱、旧局、重下、swap2 临时改掉;
   * 新局一律从这里开,设置存储里也只存这一份。
   */
  let prefs = Object.assign({}, Session.DEFAULT_PREFS);
  /** 上一局人机对局里玩家执哪色 —— 「轮流」靠它(进设置存储,跨启动)。 */
  let lastHumanColor = null;

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
      // 重下关键一手时原局整个存在这里,回来时原样恢复(v1.63)
      retry: retry ? { ply: retry.ply, gameId: retry.gameId, source: retry.source } : null,
      archiveId: lastArchiveId,
      savedAt: Date.now(),
    };
  }

  let saveOk = true;
  function saveGame() {
    try {
      const ok = Host.storageSet(SAVE_KEY, JSON.stringify(serialize()));
      // v1.70:自动保存不再在侧栏报时间(它本该是看不见的);只在由好转坏的那一次说一声
      if (!ok && saveOk) toast(t("save.failed"));
      saveOk = ok;
    } catch (_) {}
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
    if (isRenju()) openingRule = "standard";
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
    retry = s.retry && typeof s.retry.ply === "number" && s.retry.source ? { ply: s.retry.ply, gameId: s.retry.gameId || null, source: s.retry.source } : null;
    lastArchiveId = typeof s.archiveId === "string" ? s.archiveId : null;
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

  // v1.72:命名存档退役 —— 没下完的棋自动存档,下完的自动进「最近对局」。老用户存过的
  // 命名存档在启动时并进「最近对局」(一次性,并入成功才删原键;备份里的旧键恢复后照样会并入)。
  function migrateSlots() {
    const KEY = "goban.v12.slots";
    let arr = [];
    try { arr = JSON.parse(Host.storageGet(KEY) || "[]"); } catch (_) { arr = []; }
    if (!Array.isArray(arr) || !arr.length) return;
    let ok = true;
    for (const sl of arr.slice().reverse()) { // 最旧的先进,最新的留在最上面
      const sn = sl && sl.snap;
      if (!sn || !Array.isArray(sn.history) || !sn.history.length) continue;
      const id = Archive.add({
        history: sn.history, ruleSet: sn.ruleSet, mode: sn.mode, difficulty: sn.difficulty,
        humanColor: sn.humanColor, result: sn.result || "play",
        startedAt: sn.originalStartedAt || sn.startedAt, endedAt: sl.savedAt || Date.now(),
        durationMs: sn.elapsedBaseMs || 0,
      });
      if (!id) ok = false;
    }
    if (ok) Host.storageRemove(KEY);
  }

  function openSlots() {
    renderStatsIn();
    renderGamesList();
    const m = document.getElementById("slots-modal");
    if (m) {
      m.classList.add("show");
      const focusEl = document.getElementById("slots-close");
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
    getRenju: isRenju,
    winCells: winCellsRule,
    aiMoveAsync: (o) => aiMoveAsync(o),
  });

  /**
   * 复盘弹层里点一处失着:跳到那一手,关掉弹层 —— 但解释不丢。v1.62 以前跳转后
   * 只剩棋盘和手数列表,用户失去刚刚的诊断上下文;现在侧栏的复盘面板常驻,
   * 列着全部失着、说着当前这一手的「威胁 → 落点 → 惩罚 → 替代」,并给重试入口。
   */

  /**
   * v1.54–v1.55 期间禁手档下这里只弹一句 toast,弹层根本不开。当时给了两条理由,
   * v1.56 逐条复查 —— 一条早就不成立,一条已经修掉:
   *
   * 1. **「会把禁手点当成更优点」** —— 从 v1.55 起就已经是假的。「更优点」走
   *    `aiMoveAsync`,而 `Engine.init` 的 defaults 带着 `renju: isRenju()`,
   *    `withDefaults` 把它填进 payload 一路送到 worker,最后落在 `legalizeRenju`
   *    的交货口上 —— 和提示同一道闸。当时把提示开了回来,却没发现同一条通路
   *    也把这一半解决了。
   * 2. **「会把黑的六连当成胜」** —— 这条是真的,现由 `Core.wouldWinRule` 修掉
   *    (见 coachFacts / winCellsRule)。
   *
   * 剩下的唯一偏差是曲线自己:`evalStatic` 不知道黑受限。实测 8 局合法连珠自战
   * 341 手黑棋,黑的静态首选点有 12 次(**3.52%**)是禁手点,曲线在这些局面偏乐观。
   * 权衡:继续关着,用户得到 0;开着,得到完全正确的硬判定、合法的更优点,和一条
   * 已知在 3.5% 上偏乐观的曲线。选后者,并把这句话放进弹层(#review-renju-note),
   * 而不是藏进发布说明。
   */
  function openReview() {
    if (history.length < 2) { toast(t("review.empty")); return; }
    // v1.64:复盘只有侧栏这一个面。终局卡是它的摘要,复盘一开,摘要让位。
    hideEndCard();
    Review.setSideOpen(true);
    Review.compute();
    startDeepen();
    // v1.74(B11):打开复盘就停在最值得看的那一手,解释直接在 —— 此前面板里只有
    // 一枚手数和一句「点上面的手数看解释」,整局只有一手失着也要再点一下
    if (!Review.explain(viewIndex)) {
      const focus = mode === "ai" ? humanColor : (result === "b" ? "w" : result === "w" ? "b" : null);
      const key = Review.keyMoves(focus)[0] || Review.keyMoves(null)[0];
      if (key) { setViewIndex(key.i); return; }
    }
    sync();
  }

  /** SGF with per-move 失着 comments + a summary root comment (复盘评注导出). */
  function buildAnnotatedSgf() {
    const rd = Review.compute();
    const comments = {};
    const variations = {};
    for (const b of rd.blunders) {
      comments[b.i - 1] = t("review.cmt.blunder", { reason: b.reason });
      // 更优点写成兄弟变着;重下关键一手留下的分支也一并写入
      if (b.best && !(b.best.r === history[b.i - 1].r && b.best.c === history[b.i - 1].c)) {
        const line = [b.best];
        line.comment = t("review.cmt.alt", { reason: b.reason });
        variations[b.i - 1] = [line];
      }
    }
    const g = lastArchiveId ? Archive.get(lastArchiveId) : null;
    for (const l of (g && g.lines) || []) {
      if (!l.moves || !l.moves.length) continue;
      const line = l.moves.slice();
      line.comment = t("review.cmt.retry");
      variations[l.ply - 1] = (variations[l.ply - 1] || []).concat([line]);
    }
    const s = rd.summary;
    const rootComment =
      t("review.cmt.root", {
        b: s.b, w: s.w, n: history.length,
        clean: s.b + s.w === 0 ? t("review.cmt.clean") : "",
      });
    return SgfMod.buildSgf({
      history, result, mode, humanColor, originalStartedAt,
      ruleSet, comments, rootComment, variations,
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
    sync();
    toast(pv.length ? t("pv.done", { n: pv.length }) : t("pv.none"));
  }

  // --- v1.63: 复盘第二遍(引擎比较) ---
  let deepenTimer = null;
  function startDeepen() {
    if (deepenTimer) { clearTimeout(deepenTimer); deepenTimer = null; }
    if (history.length < 2 || aiThinking) return;
    const gen = gameGen;
    // 引擎比较用 hard 档;极档预算太大,而这里要的是「同一预算下的首选」而不是最强
    deepenTimer = setTimeout(() => {
      deepenTimer = null;
      if (gen !== gameGen || aiThinking) return;
      Review.deepen({
        difficulty: "hard",
        onProgress: () => { if (gen === gameGen) sync(); },
      }).then(() => { if (gen === gameGen) sync(); });
    }, 50);
  }

  // --- v1.63: 重下关键一手(retry) ---
  /**
   * 重下关键一手:把当前局面回退到失着落下之前,锁成一盘人机练习局(人执失着
   * 那一方,电脑按原规则应手)。原局整个存在 retry.source 里,随时回去,一手不改。
   * @type {{ply:number, gameId:string|null, source:object}|null}
   */
  let retry = null;

  function startRetry(ply) {
    if (!history.length || ply < 1 || ply > history.length) return;
    if (retry && ply > retry.ply) return; // 那一手只在重下线上,原局里没有它
    if (retry) {
      // 重下之中再重下:以原局为准,不嵌套
      const src = retry.source;
      applySnapshot(src);
    }
    abortThinking();
    const source = serialize();
    source.retry = null;
    const gameId = lastArchiveId;
    const color = (ply - 1) % 2 === 0 ? "b" : "w";
    const base = history.slice(0, ply - 1);
    retry = { ply: ply, gameId: gameId, source: source };
    gameGen += 1;
    history = base;
    mode = "ai";
    humanColor = color;
    if (difficulty === "easy") difficulty = "normal"; // 重下要能被惩罚,简单档不算数
    board = boardAfter(history.length);
    turn = history.length % 2 === 0 ? "b" : "w";
    result = "play";
    winLine = null;
    viewIndex = history.length;
    importPaused = false;
    swap2 = null;
    hideSwap2Bar();
    aiThinking = false;
    hintBusy = false;
    statsRecordedGen = -1;
    lastStatsEndedAt = null;
    startedAt = Date.now();
    elapsedBaseMs = 0;
    hoverCell = null;
    clearHint();
    clearAnalysis();
    clearVariation();
    hideEndCard();
    Review.setSideOpen(false);
    sync();
    saveGame();
    toast(t("retry.started", { n: ply }));
    maybeAiTurn();
  }

  /** 回到原局。restoreView = 回到重下的那一手,便于对照。 */
  function endRetry(restoreView) {
    if (!retry) return false;
    abortThinking();
    const src = retry.source;
    const ply = retry.ply;
    retry = null;
    gameGen += 1;
    if (!applySnapshot(src)) { reset(); return true; }
    if (result !== "play" && lastStatsEndedAt) statsRecordedGen = gameGen;
    hideEndCard();
    clearAnalysis();
    if (restoreView) {
      Review.setSideOpen(true);
      Review.compute();
      setViewIndex(ply);
    } else {
      sync();
    }
    saveGame();
    return true;
  }

  function syncRetryBar() {
    const bar = document.getElementById("retry-bar");
    if (!bar) return;
    bar.hidden = !retry;
    if (!retry) return;
    const msg = document.getElementById("retry-msg");
    if (msg) msg.textContent = t("retry.bar", { n: retry.ply, who: t(humanColor === "b" ? "side.black" : "side.white") });
  }

  /** v1.74(B10):「第 11 手」「move 11」内部用不断行空格粘住,换行不会把数字和「手」拆开 */
  function glueMove(text) {
    return String(text).replace(/\u7b2c (\d+) \u624b/g, "\u7b2c\u00a0$1\u00a0\u624b").replace(/\b(move|Move) (\d+)/g, "$1\u00a0$2");
  }

  // --- v1.63: 终局总结卡 ---
  let endCardOn = false;
  function showEndCard() {
    endCardOn = true;
    Review.compute();
    startDeepen();
    syncEndCard();
  }
  function hideEndCard() { endCardOn = false; syncEndCard(); }

  function syncEndCard() {
    const card = document.getElementById("end-card");
    if (!card) return;
    const show = endCardOn && result !== "play" && history.length > 0;
    card.hidden = !show;
    if (!show) return;
    const title = document.getElementById("end-card-title");
    const body = document.getElementById("end-card-body");
    const retryBtn = document.getElementById("end-card-retry");
    const backBtn = document.getElementById("end-card-back");
    const reviewBtn = document.getElementById("end-card-review");
    const againBtn = document.getElementById("end-card-again");
    // 结果一句
    let head;
    if (retry) head = t(result === "draw" ? "endcard.retryDraw" : result === humanColor ? "endcard.retryWin" : "endcard.retryLoss");
    else if (result === "draw") head = t("result.draw");
    else if (mode === "ai") head = t(result === humanColor ? "endcard.win" : "endcard.loss");
    else head = t(result === "b" ? "status.blackWin" : "status.whiteWin");
    if (title) title.textContent = head;
    // 本局值得记住的一手:人机看人那一方,双人看输的一方
    const focusColor = mode === "ai" ? humanColor : (result === "b" ? "w" : result === "w" ? "b" : null);
    const keys = Review.keyMoves(retry ? null : focusColor);
    const key = keys[0] || null;
    if (body) {
      body.innerHTML = "";
      const rd = Review.getData();
      if (retry) {
        const p = document.createElement("div");
        p.textContent = t("endcard.retryHint", { n: retry.ply });
        body.appendChild(p);
      } else if (!key) {
        const p = document.createElement("div");
        p.className = "muted";
        p.textContent = t(rd && rd.deepening ? "endcard.analysing" : "endcard.clean");
        body.appendChild(p);
      } else {
        const info = Review.explain(key.i);
        const p = document.createElement("div");
        p.className = "endcard-key";
        p.textContent = glueMove(t("endcard.key", { n: key.i, color: t(key.color === "b" ? "side.black" : "side.white"), reason: key.reason }));
        body.appendChild(p);
        if (info && info.lines.length) {
          const q = document.createElement("div");
          q.className = "muted endcard-line";
          q.textContent = info.lines[info.lines.length - 1];
          body.appendChild(q);
        }
        if (keys.length > 1) {
          const more = document.createElement("div");
          more.className = "muted endcard-more";
          more.textContent = t("endcard.more", { list: keys.slice(1).map((k) => k.i).join(t("list.sep")) });
          body.appendChild(more);
        }
      }
    }
    if (retryBtn) {
      retryBtn.hidden = !key || !!retry;
      if (key) { retryBtn.dataset.ply = String(key.i); retryBtn.textContent = t("endcard.retry", { n: key.i }); }
    }
    if (backBtn) backBtn.hidden = !retry;
    if (reviewBtn) reviewBtn.hidden = !!retry;
    // v1.71:终局卡只留两个动作(重下关键一手 · 看复盘);「再来一局」就是顶栏高亮的「新局」,
    // 只在重下线上留一个「再试一次」—— 那是练习闭环里的下一步,顶栏没有它
    if (againBtn) againBtn.hidden = !retry;
  }


  // --- v1.64: 初见一句话 ---
  let welcomeOn = false;
  function syncWelcome() {
    const el = document.getElementById("welcome-bar");
    if (!el) return;
    if (welcomeOn && (history.length > 0 || swap2 || retry || importPaused)) welcomeOn = false;
    el.hidden = !welcomeOn;
  }
  function wireWelcome() {
    const close = () => { welcomeOn = false; syncWelcome(); };
    const d = document.getElementById("welcome-daily");
    if (d) d.onclick = () => { close(); Practice.openDaily(); };
    const x = document.getElementById("welcome-close");
    if (x) x.onclick = close;
  }

  function wireEndCard() {
    const retryBtn = document.getElementById("end-card-retry");
    if (retryBtn) retryBtn.onclick = () => { startRetry(Number(retryBtn.dataset.ply)); };
    const backBtn = document.getElementById("end-card-back");
    if (backBtn) backBtn.onclick = () => { endRetry(true); toast(t("retry.back")); };
    const reviewBtn = document.getElementById("end-card-review");
    if (reviewBtn) reviewBtn.onclick = () => { openReview(); };
    const againBtn = document.getElementById("end-card-again");
    if (againBtn) againBtn.onclick = () => {
      if (retry) { const ply = retry.ply; endRetry(false); startRetry(ply); }
    };
    const closeBtn = document.getElementById("end-card-close");
    if (closeBtn) closeBtn.onclick = () => { hideEndCard(); };
  }

  // --- v1.63: 侧栏复盘面板 ---
  function wireReviewSide() {
    const chips = document.getElementById("review-side-chips");
    if (chips) chips.addEventListener("click", (ev) => {
      if (ev.target.closest("button[data-more]")) { Review.toggleSoft(); sync(); return; }
      const b = ev.target.closest("button[data-i]");
      if (b) setViewIndex(Number(b.dataset.i));
    });
    const retryBtn = document.getElementById("review-side-retry");
    if (retryBtn) retryBtn.onclick = () => { if (Review.explain(viewIndex)) startRetry(viewIndex); };
    const practiceBtn = document.getElementById("review-side-practice");
    if (practiceBtn) practiceBtn.onclick = () => {
      const gid = lastArchiveId;
      if (!gid || !Practice.openFor(gid, viewIndex)) toast(t("practice.noneForMove"));
    };
    const pvBtn = document.getElementById("review-side-pv");
    if (pvBtn) pvBtn.onclick = () => { runVariation(); };
    const closeBtn = document.getElementById("review-side-close");
    if (closeBtn) closeBtn.onclick = () => { Review.setSideOpen(false); sync(); };
    const retryBack = document.getElementById("retry-back");
    if (retryBack) retryBack.onclick = () => { endRetry(true); toast(t("retry.back")); };
  }

  // --- v1.63: 对局库 ---
  /** 打开对局库里的一局:下完的以复盘打开(停在第 ply 手、侧栏复盘面板打开);没下完的接着下。 */
  async function openArchivedGame(id, ply) {
    const g = Archive.get(id);
    if (!g) { toast(t("games.missing")); return; }
    if (history.length && result === "play" && !retry && lastArchiveId !== id) {
      const ok = await confirmNative(t("games.openConfirm"), t("games.openTitle"), { ok: t("games.open"), cancel: t("dlg.cancel") });
      if (!ok) return;
    }
    abortThinking();
    retry = null;
    gameGen += 1;
    const snap = {
      v: 4, history: g.history, mode: g.mode, difficulty: g.difficulty || difficulty,
      humanColor: g.humanColor || "b", ruleSet: g.ruleSet, elapsedBaseMs: g.durationMs || 0,
      // 不带 statsEndedAt:那是「这次会话记下的终局」的凭据,悔棋拿它去撤统计、删对局库。
      // 库里的旧局早已记过,打开来看、悔棋接着下,都不该把它从库里抹掉。
      originalStartedAt: g.startedAt, importPaused: false, archiveId: g.id,
    };
    if (!applySnapshot(snap)) { toast(t("games.missing")); return; }
    hideEndCard(); // 终局卡属于刚下完的那一局;打开旧局是复盘,侧栏复盘面板接手
    lastArchiveId = g.id;
    if (result !== "play") statsRecordedGen = gameGen; // 已经记过,不再记
    closeSlots();
    clearAnalysis();
    // v1.73(B9):没下完的局是「接着下」,不是复盘
    const resume = result === "play";
    if (!resume) {
      Review.setSideOpen(true);
      Review.compute();
      startDeepen();
    }
    setViewIndex(typeof ply === "number" ? Math.max(0, Math.min(ply, history.length)) : history.length);
    saveGame();
    toast(t(resume ? "games.resumed" : "games.opened"));
    if (resume) maybeAiTurn();
  }

  function renderGamesList() {
    const list = document.getElementById("games-list");
    const empty = document.getElementById("games-empty");
    if (!list) return;
    const arr = Archive.load();
    if (empty) empty.hidden = arr.length > 0;
    list.innerHTML = "";
    for (const g of arr.slice(0, 20)) {
      const row = document.createElement("div");
      row.className = "slot-row game-row";
      row.dataset.id = g.id;
      const name = document.createElement("div");
      name.className = "game-name";
      const d = new Date(g.endedAt || Date.now());
      const p = (n) => String(n).padStart(2, "0");
      const when = p(d.getMonth() + 1) + "-" + p(d.getDate()) + " " + p(d.getHours()) + ":" + p(d.getMinutes());
      const res = g.result === "play" ? t("result.playing") : g.mode === "ai"
        ? t(g.result === "draw" ? "result.draw" : g.result === g.humanColor ? "games.win" : "games.loss")
        : t(g.result === "b" ? "result.blackWin" : g.result === "w" ? "result.whiteWin" : "result.draw");
      name.textContent = t("games.row", {
        when: when, result: res, moves: g.history.length,
        mode: g.mode === "ai" ? t("diff." + (g.difficulty || "normal") + ".full") : t("mode.pvp"),
        rule: g.ruleSet === "renju" ? t("rule.renju") : t("rule.free"),
      });
      const ops = document.createElement("div");
      ops.className = "slot-ops";
      for (const spec of [
        { cls: "text-link game-open", key: "games.review" },
        { cls: "text-link danger game-del", key: "slots.del" },
      ]) {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = spec.cls;
        btn.dataset.id = g.id;
        btn.textContent = t(spec.key);
        ops.appendChild(btn);
      }
      row.appendChild(name);
      row.appendChild(ops);
      list.appendChild(row);
    }
  }

  function syncDailyBadge() {
    const badge = document.getElementById("daily-badge");
    if (!badge) return;
    let n = 0;
    try { n = Practice.dueCount(); } catch (_) { n = 0; }
    badge.hidden = !n;
    badge.textContent = n ? String(n) : "";
    badge.setAttribute("aria-label", n ? t("foot.daily.due", { n: n }) : "");
    // v1.74:「练习」收进「⋯」,到期数同时挂在「⋯」上 —— 菜单关着也看得见
    const more = document.getElementById("more-badge");
    if (more) { more.hidden = !n; more.textContent = n ? String(n) : ""; }
  }

  // --- v1.63: 键盘落子 ---
  /** 键盘游标所在交叉点;canvas 有焦点时方向键移动、Enter 落子。 */
  let kbCell = null;
  function announce(text) {
    const el = document.getElementById("board-announce");
    if (el) el.textContent = text;
  }
  function cellLabel(r, c) { return String.fromCharCode(65 + c) + (SIZE - r); }
  function describeCell(r, c) {
    const s = board[r][c];
    let state;
    if (s) state = t(s === "b" ? "kb.black" : "kb.white");
    else {
      const why = forbiddenReason(board, r, c, turn);
      state = why ? t("renju.blocked." + why) : t("kb.empty");
    }
    return t("kb.at", { cell: cellLabel(r, c), state: state });
  }
  function handleBoardKey(ev) {
    const k = ev.key;
    if (k === "ArrowLeft" || k === "ArrowRight" || k === "ArrowUp" || k === "ArrowDown") {
      ev.preventDefault();
      if (!kbCell) kbCell = { r: 7, c: 7 };
      else {
        if (k === "ArrowLeft") kbCell.c = Math.max(0, kbCell.c - 1);
        if (k === "ArrowRight") kbCell.c = Math.min(SIZE - 1, kbCell.c + 1);
        if (k === "ArrowUp") kbCell.r = Math.max(0, kbCell.r - 1);
        if (k === "ArrowDown") kbCell.r = Math.min(SIZE - 1, kbCell.r + 1);
      }
      hoverCell = canHoverPlace() && !board[kbCell.r][kbCell.c]
        ? { r: kbCell.r, c: kbCell.c, color: nextPlaceColor() }
        : null;
      kbCursor = { r: kbCell.r, c: kbCell.c };
      announce(describeCell(kbCell.r, kbCell.c));
      draw();
      return true;
    }
    if ((k === "Enter" || k === " ") && kbCell) {
      ev.preventDefault();
      if (!canHoverPlace()) { announce(t("kb.cannot")); return true; }
      const r = kbCell.r, c = kbCell.c;
      place(r, c, false);
      if (history.length && history[history.length - 1].r === r && history[history.length - 1].c === c) {
        announce(t("kb.placed", { cell: cellLabel(r, c), who: t((history.length - 1) % 2 === 0 ? "side.black" : "side.white") }));
      }
      return true;
    }
    if (k === "Escape") { kbCell = null; kbCursor = null; hoverCell = null; draw(); canvas.blur(); return true; }
    return false;
  }
  let kbCursor = null;
  canvas.addEventListener("blur", () => { kbCursor = null; kbCell = null; if (hoverCell) { hoverCell = null; draw(); } });
  canvas.addEventListener("focus", () => { announce(t("kb.focus")); });


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
    variation: variationCells,
    forbidden: forbiddenPoints(),
    cursor: kbCursor,
    coords: showCoords,
    clearPlaceAnim: () => { placeAnim = null; },
  }));

  function resizeCanvas() { Draw.resizeCanvas(); }

  /**
   * 坞(终局卡 / 重下 / 复盘 / 练习卡片 / 初见一句话)放在哪、棋盘多大。
   *
   * v1.74 只在「宽 − 高 ≥ 480」时把坞放在棋盘右侧,其余一律放在下方、棋盘让出坞的高度 ——
   * 1024×600 复盘时棋盘只剩 239px(B15)。v1.75:**横向窗口(宽 ≥ 高)一律放在旁边**。
   * 棋盘两侧放得下,棋盘原地不动;放不下,棋盘与坞当成一组居中(棋盘左移,必要时略缩),
   * 但永远不再为坞让出高度。只有竖长窗口才放在下方。
   */
  const DOCK_W = 280, DOCK_MIN = 240, DOCK_GAP = 24;
  let dockAnimUntil = 0;
  let dockAnimActive = false;
  let lastLayout = "";
  function layoutDock() {
    const dock = document.getElementById("dock");
    const root = document.documentElement;
    const css = getComputedStyle(appEl);
    const px = (name, dflt) => { const v = parseFloat(css.getPropertyValue(name)); return isNaN(v) ? dflt : v; };
    const W = window.innerWidth, H = window.innerHeight;
    const pad = px("--stage-pad", 12), chrome = px("--chrome-h", 44), tl = px("--tl-h", 36);
    // 看的是真的显示没有:练习卡片靠 .show、练习时对局那几张靠样式收起,都不是 hidden 属性
    const empty = !dock || ![...dock.children].some((c) => !c.hidden && getComputedStyle(c).display !== "none");
    appEl.classList.toggle("dock-empty", empty);
    const side = W >= H;
    appEl.classList.toggle("dock-side", side);
    let board, shift = 0, dockH = 0;
    const b0 = Math.floor(Math.min(W - 2 * pad, H - chrome - 2 * pad - tl));
    if (side) {
      board = b0;
      if (!empty) {
        // 两侧空白放得下一张不窄于 240 的卡片,棋盘就原地不动(1280×800 空 250);放不下才让棋盘让位
        const room = (W - b0) / 2 - pad - DOCK_GAP;
        if (room < DOCK_MIN) {
          board = Math.floor(Math.min(b0, W - 2 * pad - DOCK_GAP - DOCK_W));
          shift = -Math.round((DOCK_GAP + DOCK_W) / 2);
        }
        const top = chrome + pad + Math.max(0, (H - chrome - 2 * pad - board - tl) / 2);
        dock.style.left = Math.round(W / 2 + shift + board / 2 + DOCK_GAP) + "px";
        dock.style.top = Math.round(top) + "px";
        dock.style.width = Math.round(Math.min(DOCK_W, W - (W / 2 + shift + board / 2 + DOCK_GAP) - pad)) + "px";
        dock.style.maxHeight = Math.round(board + tl) + "px";
      }
    } else {
      dock.style.left = dock.style.top = dock.style.width = dock.style.maxHeight = "";
      dockH = empty ? 0 : Math.ceil(dock.getBoundingClientRect().height);
      board = Math.floor(Math.min(W - 2 * pad, H - chrome - 2 * pad - tl - dockH - (dockH ? pad : 0)));
    }
    board = Math.max(160, board);
    root.style.setProperty("--board-size", board + "px");
    root.style.setProperty("--board-shift", shift + "px");
    root.style.setProperty("--dock-h", dockH + "px");
    const sig = board + "/" + shift + "/" + dockH;
    // 棋盘尺寸带 .28s 过渡:逐帧跟着重画,停下再定一次(一次性 resize 会停在半路的尺寸)
    if (sig === lastLayout && dockAnimActive) return;
    lastLayout = sig;
    dockAnimUntil = performance.now() + 340;
    if (dockAnimActive) return;
    dockAnimActive = true;
    const tick = () => {
      resizeCanvas();
      draw();
      Practice.redraw();
      if (performance.now() < dockAnimUntil) requestAnimationFrame(tick);
      else dockAnimActive = false;
    };
    requestAnimationFrame(tick);
  }
  if (typeof ResizeObserver !== "undefined") {
    let lastDockH = -1;
    new ResizeObserver(() => {
      const d = document.getElementById("dock");
      const h = d ? Math.ceil(d.getBoundingClientRect().height) : 0;
      if (h !== lastDockH) { lastDockH = h; layoutDock(); }
    }).observe(document.getElementById("dock"));
  }
  function cellAt(x, y) { return Draw.cellAt(x, y); }
  function draw() { Draw.draw(); }
  function ensureAnimLoop() { Draw.ensureAnimLoop(); }

  function isHumanTurn() {
    if (mode === "pvp") return true;
    return turn === humanColor;
  }

  function maybeAiTurn() {
    if (!Session.policy(sessionState()).autoAi || swap2) return;
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
    if (!history.length) startedAt = Date.now();
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

  /** 对局库里本局的 id(终局时写入);重下模式下指向原局。 */
  let lastArchiveId = null;

  function recordGameEnd() {
    if (gameGen === statsRecordedGen) return;
    statsRecordedGen = gameGen;
    lastStatsEndedAt = Date.now();
    if (Session.policy(sessionState()).onFinish === "branch") {
      // 重下关键一手的结果不进统计、不进对局库;作为一条分支挂到原局上,
      // 导出带评注 SGF 时写成变着。
      if (retry.gameId) Archive.addLine(retry.gameId, retry.ply, history.slice(retry.ply - 1));
      showEndCard();
      return;
    }
    // v1.73(B8):从库里打开的「进行中」一局接着下完,写回原来那一条
    const prev = lastArchiveId ? Archive.get(lastArchiveId) : null;
    const done = { history, result, endedAt: lastStatsEndedAt, durationMs: nowElapsed() };
    if (prev && prev.result === "play" && Archive.update(prev.id, done)) {
      // lastArchiveId 不变
    } else lastArchiveId = Archive.add({
      history, ruleSet, mode,
      difficulty: mode === "ai" ? difficulty : null,
      humanColor: mode === "ai" ? humanColor : null,
      result, startedAt: originalStartedAt, endedAt: lastStatsEndedAt,
      durationMs: nowElapsed(),
    });
    Stats.record({
      mode,
      difficulty: mode === "ai" ? difficulty : null,
      humanColor: mode === "ai" ? humanColor : null,
      result,
      moves: history.length,
      durationMs: nowElapsed(),
      endedAt: lastStatsEndedAt,
    });
    showEndCard();
  }

  /** v1.71:战绩并进「对局记录」弹层,和存档、历史对局一处看 */
  function renderStatsIn() {
    Stats.render();
    const body = document.getElementById("stats-body");
    const clear = document.getElementById("stats-clear");
    if (clear) clear.hidden = !body || body.hidden;
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

    if (!history.length) startedAt = Date.now(); // 时钟从第一颗子起走
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
    if (history.length <= undoFloor() || hintBusy) return;
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
      if (endedAt) {
        Stats.unrecordByEndedAt(endedAt);
        Archive.removeByEndedAt(endedAt);
      }
      lastArchiveId = null;
      statsRecordedGen = -1;
      lastStatsEndedAt = null;
    }
    hideEndCard();
    // End-game froze elapsedBaseMs and reset startedAt; returning to play
    // without refreshing startedAt would add post-game idle into the clock.
    if (wasOver) startedAt = Date.now();
    sync();
    saveGame();
    // e.g. human plays white: undo to empty → black (AI) must move
    maybeAiTurn();
  }

  /**
   * 悔棋最多退到哪一手。重下关键一手时,失着之前的那段是原局,不属于这盘练习 ——
   * 退过去,结束时存下的分支就会从错的局面长出来(v1.63.1)。
   */
  function undoFloor() { return Session.undoFloor(sessionState()); }

  /** kind 不存,每次从这两个字段推出来(见 session.js)。 */
  function sessionState() { return { retry: retry, importPaused: importPaused }; }

  function reset(opts) {
    gameGen += 1;
    // 新局从偏好开;上一局是导入的、旧局、重下还是 swap2 定的执子,都只属于上一局。
    // 轮流执子:上一局玩家下过子才换色(见 gameFromPrefs)。数的是人的子 ——
    // 执白时电脑先手,盘上已有一子,人一手没下就点新局不算下过
    // 「上一局」就是被替换的这一局:它是人机局时用它实际执的颜色(第一次启动时存储里还没有记录)
    if (gameFromPrefs(mode === "ai" && humanStones() > 0, mode === "ai" ? humanColor : null)) saveSettings();
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
    lastArchiveId = null;
    retry = null;
    hideEndCard();
    Review.setSideOpen(false);
    clearHint();
    clearAnalysis();
    clearVariation();
    swap2 = null;
    renderSwap2Bar(); // v1.71:离开 swap2 时收起提示条(此前换规则后它会一直挂在棋盘上)
    if (openingRule === "swap2") startSwap2();
    saveSettings();
    sync();
    saveGame();
    maybeAiTurn();
  }


  /** Static text for the first second, then a live count so a long 极限 think
   *  reads as progress rather than a hang. 实测极档中位每手只有 10ms，但预算内
   *  确实有一成多的手会跑满（39 手里 12 手），所以这条计时不是摆设。 */
  function thinkingText() {
    const ms = thinkStartedAt ? performance.now() - thinkStartedAt : 0;
    if (ms < 1000) return t("status.thinking");
    return t("status.thinkingElapsed", { s: Math.floor(ms / 1000) });
  }

  function updateClock() {
    const el = formatDuration(nowElapsed());
    const c1 = document.getElementById("clock");
    if (c1) c1.textContent = el;
    // The same 500ms tick advances the think counter; sync() only runs at the
    // start and end of a think, so without this the seconds would never move.
    if (aiThinking) {
      const st = document.getElementById("status");
      if (st) st.textContent = thinkingText();
    }
  }

  /** 人落过几子:人机模式下数人那一色,双人模式下两边都是人。 */
  function humanStones() {
    return mode === "ai"
      ? history.filter((_, i) => (i % 2 === 0 ? "b" : "w") === humanColor).length
      : history.length;
  }


  function syncSettingsUI() {
    // v1.74:这四格住在「新局」卡片里,亮的是卡片里还没生效的选择;卡片关着时就是偏好
    const S = sheetChoice();
    document.querySelectorAll("#mode-seg button").forEach((b) => {
      b.classList.toggle("active", b.dataset.mode === S.mode);
    });
    document.querySelectorAll("#diff-seg button").forEach((b) => {
      b.classList.toggle("active", b.dataset.diff === S.difficulty);
    });
    document.querySelectorAll("#think-seg button").forEach((b) => {
      b.classList.toggle("active", b.dataset.think === S.think);
    });
    document.querySelectorAll("#color-seg button").forEach((b) => {
      b.classList.toggle("active", b.dataset.human === S.color);
    });
    document.querySelectorAll("#lang-seg button").forEach((b) => {
      b.classList.toggle("active", b.dataset.lang === I18n.lang());
    });
    document.querySelectorAll("#theme-seg button").forEach((b) => {
      b.classList.toggle("active", b.dataset.theme === themeId);
    });
    // 亮的是偏好:对局中在设置里改了规则,这一局照旧,新规则从下一局起
    document.querySelectorAll("#rule-seg button").forEach((b) => {
      b.classList.toggle("active", b.dataset.rule === prefs.rule);
    });
    const aiOnly = S.mode === "ai";
    const diffField = document.getElementById("diff-field");
    const thinkField = document.getElementById("think-field");
    const colorField = document.getElementById("color-field");
    if (diffField) diffField.hidden = !aiOnly;
    if (thinkField) {
      thinkField.hidden = !(aiOnly && (S.difficulty === "hard" || S.difficulty === "extreme"));
      // Titles track the active difficulty budget (hard ≠ extreme wall times)
      const titles =
        S.difficulty === "extreme"
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
          t(S.difficulty === "extreme" ? "aria.thinkMax" : "aria.think")
        );
      }
    }
    // swap2 decides the human's color via the opening protocol, so hide 执子 then
    // swap2 由开局协议定执子 —— 看的是下一局的规则(偏好)
    if (colorField) colorField.hidden = !aiOnly || prefs.rule === "swap2";
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
  }


  /**
   * v1.74:侧栏顶上的对阵行并进顶栏 —— 「你执黑 · 普通」/「双人」,非自由规则时后缀规则名。
   * 轮到谁由状态胶囊说,这里只说「这一局是什么」。
   */
  function syncMatch() {
    const el = document.getElementById("match");
    if (!el) return;
    const parts = [];
    if (swap2 && mode === "ai") parts.push(t("match.swap2"));
    else if (mode === "ai") parts.push(t("match.ai", {
      side: t(humanColor === "b" ? "side.black" : "side.white"),
      level: t("diff." + difficulty + ".full"),
    }));
    else parts.push(t("mode.pvp"));
    const rc = ruleChoice();
    if (rc !== "free") parts.push(t("rule." + rc));
    el.textContent = parts.join(" · ");
  }

  /** v1.74:一条时间线代替手数列表与三个翻页按钮。悬停 / 读屏报「第 N 手 · H8」。 */
  function syncTimeline() {
    const tl = document.getElementById("timeline");
    const pos = document.getElementById("replay-pos");
    if (pos) pos.textContent = viewIndex + " / " + history.length;
    if (!tl) return;
    tl.max = String(history.length);
    tl.value = String(viewIndex);
    const p = viewIndex > 0 ? history[viewIndex - 1] : null;
    const label = p ? t("timeline.at", { n: viewIndex, coord: cellLabel(p.r, p.c) }) : t("timeline.start");
    tl.setAttribute("aria-valuetext", label);
    tl.title = label;
    // 走过的那一段填色(range 的轨道本身不分前后)
    tl.style.setProperty("--fill", (history.length ? (viewIndex / history.length) * 100 : 0) + "%");
  }

  function sync() {
    draw();
    const status = document.getElementById("status");
    const undoBtns = [document.getElementById("undo"), document.getElementById("undo2")].filter(Boolean);
    const live = isLive();

    // v1.68:空棋盘时,翻页、用时都没有意义 —— 不显示(见 styles.css)
    const appEl0 = document.getElementById("app");
    appEl0.classList.toggle("is-empty", history.length === 0);
    // 这一局的规则(设置里亮的是偏好,可能是「下一局起」):给读屏之外的东西(测试、样式)一个稳定的钩子
    appEl0.dataset.rule = ruleChoice();
    syncMatch();
    syncTimeline();
    updateClock();

    undoBtns.forEach((b) => {
      // NOT disabled while aiThinking — 悔棋 is the cancel affordance (see abortThinking).
      if (b) b.disabled = history.length <= undoFloor() || hintBusy || !live || !!swap2;
    });
    // v1.73:「新局」只在一局结束后是主按钮
    document.getElementById("btn-new").classList.toggle("primary", result !== "play");
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
      hintBtn.hidden = result !== "play"; // v1.73:终局后不显示(复盘面板接手)
      hintBtn.classList.toggle("busy", hintBusy);
    }


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
    if (practiceStatus) {
      status.textContent = practiceStatus;
      status.classList.remove("win", "thinking", "replay");
    }

    syncSettingsUI();
    // v1.74:复盘开着时,时间线那一行换成局势曲线(见 styles.css #app.reviewing)
    const reviewing = Review.isSideOpen() && !!Review.getData() && history.length >= 2;
    if (reviewing !== appEl.classList.contains("reviewing")) {
      appEl.classList.toggle("reviewing", reviewing);
      layoutDock();
    }
    Review.renderSide();
    // 重下线上第 ply 手之后的着法不在原局里:从那里「重下」或「练这一手」都会落到原局
    // 同号的另一手上(v1.63.1)。只留推演。
    const offOriginal = !!retry && viewIndex > retry.ply;
    for (const id of ["review-side-retry", "review-side-practice"]) {
      const b = document.getElementById(id);
      if (b) b.hidden = offOriginal;
    }
    // v1.71:「练这一手」只在题库真能出这道题时出现(此前按「可证明的失着」显示,点下去常是「没有可练的题」)
    const practiceSide = document.getElementById("review-side-practice");
    const sideOpen = !document.getElementById("review-side").hidden;
    if (practiceSide && !practiceSide.hidden && sideOpen) {
      let ok = false;
      try { ok = !!lastArchiveId && Practice.hasPuzzleFor(lastArchiveId, viewIndex); } catch (_) { ok = false; }
      practiceSide.hidden = !ok;
    }
    // v1.71:没有可复盘的(不足两手)就不显示「复盘」,不再是一个只会说「先下几手」的按钮
    const reviewBtn = document.getElementById("sgf-review");
    // v1.72:复盘面板开着时也不显示 —— 再点它什么也不做
    if (reviewBtn) reviewBtn.hidden = history.length < 2 || !document.getElementById("review-side").hidden;
    syncRetryBar();
    syncEndCard();
    syncWelcome();
    syncDailyBadge();
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
  document.getElementById("btn-new").onclick = () => { toggleSheet(); };
  const hintBtnEl = document.getElementById("btn-hint");
  if (hintBtnEl) hintBtnEl.onclick = () => { requestHint(); };
  const reset2 = document.getElementById("reset2");
  if (reset2) reset2.onclick = () => { requestNewGame(); };
  const timelineEl = document.getElementById("timeline");
  if (timelineEl) {
    timelineEl.addEventListener("input", () => {
      const n = Number(timelineEl.value);
      if (n === history.length) goLive(); else setViewIndex(n);
    });
  }
  wireMenus();
  document.getElementById("sgf-copy").onclick = () => { copySgf(); };
  document.getElementById("sgf-download").onclick = () => { downloadSgf(); };
  const contEl = document.getElementById("sgf-continue");
  if (contEl) contEl.onclick = () => { continueFromImport(); };
  // v1.70:这四个住在存档弹层里。导入 / 粘贴会换掉当前对局,先关弹层,让人看见换上来的棋
  const pasteEl = document.getElementById("sgf-paste");
  if (pasteEl) pasteEl.onclick = () => { closeSlots(); pasteSgfFromClipboard(); };

  const slotsEl = document.getElementById("sgf-slots");
  if (slotsEl) slotsEl.onclick = () => { openSlots(); };


  Engine.init({
    defaults: () => ({
      board: board, humanColor: humanColor, difficulty: difficulty, think: thinkLevel,
      renju: isRenju(),
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
  // 题材来源(v1.63):当前对局 + 对局库(自动留存)+ 命名存档。每一条都带规则,
  // 连珠局派生的题按连珠判。
  Practice.init({
    getGames: () => {
      const seen = new Set();
      const out = [];
      const push = (g) => {
        if (!g || !g.history || !g.history.length) return;
        // 整条手顺做键:几乎每局都从天元开局,「手数 + 首末手」会把不同的两局当成一局
        const sig = g.history.map((m) => m.r * 15 + m.c).join(",");
        if (seen.has(sig)) return;
        seen.add(sig);
        out.push(g);
      };
      if (!retry) push({ id: lastArchiveId, history: history, renju: isRenju() });
      for (const g of Archive.load()) push({ id: g.id, history: g.history, renju: g.ruleSet === "renju" });
      return out;
    },
    openSource: (id, ply) => { openArchivedGame(id, ply); },
    // v1.75:练习在主棋盘上。开着时把对局那一套让出来,顶栏写「每日挑战 · 第 1 / 5 题」
    onState: (st) => {
      const was = appEl.classList.contains("practicing");
      appEl.classList.toggle("practicing", !!st.open);
      practiceStatus = st.open ? [st.title, st.progress].filter(Boolean).join(" · ") : "";
      if (st.open !== was) { closePopovers(); layoutDock(); }
      sync();
    },
  });
  Practice.wire();
  const practiceEl = document.getElementById("open-practice");
  if (practiceEl) practiceEl.onclick = () => { Practice.open(); };
  const statsClearEl = document.getElementById("stats-clear");
  if (statsClearEl) {
    statsClearEl.onclick = async () => {
      if (!(await confirmNative(t("stats.clearConfirm"), t("stats.clearTitle"), { ok: t("stats.clear"), cancel: t("dlg.cancel") }))) return;
      Stats.clear();
      renderStatsIn();
      toast(t("stats.cleared"));
    };
  }

  const reviewEl = document.getElementById("sgf-review");
  if (reviewEl) reviewEl.onclick = () => { openReview(); };
  wireReviewSide();
  wireEndCard();
  wireWelcome();
  const reviewExportEl = document.getElementById("review-export");
  if (reviewExportEl) reviewExportEl.onclick = () => { exportReviewSgf(); };
  const reviewCurveEl = document.getElementById("review-curve");
  if (reviewCurveEl) {
    reviewCurveEl.addEventListener("click", (ev) => {
      const rd = Review.getData();
      if (!rd || rd.adv.length < 2) return;
      const rect = reviewCurveEl.getBoundingClientRect();
      const pad = 6;
      const frac = (ev.clientX - rect.left - pad) / Math.max(1, rect.width - pad * 2);
      const i = Math.round(Math.min(1, Math.max(0, frac)) * (rd.adv.length - 1));
      setViewIndex(i);
    });
  }
  const slotsCloseEl = document.getElementById("slots-close");
  if (slotsCloseEl) slotsCloseEl.onclick = () => { closeSlots(); };
  const slotsModalEl = document.getElementById("slots-modal");
  if (slotsModalEl) slotsModalEl.onclick = (ev) => { if (ev.target === slotsModalEl) closeSlots(); };
  const gamesListEl = document.getElementById("games-list");
  if (gamesListEl) {
    gamesListEl.addEventListener("click", async (ev) => {
      const b = ev.target.closest("button[data-id]");
      if (!b) return;
      if (b.classList.contains("game-open")) openArchivedGame(b.dataset.id, null);
      else if (b.classList.contains("game-del")) {
        if (!(await confirmNative(t("games.delConfirm"), t("slot.delTitle"), { ok: t("slot.delOk"), cancel: t("dlg.cancel") }))) return;
        Archive.remove(b.dataset.id);
        renderGamesList();
      }
    });
  }

  const ruleSeg = document.getElementById("rule-seg");
  if (ruleSeg) {
    ruleSeg.onclick = async (ev) => {
      const b = ev.target.closest("button[data-rule]");
      if (!b) return;
      const val = b.dataset.rule;
      if (val !== "free" && val !== "swap2" && val !== "renju") return;
      if (val === prefs.rule && val === ruleChoice()) return;
      prefs.rule = val;
      saveSettings();
      // v1.68:规则在设置弹层里。对局中改不打断这一局(也就不必在弹层上再叠一个确认框),
      // 从下一局起生效;空棋盘上改立即换
      if (history.length) {
        syncSettingsUI();
        toast(t("toast.ruleNext", { name: t("rule." + val) }));
        return;
      }
      reset({ keepSettings: true });
      toast(t(
        val === "renju" ? "toast.ruleRenju"
          : val === "swap2"
            ? (mode === "ai" ? "toast.ruleSwap2Ai" : "toast.ruleSwap2")
            : "toast.ruleFree"
      ));
    };
  }
  const langSeg = document.getElementById("lang-seg");
  if (langSeg) langSeg.onclick = (ev) => {
    const b = ev.target.closest("button[data-lang]");
    if (!b || b.dataset.lang === I18n.lang()) return;
    I18n.setLang(b.dataset.lang); // rewrites the static markup
    // …and everything drawn from state has to be rebuilt in the new language
    syncSettingsUI();
    sync();
  };
  document.getElementById("theme-seg").onclick = (ev) => {
    const b = ev.target.closest("button[data-theme]");
    if (!b) return;
    applyTheme(b.dataset.theme); // 棋盘当场换色,不再复述
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
  const swap2Btns = document.getElementById("swap2-btns");
  if (swap2Btns) {
    swap2Btns.addEventListener("click", (ev) => {
      const b = ev.target.closest("button[data-kind]");
      if (b) swap2Choose(b.dataset.kind);
    });
  }

  const helpModal = document.getElementById("help-modal");
  const confirmModal = document.getElementById("confirm-modal");
  // --- v1.74: 「新局」卡片与「⋯」菜单 ---
  function sheetChoice() {
    return sheet || { mode: mode, difficulty: difficulty, think: thinkLevel, color: Session.colorChoice(prefs) };
  }
  function placePopover(el, anchor) {
    const r = anchor.getBoundingClientRect();
    el.style.top = Math.round(r.bottom + 6) + "px";
    el.style.right = Math.max(8, Math.round(window.innerWidth - r.right)) + "px";
  }
  function openSheet() {
    closeMenu();
    // 执子偏好里有「auto」(低档执黑、高档轮流),三格里没有它 —— 没点过执子就不改偏好
    sheet = { mode: mode, difficulty: prefs.difficulty || difficulty, think: thinkLevel, color: Session.colorChoice(prefs), colorTouched: false };
    // 上一局是库里的旧局 / 重下时,这一局的模式可能不是偏好;新局从偏好开
    sheet.mode = prefs.mode || mode;
    const anchor = document.getElementById("btn-new");
    sheetEl.hidden = false;
    placePopover(sheetEl, anchor);
    anchor.setAttribute("aria-expanded", "true");
    syncSettingsUI();
    const start = document.getElementById("new-start");
    if (start) start.focus();
  }
  function closeSheet() {
    if (sheetEl.hidden) return;
    sheetEl.hidden = true;
    sheet = null;
    document.getElementById("btn-new").setAttribute("aria-expanded", "false");
    syncSettingsUI();
  }
  function toggleSheet() { if (sheetEl.hidden) openSheet(); else closeSheet(); }
  async function startFromSheet() {
    const S = sheet || sheetChoice();
    closeSheet();
    // 下完的局早已自动留存,不问;没下完的才问一句(与 N 同一条)
    if (history.length && result === "play") {
      const ok = await confirmNative(t("newgame.confirm"), t("newgame.ok"), { ok: t("newgame.ok"), cancel: t("dlg.cancel") });
      if (!ok) return;
    }
    applyMode(S.mode);
    difficulty = prefs.difficulty = S.difficulty;
    thinkLevel = S.think;
    if (S.colorTouched) prefs.humanColor = S.color;
    saveSettings();
    reset({ keepSettings: true });
  }
  function openMenu() {
    closeSheet();
    const anchor = document.getElementById("more-btn");
    menuEl.hidden = false;
    placePopover(menuEl, anchor);
    anchor.setAttribute("aria-expanded", "true");
    const first = menuEl.querySelector(".menu-item:not([hidden])");
    if (first) first.focus();
  }
  function closeMenu() {
    if (menuEl.hidden) return;
    menuEl.hidden = true;
    document.getElementById("more-btn").setAttribute("aria-expanded", "false");
  }
  function closePopovers() {
    const open = !sheetEl.hidden || !menuEl.hidden;
    closeSheet(); closeMenu();
    return open;
  }
  function wireMenus() {
    document.getElementById("more-btn").onclick = () => { if (menuEl.hidden) openMenu(); else closeMenu(); };
    // 菜单项各有自己的 onclick;这里只负责点完收起菜单
    menuEl.addEventListener("click", (ev) => { if (ev.target.closest(".menu-item")) closeMenu(); });
    menuEl.addEventListener("keydown", (ev) => {
      if (ev.key !== "ArrowDown" && ev.key !== "ArrowUp") return;
      ev.preventDefault();
      const items = [...menuEl.querySelectorAll(".menu-item:not([hidden])")];
      const i = items.indexOf(document.activeElement);
      const next = items[(i + (ev.key === "ArrowDown" ? 1 : items.length - 1)) % items.length];
      if (next) next.focus();
    });
    const pick = (segId, attr, apply) => {
      const seg = document.getElementById(segId);
      if (!seg) return;
      seg.onclick = (ev) => {
        const b = ev.target.closest("button[" + attr + "]");
        if (!b) return;
        if (!sheet) sheet = sheetChoice();
        apply(b.getAttribute(attr));
        syncSettingsUI();
      };
    };
    pick("mode-seg", "data-mode", (v) => { sheet.mode = v; });
    pick("diff-seg", "data-diff", (v) => { sheet.difficulty = v; });
    pick("think-seg", "data-think", (v) => { sheet.think = v; });
    pick("color-seg", "data-human", (v) => { sheet.color = v; sheet.colorTouched = true; });
    document.getElementById("new-start").onclick = () => { startFromSheet(); };
    sheetEl.addEventListener("keydown", (ev) => {
      if (ev.key !== "Enter") return;
      // v1.75(B13):焦点在某个选项上时,回车就是选它(按钮自己的点击);其余时候回车 = 开始
      if (ev.target.closest && ev.target.closest(".pill button")) return;
      ev.preventDefault(); ev.stopPropagation(); startFromSheet();
    });
    // 点在卡片 / 菜单与各自按钮之外就收起
    document.addEventListener("pointerdown", (ev) => {
      const tEl = ev.target;
      if (!sheetEl.hidden && !sheetEl.contains(tEl) && !tEl.closest("#btn-new")) closeSheet();
      if (!menuEl.hidden && !menuEl.contains(tEl) && !tEl.closest("#more-btn")) closeMenu();
    }, true);
  }

  function openHelp() {
    helpModal.classList.add("show");
    const close = document.getElementById("help-close");
    if (close) setTimeout(() => close.focus(), 0);
  }
  function closeHelp() { helpModal.classList.remove("show"); }
  // v1.71:快捷键入口在设置弹层里(顶栏不再常驻);按 ? 照旧直接打开
  document.getElementById("open-help").onclick = () => { openHelp(); };
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
    const practiceModal = document.getElementById("practice-modal");
    if (ev.key === "Escape") {
      if (confirmModal.classList.contains("show")) { finishConfirm(false); return; }
      if (slotsModal && slotsModal.classList.contains("show")) { closeSlots(); return; }
      if (settingsModal.classList.contains("show")) { closeSettings(); return; }
      if (helpModal.classList.contains("show")) { closeHelp(); return; }
      if (closePopovers()) return;
      if (Practice.isOpen()) { Practice.close(); return; }
      // 棋盘有焦点时 Esc 交给棋盘(「Esc 离开」是它播报过的承诺)
      if (document.activeElement === canvas && handleBoardKey(ev)) return;
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
    // v1.75:练习不再是弹层 —— Tab 照常走(「⋯」也走得到);对局的快捷键在练习时一概不响
    if (practiceModal && practiceModal.classList.contains("show") &&
        !settingsModal.classList.contains("show") && !helpModal.classList.contains("show")) {
      if (ev.key === "?" || (ev.shiftKey && k === "/")) openHelp();
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
    // v1.75(B14):「⋯」或「新局」卡片开着时,快捷键不许穿过它去动底下那一局。
    // 焦点在浮层里:键是给浮层的(回车、方向键、空格);焦点在别处:这一下只把浮层收起来
    if (!sheetEl.hidden || !menuEl.hidden) {
      if (!(sheetEl.contains(ev.target) || menuEl.contains(ev.target)) && ev.key !== "Tab" && ev.key !== "Shift") closePopovers();
      return;
    }
    if (ev.key === "?" || (ev.shiftKey && k === "/")) { openHelp(); return; }
    // Tab is deliberately NOT bound here any more. Through v1.31 it toggled the
    // sidebar, which meant focus never moved: 40 visible buttons, every one of
    // them focusable, and no key that could reach any of them — while the
    // dialogs had a full focus trap since v1.25.2. The sidebar already has
    // three other affordances (☰, [ and ], Esc), so Tab goes back to being Tab.
    if (document.activeElement === canvas && handleBoardKey(ev)) return;
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
        applyMode("ai");
        saveSettings();
        reset({ keepSettings: true });
        toast(t("toast.modeAi"));
      })();
    } else if (k === "z" && !ev.metaKey && !ev.ctrlKey) undo();
    else if (k === "n" && !ev.metaKey && !ev.ctrlKey) requestNewGame();
    else if (k === "h" && !ev.metaKey && !ev.ctrlKey && !ev.altKey) {
      ev.preventDefault();
      requestHint();
    }
    else if (k === "f" && !ev.metaKey && !ev.ctrlKey && !ev.altKey) {
      toggleFullscreen();
    }
  });

  window.addEventListener("resize", () => {
    closePopovers();
    layoutDock();
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

  try { migrateSlots(); } catch (_) {}
  const resumed = tryLoadSave();
  welcomeOn = firstRun && !resumed;
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
  layoutDock();
  saveSettings();
  if (!resumed) saveGame();
  maybeAiTurn();


  const sgfImport = document.getElementById("sgf-import");
  if (sgfImport) sgfImport.onclick = () => { closeSlots(); pickAndImportSgf(); };

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
