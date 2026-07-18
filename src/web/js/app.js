(function () {

  const Core = window.GobanCore;
  const SgfMod = window.GobanSgf;
  const Ai = window.GobanAi;
  const SIZE = Core.SIZE;
  const WIN = Core.WIN;
  const SAVE_KEY = "goban.v12.save";
  const SETTINGS_KEY = "goban.v11.settings";
  const PANEL_KEY = "goban.panelOpen";
  const GROUPS_KEY = "goban.v19.groups";

  const canvas = document.getElementById("board");
  const ctx = canvas.getContext("2d");
  const appEl = document.getElementById("app");

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
  function bytesToBase64(str) {
    const bytes = new TextEncoder().encode(str);
    let bin = "";
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin);
  }
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
    if (hasZero() && window.zero.dialogs && window.zero.dialogs.saveFile) {
      try {
        const path = await window.zero.dialogs.saveFile({ title: "导出 SGF", defaultName: name });
        if (path == null) { toast("已取消导出"); return; }
        await window.zero.invoke("goban.writeTextFile", { path: path, b64: bytesToBase64(sgf) });
        if (window.zero.os && window.zero.os.revealPath) {
          try { await window.zero.os.revealPath(path); } catch (_) {}
        }
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
  async function copySgfText(sgf) {
    if (hasZero() && window.zero.clipboard && window.zero.clipboard.writeText) {
      await window.zero.clipboard.writeText(sgf); return;
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(sgf); return;
    }
    const ta = document.createElement("textarea");
    ta.value = sgf;
    document.body.appendChild(ta);
    ta.select();
    try {
      if (!document.execCommand("copy")) throw new Error("copy failed");
    } finally {
      document.body.removeChild(ta);
    }
  }
  async function copySgf() {
    if (!history.length) { toast("还没有棋谱可复制"); return; }
    try {
      await copySgfText(buildSgf());
      toast("SGF 已复制到剪贴板");
    } catch (_) { toast("复制失败，请用导出文件"); }
  }

  async function readTextFile(path) {
    if (!hasZero()) throw new Error("no bridge");
    const b64 = await window.zero.invoke("goban.readTextFile", { path: path });
    const bin = atob(typeof b64 === "string" ? b64 : String(b64));
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder().decode(bytes);
  }

  async function importSgfFromText(text, label) {
    const parsed = SgfMod.parseSgf(text);
    if (parsed.error || !parsed.history.length) {
      toast(parsed.error || "导入失败");
      return false;
    }
    if (history.length) {
      const ok = await confirmNative("导入棋谱将替换当前对局，是否继续？", "导入 SGF", { ok: "导入", cancel: "取消" });
      if (!ok) return false;
    }
    gameGen += 1;
    history = parsed.history;
    viewIndex = history.length;
    board = Core.boardAfter(history, history.length);
    result = "play";
    winLine = null;
    const last = history[history.length - 1];
    const lastColor = (history.length - 1) % 2 === 0 ? "b" : "w";
    const line = Core.findWin(board, last.r, last.c, lastColor);
    if (line) {
      result = lastColor;
      winLine = line;
    } else if (Core.boardFull(board)) {
      result = "draw";
    }
    turn = history.length % 2 === 0 ? "b" : "w";
    elapsedBaseMs = 0;
    startedAt = Date.now();
    originalStartedAt = Date.now();
    aiThinking = false;
    placeAnim = null;
    if (result === "b" || result === "w") triggerWinFlash();
    sync();
    saveGame();
    toast("已导入 " + history.length + " 手" + (label ? " · " + label : ""));
    if (mode === "ai" && result === "play") maybeAiTurn();
    return true;
  }

  async function importSgfFromPath(path) {
    try {
      const text = await readTextFile(path);
      const base = path.split(/[/\\]/).pop() || "sgf";
      await importSgfFromText(text, base);
    } catch (e) {
      toast("读取文件失败");
    }
  }

  async function pickAndImportSgf() {
    if (!hasZero() || !window.zero.dialogs || !window.zero.dialogs.openFile) {
      toast("当前环境不支持打开文件");
      return;
    }
    try {
      const files = await window.zero.dialogs.openFile({
        title: "导入 SGF",
        allowMultiple: false,
      });
      if (!files || !files.length) { toast("已取消导入"); return; }
      await importSgfFromPath(files[0]);
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

  function loadGroupFold() {
    try {
      const raw = localStorage.getItem(GROUPS_KEY);
      if (!raw) return;
      const g = JSON.parse(raw);
      document.querySelectorAll("details.group[data-group]").forEach((el) => {
        const id = el.getAttribute("data-group");
        if (g && typeof g[id] === "boolean") el.open = g[id];
      });
    } catch (_) {}
  }
  function saveGroupFold() {
    const g = {};
    document.querySelectorAll("details.group[data-group]").forEach((el) => {
      g[el.getAttribute("data-group")] = el.open;
    });
    try { localStorage.setItem(GROUPS_KEY, JSON.stringify(g)); } catch (_) {}
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
  let rafId = 0;

  function hasZero() {
    return typeof window.zero === "object" && window.zero != null;
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

  const THEMES = {
    wood: {
      boardTop: "#e8c49a", boardMid: "#d4a574", boardBot: "#c28b52",
      grain: true, line: "#3d2914", star: "#3d2914",
      style: "stone",
      // Soft last-move ring (low contrast — not saturated red/gold)
      lastB: "rgba(255,255,255,0.4)",
      lastW: "rgba(30,22,14,0.32)",
      win: "rgba(160, 70, 50, 0.55)",
    },
    night: {
      boardTop: "#1e332c", boardMid: "#172822", boardBot: "#101c18",
      grain: false, line: "#5a7a6c", star: "#7dcea0",
      style: "stone",
      lastB: "rgba(220,230,225,0.38)",
      lastW: "rgba(10,16,14,0.4)",
      win: "rgba(125, 206, 160, 0.55)",
    },
    day: {
      boardTop: "#f6ead4", boardMid: "#ecd9b5", boardBot: "#e2cba0",
      grain: true, line: "#6b5344", star: "#6b5344",
      style: "stone",
      lastB: "rgba(255,255,255,0.45)",
      lastW: "rgba(40,35,28,0.3)",
      win: "rgba(140, 90, 50, 0.5)",
    },
    notebook: {
      paper: "#fffcf5",
      grid: "#c5d4e8",
      gridStrong: "#9db4d0",
      margin: "#e8a0a0",
      line: "#5a6a80",
      pencil: "#2a3140",
      style: "pencil",
      lastB: "rgba(42,49,64,0.38)",
      lastW: "rgba(42,49,64,0.38)",
      win: "rgba(120, 60, 55, 0.5)",
    },
  };

  function applyTheme(id) {
    if (!THEMES[id]) id = "wood";
    themeId = id;
    document.documentElement.setAttribute("data-theme", id);
    saveSettings();
    syncSettingsUI();
    draw();
  }

  const STARS = [
    [3, 3], [3, 7], [3, 11],
    [7, 3], [7, 7], [7, 11],
    [11, 3], [11, 7], [11, 11],
  ];



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
      const raw = localStorage.getItem(SETTINGS_KEY);
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
    localStorage.setItem(SETTINGS_KEY, JSON.stringify({
      mode, difficulty, humanColor, soundOn, themeId,
    }));
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
      localStorage.setItem(SAVE_KEY, JSON.stringify(serialize()));
      const hint = document.getElementById("save-hint");
      if (hint) hint.textContent = "已存 " + formatTime(Date.now());
    } catch (_) {}
  }

  function clearSave() {
    localStorage.removeItem(SAVE_KEY);
    const hint = document.getElementById("save-hint");
    if (hint) hint.textContent = "无存档";
  }

  function tryLoadSave() {
    try {
      const raw = localStorage.getItem(SAVE_KEY) || localStorage.getItem("goban.v11.save");
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
    localStorage.setItem(PANEL_KEY, open ? "1" : "0");
    requestAnimationFrame(() => { resizeCanvas(); draw(); });
    setTimeout(() => { resizeCanvas(); draw(); }, 220);
  }

  function togglePanel() {
    setPanelOpen(!appEl.classList.contains("panel-open"));
  }

  function geometry() {
    const w = canvas.width;
    const pad = w * 0.045;
    const span = w - pad * 2;
    const step = span / (SIZE - 1);
    return { pad, step, w };
  }

  function resizeCanvas() {
    const wrap = document.getElementById("board-wrap");
    const rect = wrap.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const css = Math.max(200, Math.floor(Math.min(rect.width, rect.height)));
    const px = Math.floor(css * dpr);
    if (canvas.width !== px) {
      canvas.width = px;
      canvas.height = px;
    }
  }

  function cellAt(x, y) {
    const { pad, step } = geometry();
    const c = Math.round((x - pad) / step);
    const r = Math.round((y - pad) / step);
    if (r < 0 || r >= SIZE || c < 0 || c >= SIZE) return null;
    const px = pad + c * step;
    const py = pad + r * step;
    if (Math.hypot(x - px, y - py) > step * 0.52) return null;
    return { r, c };
  }

  function drawOutlineTriangle(x, y, size, color, lineW) {
    const h = size * 0.92;
    const half = size * 0.82;
    ctx.beginPath();
    ctx.moveTo(x, y - h * 0.62);
    ctx.lineTo(x - half * 0.58, y + h * 0.42);
    ctx.lineTo(x + half * 0.58, y + h * 0.42);
    ctx.closePath();
    ctx.strokeStyle = color;
    ctx.lineWidth = lineW;
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    ctx.stroke();
  }

  function drawOutlineCircle(x, y, radius, color, lineW) {
    ctx.beginPath();
    ctx.arc(x, y, radius, 0, Math.PI * 2);
    ctx.strokeStyle = color;
    ctx.lineWidth = lineW;
    ctx.lineCap = "round";
    ctx.stroke();
  }

  function easeOutBack(t) {
    const c = 1.2;
    const t1 = t - 1;
    return 1 + c * t1 * t1 * t1 + t1 * t1;
  }

  function stoneScale(r, c) {
    if (!placeAnim || placeAnim.r !== r || placeAnim.c !== c) return 1;
    const t = Math.min(1, (performance.now() - placeAnim.t0) / 120);
    if (t >= 1) return 1;
    return 0.78 + 0.22 * easeOutBack(t);
  }

  function ensureAnimLoop() {
    if (rafId) return;
    const tick = () => {
      rafId = 0;
      let need = false;
      if (placeAnim) {
        if (performance.now() - placeAnim.t0 < 140) need = true;
        else placeAnim = null;
      }
      if (performance.now() < winFlashUntil) need = true;
      draw();
      if (need) rafId = requestAnimationFrame(tick);
    };
    rafId = requestAnimationFrame(tick);
  }

  function draw() {
    const { pad, step, w } = geometry();
    const th = THEMES[themeId] || THEMES.wood;
    ctx.clearRect(0, 0, w, w);

    if (th.style === "pencil") {
      // exercise-book paper
      ctx.fillStyle = th.paper;
      ctx.fillRect(0, 0, w, w);
      // faint horizontal ruling across whole page (like workbook)
      ctx.strokeStyle = th.grid;
      ctx.lineWidth = Math.max(1, w / 900);
      const rule = step;
      for (let y = pad; y <= pad + step * (SIZE - 1) + 0.1; y += rule / 1) {
        // grid drawn with intersection lines below
      }
      // graph paper aligned to intersections
      ctx.strokeStyle = th.grid;
      ctx.lineWidth = Math.max(1, w / 700);
      for (let i = 0; i < SIZE; i++) {
        const p = pad + i * step;
        const strong = i % 5 === 0;
        ctx.strokeStyle = strong ? th.gridStrong : th.grid;
        ctx.lineWidth = strong ? Math.max(1.2, w / 500) : Math.max(1, w / 700);
        ctx.beginPath();
        ctx.moveTo(pad, p);
        ctx.lineTo(pad + step * (SIZE - 1), p);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(p, pad);
        ctx.lineTo(p, pad + step * (SIZE - 1));
        ctx.stroke();
      }
      // red margin line (notebook vibe)
      ctx.strokeStyle = th.margin;
      ctx.lineWidth = Math.max(1.5, w / 400);
      const marginX = pad - step * 0.15;
      if (marginX > 4) {
        ctx.beginPath();
        ctx.moveTo(marginX, pad - step * 0.1);
        ctx.lineTo(marginX, pad + step * (SIZE - 1) + step * 0.1);
        ctx.stroke();
      }
      // outer frame
      ctx.strokeStyle = th.line;
      ctx.lineWidth = Math.max(1.5, w / 350);
      ctx.strokeRect(pad - 1, pad - 1, step * (SIZE - 1) + 2, step * (SIZE - 1) + 2);
      // stars as small pencil ×
      ctx.strokeStyle = th.pencil;
      ctx.lineWidth = Math.max(1.2, w / 450);
      for (const [r, c] of STARS) {
        const x = pad + c * step;
        const y = pad + r * step;
        const s = Math.max(3, step * 0.12);
        ctx.beginPath();
        ctx.moveTo(x - s, y - s);
        ctx.lineTo(x + s, y + s);
        ctx.moveTo(x + s, y - s);
        ctx.lineTo(x - s, y + s);
        ctx.stroke();
      }
      // pencil marks: outline triangle / circle only
      const markR = step * 0.36;
      const lw = Math.max(1.8, step * 0.08);
      for (let r = 0; r < SIZE; r++) {
        for (let c = 0; c < SIZE; c++) {
          const s = board[r][c];
          if (!s) continue;
          const x = pad + c * step;
          const y = pad + r * step;
          const sc = stoneScale(r, c);
          ctx.save();
          ctx.translate(x, y);
          ctx.scale(sc, sc);
          ctx.translate(-x, -y);
          if (s === "b") drawOutlineTriangle(x, y, step * 0.78, th.pencil, lw);
          else drawOutlineCircle(x, y, markR, th.pencil, lw);
          ctx.restore();
        }
      }
    } else {
      const g = ctx.createLinearGradient(0, 0, w, w);
      g.addColorStop(0, th.boardTop);
      g.addColorStop(0.5, th.boardMid);
      g.addColorStop(1, th.boardBot);
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, w, w);

      if (th.grain) {
        ctx.save();
        ctx.globalAlpha = themeId === "day" ? 0.035 : 0.04;
        for (let i = 0; i < 48; i++) {
          ctx.strokeStyle = i % 2 ? "#000" : "#fff";
          ctx.beginPath();
          ctx.moveTo(0, (i / 48) * w);
          ctx.lineTo(w, (i / 48) * w + 10);
          ctx.stroke();
        }
        ctx.restore();
      }

      ctx.strokeStyle = th.line;
      ctx.lineWidth = Math.max(1, w / 500);
      ctx.lineCap = "square";
      for (let i = 0; i < SIZE; i++) {
        const p = pad + i * step;
        ctx.beginPath();
        ctx.moveTo(pad, p);
        ctx.lineTo(pad + step * (SIZE - 1), p);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(p, pad);
        ctx.lineTo(p, pad + step * (SIZE - 1));
        ctx.stroke();
      }
      ctx.lineWidth = Math.max(2, w / 280);
      ctx.strokeRect(pad - 1, pad - 1, step * (SIZE - 1) + 2, step * (SIZE - 1) + 2);

      ctx.fillStyle = th.star;
      for (const [r, c] of STARS) {
        const x = pad + c * step;
        const y = pad + r * step;
        ctx.beginPath();
        ctx.arc(x, y, Math.max(2.5, step * 0.09), 0, Math.PI * 2);
        ctx.fill();
      }

      const radius = step * 0.43;
      for (let r = 0; r < SIZE; r++) {
        for (let c = 0; c < SIZE; c++) {
          const s = board[r][c];
          if (!s) continue;
          const x = pad + c * step;
          const y = pad + r * step;
          const sc = stoneScale(r, c);
          const rr = radius * sc;
          ctx.beginPath();
          ctx.arc(x + 1.2 * sc, y + 1.8 * sc, rr, 0, Math.PI * 2);
          ctx.fillStyle = "rgba(0,0,0,0.18)";
          ctx.fill();
          const sg = ctx.createRadialGradient(
            x - rr * 0.38, y - rr * 0.42, rr * 0.08, x, y, rr
          );
          if (s === "b") {
            if (themeId === "night") {
              sg.addColorStop(0, "#4a4a4a");
              sg.addColorStop(0.35, "#1c1c1c");
              sg.addColorStop(1, "#050505");
            } else {
              sg.addColorStop(0, "#6a6a6a");
              sg.addColorStop(0.4, "#242424");
              sg.addColorStop(1, "#050505");
            }
          } else {
            sg.addColorStop(0, "#ffffff");
            sg.addColorStop(0.5, "#f2f2f2");
            sg.addColorStop(1, themeId === "day" ? "#c8c8c8" : "#bcbcbc");
          }
          ctx.beginPath();
          ctx.arc(x, y, rr, 0, Math.PI * 2);
          ctx.fillStyle = sg;
          ctx.fill();
          if (s === "w") {
            ctx.strokeStyle = themeId === "day" ? "rgba(0,0,0,0.26)" : "rgba(0,0,0,0.18)";
            ctx.lineWidth = themeId === "day" ? 1.35 : 1;
            ctx.stroke();
          } else if (themeId === "night") {
            ctx.strokeStyle = "rgba(255,255,255,0.06)";
            ctx.lineWidth = 1;
            ctx.stroke();
          }
        }
      }
    }

    if (viewIndex > 0 && history[viewIndex - 1]) {
      const last = history[viewIndex - 1];
      const x = pad + last.c * step;
      const y = pad + last.r * step;
      // Scheme A: smaller, thinner last-move ring — findable, not loud
      const markR = Math.max(2.2, step * 0.105);
      ctx.beginPath();
      ctx.arc(x, y, markR, 0, Math.PI * 2);
      ctx.strokeStyle = board[last.r][last.c] === "b" ? th.lastB : th.lastW;
      ctx.lineWidth = Math.max(1.05, step * 0.032);
      ctx.stroke();
    }

    if (winLine && winLine.length) {
      ctx.save();
      ctx.globalAlpha = th.style === "pencil" ? 0.72 : 0.62;
      ctx.strokeStyle = th.win;
      ctx.lineWidth = Math.max(2, step * 0.09);
      ctx.lineCap = "round";
      if (th.style === "pencil") {
        ctx.setLineDash([Math.max(4, step * 0.15), Math.max(3, step * 0.1)]);
      }
      ctx.beginPath();
      for (let i = 0; i < winLine.length; i++) {
        const p = winLine[i];
        const x = pad + p.c * step;
        const y = pad + p.r * step;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.restore();
    }
  }





  /** Pattern score for one color as if evaluating the whole board. */






  /**
   * Negamax alpha-beta. `me` is the AI root color.
   * Returns evaluation from the perspective of the side to move at this node
   * when using classic negamax: we pass side and flip score.
   */


  function isHumanTurn() {
    if (mode === "pvp") return true;
    return turn === humanColor;
  }

  function maybeAiTurn() {
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
    const sbOff = document.getElementById("opt-sound-off");
    if (sbOn) sbOn.classList.toggle("active", soundOn);
    if (sbOff) sbOff.classList.toggle("active", !soundOn);
  }

  function sync() {
    draw();
    const status = document.getElementById("status");
    const moves = document.getElementById("moves");
    const blackTurn = document.getElementById("black-turn");
    const whiteTurn = document.getElementById("white-turn");
    const undoBtns = [document.getElementById("undo"), document.getElementById("undo2")];
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
  document.getElementById("undo2").onclick = undo;
  document.getElementById("btn-new").onclick = () => { requestNewGame(); };
  document.getElementById("reset2").onclick = () => { requestNewGame(); };
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
    if (soundOn) return;
    soundOn = true;
    saveSettings();
    syncSettingsUI();
    playMoveSound("b");
    toast("音效已开");
  };
  document.getElementById("opt-sound-off").onclick = () => {
    if (!soundOn) return;
    soundOn = false;
    saveSettings();
    syncSettingsUI();
    toast("音效已关");
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
  const savedPanel = localStorage.getItem(PANEL_KEY);
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


  // group fold memory
  loadGroupFold();
  document.querySelectorAll("details.group[data-group]").forEach((el) => {
    el.addEventListener("toggle", saveGroupFold);
  });
  const sgfImport = document.getElementById("sgf-import");
  if (sgfImport) sgfImport.onclick = () => { pickAndImportSgf(); };
  if (hasZero() && typeof window.zero.on === "function") {
    try {
      window.zero.on("drop:files", (detail) => {
        const paths = (detail && detail.paths) || [];
        const sgfPath = paths.find((p) => /\.sgf$/i.test(p));
        if (sgfPath) importSgfFromPath(sgfPath);
      });
    } catch (_) {}
  }

  clockTimer = setInterval(updateClock, 500);

})();
