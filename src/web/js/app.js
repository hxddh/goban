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
  function aiMove() {
    return Ai.aiMove({ board: board, humanColor: humanColor, difficulty: difficulty });
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
  async function downloadSgf() {
    if (!history.length) { toast("还没有棋谱可导出"); return; }
    const sgf = buildSgf();
    const name = sgfFileName();
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
  /** @type {{r:number,c:number,t0:number}|null} */
  let placeAnim = null;
  /** After SGF import: no auto-AI until「续下」or human places. */
  let importPaused = false;
  let winFlashUntil = 0;

  function hasZero() { return Host.hasZero(); }

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
    return new Promise((resolve) => {
      confirmResolver = resolve;
    });
  }

  function finishConfirm(value) {
    const modal = document.getElementById("confirm-modal");
    if (modal) modal.classList.remove("show");
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
    sync();
  }

  /** SGF: col a–o left→right; row a–o bottom→top (Go FF4). */








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
      if (s.difficulty === "easy" || s.difficulty === "normal" || s.difficulty === "hard") difficulty = s.difficulty;
      if (s.humanColor === "b" || s.humanColor === "w") humanColor = s.humanColor;
      if (typeof s.soundOn === "boolean") soundOn = s.soundOn;
      if (s.themeId && THEMES[s.themeId]) themeId = s.themeId;
    } catch (_) {}
  }

  function saveSettings() {
    Host.storageSet(
      SETTINGS_KEY,
      JSON.stringify({ mode, difficulty, humanColor, soundOn, themeId })
    );
  }

  function playMoveSound(color) {
    if (!soundOn) return;
    try {
      if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      if (audioCtx.state === "suspended") audioCtx.resume();
      const t0 = audioCtx.currentTime;
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.type = "sine";
      osc.frequency.value = color === "b" ? 320 : 420;
      gain.gain.setValueAtTime(0.0001, t0);
      gain.gain.exponentialRampToValueAtTime(0.12, t0 + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.09);
      osc.connect(gain);
      gain.connect(audioCtx.destination);
      osc.start(t0);
      osc.stop(t0 + 0.1);
    } catch (_) {}
  }

  function playWinSound() {
    if (!soundOn) return;
    try {
      if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      if (audioCtx.state === "suspended") audioCtx.resume();
      const notes = [523, 659, 784];
      notes.forEach((f, i) => {
        const t0 = audioCtx.currentTime + i * 0.08;
        const osc = audioCtx.createOscillator();
        const gain = audioCtx.createGain();
        osc.type = "triangle";
        osc.frequency.value = f;
        gain.gain.setValueAtTime(0.0001, t0);
        gain.gain.exponentialRampToValueAtTime(0.1, t0 + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.2);
        osc.connect(gain);
        gain.connect(audioCtx.destination);
        osc.start(t0);
        osc.stop(t0 + 0.22);
      });
    } catch (_) {}
  }

  /** Point users at real macOS window chrome — not web Fullscreen API. */
  function toggleFullscreen() {
    toast("全屏：菜单 View → Enter Full Screen（⌘⌃F）· 放大：窗口绿键 Zoom");
  }

  function serialize() {
    return {
      v: 2,
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
    const hint = document.getElementById("save-hint");
    if (hint) hint.textContent = "无存档";
  }

  function tryLoadSave() {
    try {
      const raw = Host.storageGet(SAVE_KEY) || Host.storageGet("goban.v11.save");
      if (!raw) return false;
      const s = JSON.parse(raw);
      if (!s || (s.v !== 1 && s.v !== 2)) return false;
      // Resume only with a move list — board-only snapshots cannot place safely.
      const loadedHistory = Array.isArray(s.history) ? s.history : [];
      if (!loadedHistory.length) return false;
      history = loadedHistory;
      turn = s.turn === "w" ? "w" : "b";
      result = s.result || "play";
      mode = s.mode === "pvp" ? "pvp" : "ai";
      difficulty = s.difficulty || "normal";
      humanColor = s.humanColor === "w" ? "w" : "b";
      winLine = s.winLine || null;
      viewIndex = history.length;
      board = boardAfter(history.length);
      if (result === "play") turn = history.length % 2 === 0 ? "b" : "w";
      elapsedBaseMs = typeof s.elapsedBaseMs === "number" ? s.elapsedBaseMs : 0;
      originalStartedAt = typeof s.originalStartedAt === "number"
        ? s.originalStartedAt
        : (Date.now() - elapsedBaseMs);
      startedAt = Date.now();
      return true;
    } catch (_) {
      return false;
    }
  }

  function setPanelOpen(open) {
    appEl.classList.toggle("panel-open", open);
    appEl.classList.toggle("scrim-on", open && window.innerWidth < 900);
    Host.storageSet(PANEL_KEY, open ? "1" : "0");
    requestAnimationFrame(() => { resizeCanvas(); draw(); });
    setTimeout(() => { resizeCanvas(); draw(); }, 220);
  }

  function togglePanel() {
    setPanelOpen(!appEl.classList.contains("panel-open"));
  }

  Draw.attach(canvas, ctx, () => ({
    board: board,
    history: history,
    viewIndex: viewIndex,
    themeId: themeId,
    placeAnim: placeAnim,
    winLine: winLine,
    winFlashUntil: winFlashUntil,
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
    if (importPaused) return;
    if (mode !== "ai" || result !== "play" || isHumanTurn() || aiThinking) return;
    aiThinking = true;
    const gen = gameGen;
    sync();
    const delay = difficulty === "hard" ? 40 : difficulty === "normal" ? 70 : 55;
    // yield so UI paints "思考中"
    setTimeout(() => {
      if (gen !== gameGen) return;
      const t0 = performance.now();
      const m = aiMove();
      const spent = performance.now() - t0;
      const wait = Math.max(0, delay - spent);
      setTimeout(() => {
        if (gen !== gameGen) return;
        aiThinking = false;
        if (m) place(m.r, m.c, true);
        else sync();
      }, wait);
    }, 0);
  }

  function place(r, c, fromAi) {
    if (result !== "play") return;
    if (!isLive()) {
      if (!fromAi) toast("请先「回到最新一手」再落子");
      return;
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
    if (!history.length || aiThinking) return;
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
    viewIndex = history.length;
    board = boardAfter(history.length);
    sync();
    saveGame();
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
    saveSettings();
    sync();
    saveGame();
    maybeAiTurn();
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
    document.querySelectorAll("#color-seg button").forEach((b) => {
      b.classList.toggle("active", b.dataset.human === humanColor);
    });
    document.querySelectorAll("#theme-seg button").forEach((b) => {
      b.classList.toggle("active", b.dataset.theme === themeId);
    });
    const aiOnly = mode === "ai";
    const diffField = document.getElementById("diff-field");
    const colorField = document.getElementById("color-field");
    if (diffField) diffField.hidden = !aiOnly;
    if (colorField) colorField.hidden = !aiOnly;
    const sbOn = document.getElementById("opt-sound");
    if (sbOn) {
      sbOn.classList.toggle("active", soundOn);
      sbOn.setAttribute("aria-pressed", soundOn ? "true" : "false");
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
    const nextColor = viewIndex % 2 === 0 ? "b" : "w";

    moves.textContent = viewIndex + "/" + history.length;
    document.getElementById("info-moves").textContent =
      history.length + (live ? "" : "·看" + viewIndex);
    document.getElementById("replay-pos").textContent = viewIndex + " / " + history.length;
    updateClock();

    undoBtns.forEach((b) => {
      if (b) b.disabled = history.length === 0 || aiThinking || !live;
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

    status.classList.toggle("win", live && (result === "b" || result === "w"));
    status.classList.toggle("thinking", live && result === "play" && aiThinking);
    status.classList.toggle("replay", !live);
    if (!live) {
      status.textContent = "复盘 " + viewIndex + "/" + history.length;
      if (winLine) status.textContent += " · 已成五";
    } else if (result === "b") status.textContent = "黑棋胜";
    else if (result === "w") status.textContent = "白棋胜";
    else if (result === "draw") status.textContent = "平局";
    else if (importPaused) status.textContent = "导入复盘 · 可续下";
    else if (aiThinking) status.textContent = "电脑思考中…";
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

  document.getElementById("undo").onclick = undo;
  const undo2 = document.getElementById("undo2");
  if (undo2) undo2.onclick = undo;
  document.getElementById("btn-new").onclick = () => { requestNewGame(); };
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
    toast("难度：" + ({ easy: "简单", normal: "普通", hard: "困难" })[difficulty]);
  };
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
    if (ev.key === "Escape") {
      if (confirmModal.classList.contains("show")) { finishConfirm(false); return; }
      if (helpModal.classList.contains("show")) { closeHelp(); return; }
      if (appEl.classList.contains("panel-open")) setPanelOpen(false);
      return;
    }
    if (confirmModal.classList.contains("show")) {
      if (ev.key === "Enter") { ev.preventDefault(); finishConfirm(true); }
      return;
    }
    if (ev.key === "?" || (ev.shiftKey && k === "/")) { openHelp(); return; }
    if (ev.key === "Tab") { ev.preventDefault(); togglePanel(); return; }
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
    else if (id === "goban.toggle-panel") togglePanel();
    else if (id === "goban.fullscreen") toggleFullscreen(); // hint only; real FS is system menu
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
  setPanelOpen(savedPanel === "1");

  const resumed = tryLoadSave();
  if (resumed) {
    gameGen += 1;
    toast("已恢复上次对局");
  } else {
    startedAt = Date.now();
    originalStartedAt = startedAt;
    elapsedBaseMs = 0;
  }

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
