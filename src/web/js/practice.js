/**
 * Tactics practice (战术练习): find-the-win / find-the-defense puzzles on an
 * isolated mini board inside a modal — it never touches live game state.
 *
 * Puzzle types with exact, cheap verdicts:
 *  - win1:   side to move has an immediate five → correct iff the clicked
 *            cell completes five (Core.wouldWin).
 *  - defend: the opponent threatens a five next move → correct iff the click
 *            wins outright OR removes every opponent win-in-1.
 * Built-ins are validated by those predicates at load; user-game puzzles are
 * derived from 错失胜着 plies (always solvable by construction) plus
 * solvability-checked 漏防 plies.
 *
 * 每日挑战 (daily challenge) reuses the exact same puzzle types, judging and
 * modal/board: a date-seeded deterministic pick of DAILY_COUNT puzzles,
 * snapshotted to storage on first open of the day so re-entering shows the
 * same set even after new games change the candidate pool. Completing a day
 * once updates the check-in streak; replays never re-count.
 * @module practice
 */
(function (global) {
  const Core = global.GobanCore;
  const Ai = global.GobanAi;
  const SIZE = Core.SIZE;

  /** Built-in curated positions: stones + side to move + type. */
  const BUILTINS = [
    { type: "win1", side: "b",
      b: [[7,3],[7,4],[7,5],[7,6]], w: [[6,3],[6,4],[6,5],[8,4]] },
    { type: "win1", side: "b",
      b: [[4,4],[5,5],[6,6],[7,7]], w: [[4,5],[5,6],[6,7],[3,3]] },
    { type: "win1", side: "w",
      b: [[5,7],[6,7],[7,7],[8,7],[9,9]], w: [[5,8],[6,8],[7,8],[8,8]] },
    { type: "win1", side: "b",
      b: [[7,2],[7,3],[7,5],[7,6]], w: [[6,2],[6,3],[6,5],[8,6]] },
    { type: "win1", side: "b",
      b: [[3,10],[4,10],[5,10],[6,10]], w: [[3,9],[4,9],[5,9],[12,12]] },
    { type: "defend", side: "b",
      b: [[7,2],[5,5],[9,9],[3,3]], w: [[7,3],[7,4],[7,5],[7,6]] },
    { type: "defend", side: "b",
      b: [[5,4],[7,5],[8,8],[2,2]], w: [[6,3],[6,4],[6,6],[6,7]] },
    { type: "defend", side: "w",
      b: [[8,4],[8,5],[8,6],[8,7]], w: [[8,3],[5,5],[3,10]] },
  ];

  let deps = { getHistories: () => [] };
  let pool = [];
  let idx = 0;
  let score = 0;
  let answered = false;
  let cur = null; // { board, side, type, solutions }
  /** 'free' (练习) or 'daily' (每日挑战) — same flow, different pool + finish. */
  let runMode = "free";
  /** The calendar day a daily run belongs to, frozen at startDaily(). */
  let dailyDate = "";

  function init(d) {
    if (d && typeof d.getHistories === "function") deps = d;
  }

  function boardOf(stones) {
    const bd = Core.emptyBoard();
    for (const [r, c] of stones.b || []) bd[r][c] = "b";
    for (const [r, c] of stones.w || []) bd[r][c] = "w";
    return bd;
  }

  function cloneBoard(bd) { return bd.map((row) => row.slice()); }

  /** All correct cells for a puzzle; empty array ⇒ not a valid puzzle. */
  function solutionsFor(board, side, type) {
    const oppo = Core.opp(side);
    const out = [];
    if (type === "win1") {
      for (let r = 0; r < SIZE; r++) for (let c = 0; c < SIZE; c++) {
        if (!board[r][c] && Core.wouldWin(board, r, c, side)) out.push({ r, c });
      }
      return out;
    }
    // defend: valid only when the opponent actually threatens a five
    if (!Ai.listWinCells(board, oppo).length) return [];
    for (let r = 0; r < SIZE; r++) for (let c = 0; c < SIZE; c++) {
      if (board[r][c]) continue;
      if (Core.wouldWin(board, r, c, side)) { out.push({ r, c }); continue; }
      const after = cloneBoard(board);
      after[r][c] = side;
      if (!Ai.listWinCells(after, oppo).length) out.push({ r, c });
    }
    return out;
  }

  function makePuzzle(board, side, type, source) {
    const solutions = solutionsFor(board, side, type);
    if (!solutions.length) return null;
    return { board, side, type, solutions, source };
  }

  /** Derive puzzles from played games: missed wins + recoverable missed defenses. */
  function fromGames() {
    const out = [];
    const seen = new Set();
    for (const history of deps.getHistories()) {
      if (!Array.isArray(history) || history.length < 2) continue;
      for (let i = 1; i <= history.length; i++) {
        const side = (i - 1) % 2 === 0 ? "b" : "w";
        const pre = Core.boardAfter(history, i - 1);
        const played = history[i - 1];
        if (Core.wouldWin(pre, played.r, played.c, side)) continue; // played the win
        let p = null;
        if (Ai.listWinCells(pre, side).length) {
          p = makePuzzle(pre, side, "win1", "对局");
        } else {
          const after = cloneBoard(pre);
          after[played.r][played.c] = side;
          if (Ai.listWinCells(after, Core.opp(side)).length) {
            p = makePuzzle(pre, side, "defend", "对局"); // null when hopeless
          }
        }
        if (p) {
          const key = p.type + ":" + p.side + ":" + p.board.map((row) => row.map((s) => s || ".").join("")).join("");
          if (!seen.has(key)) { seen.add(key); out.push(p); }
        }
        if (out.length >= 12) return out;
      }
    }
    return out;
  }

  function buildCandidates() {
    const list = [];
    for (const def of BUILTINS) {
      const p = makePuzzle(boardOf(def), def.side, def.type, "内置");
      if (p) list.push(p);
    }
    list.push(...fromGames());
    return list;
  }

  function buildPool() {
    const list = buildCandidates();
    // shuffle
    for (let i = list.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [list[i], list[j]] = [list[j], list[i]];
    }
    return list;
  }

  // --- 每日挑战 (daily challenge) ------------------------------------------
  const DAILY_KEY = "goban.v12.daily";
  const DAILY_COUNT = 5;

  function hostStorage() { return global.GobanHost || null; }

  function loadDaily() {
    const h = hostStorage();
    if (!h) return null;
    try {
      const raw = h.storageGet(DAILY_KEY);
      const st = raw ? JSON.parse(raw) : null;
      return st && typeof st === "object" ? st : null;
    } catch (_) { return null; }
  }

  function saveDaily(st) {
    const h = hostStorage();
    if (!h) return;
    try { h.storageSet(DAILY_KEY, JSON.stringify(st)); } catch (_) {}
  }

  /** Local calendar day, e.g. "2026-07-23". */
  function todayStr() {
    const d = new Date();
    const p = (n) => (n < 10 ? "0" + n : "" + n);
    return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate());
  }

  /** Calendar day before dateStr (noon-anchored so DST can't skip a day). */
  function prevDayStr(dateStr) {
    const parts = dateStr.split("-").map(Number);
    const t = new Date(parts[0], parts[1] - 1, parts[2], 12);
    t.setDate(t.getDate() - 1);
    const p = (n) => (n < 10 ? "0" + n : "" + n);
    return t.getFullYear() + "-" + p(t.getMonth() + 1) + "-" + p(t.getDate());
  }

  /** mulberry32 seeded by FNV-1a of the date — same day, same sequence. */
  function seededRng(dateStr) {
    let h = 2166136261 >>> 0;
    for (let i = 0; i < dateStr.length; i++) {
      h ^= dateStr.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return function () {
      h |= 0; h = (h + 0x6d2b79f5) | 0;
      let t = Math.imul(h ^ (h >>> 15), 1 | h);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /** Deterministic date-seeded pick of up to n candidates (pure, testable). */
  function pickForDate(candidates, dateStr, n) {
    const rng = seededRng(dateStr);
    const list = candidates.slice();
    for (let i = list.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [list[i], list[j]] = [list[j], list[i]];
    }
    return list.slice(0, n);
  }

  /**
   * Completion transition (pure, testable). Counts a day at most once;
   * the streak continues iff the previous completed day was yesterday.
   */
  function advanceDaily(prev, dateStr, score, total) {
    const st = prev && typeof prev === "object" ? Object.assign({}, prev) : {};
    if (st.lastDoneDate === dateStr) return st; // replay: never re-count
    st.streak = st.lastDoneDate === prevDayStr(dateStr) ? (st.streak || 0) + 1 : 1;
    if (st.streak > (st.bestStreak || 0)) st.bestStreak = st.streak;
    st.daysDone = (st.daysDone || 0) + 1;
    st.lastDoneDate = dateStr;
    st.lastScore = score;
    st.lastTotal = total;
    return st;
  }

  function stonesOf(board) {
    const b = [], w = [];
    for (let r = 0; r < SIZE; r++) for (let c = 0; c < SIZE; c++) {
      if (board[r][c] === "b") b.push([r, c]);
      else if (board[r][c] === "w") w.push([r, c]);
    }
    return { b: b, w: w };
  }

  /**
   * Today's puzzle set: rebuilt from the stored snapshot, or picked fresh
   * (date-seeded) and snapshotted on the first open of the day.
   */
  function dailyPoolFor(date) {
    let st = loadDaily() || {};
    if (st.date !== date || !Array.isArray(st.puzzles) || !st.puzzles.length) {
      const picked = pickForDate(buildCandidates(), date, DAILY_COUNT);
      st.date = date;
      st.puzzles = picked.map((p) => {
        const stones = stonesOf(p.board);
        return { side: p.side, type: p.type, source: p.source, b: stones.b, w: stones.w };
      });
      saveDaily(st);
    }
    const pool = [];
    for (const def of st.puzzles) {
      // re-validate through the same predicates as every other puzzle
      const p = makePuzzle(boardOf(def), def.side, def.type, def.source || "内置");
      if (p) pool.push(p);
    }
    return { state: st, pool: pool };
  }

  /** Aggregate for the stats panel; null when never played. */
  function dailySummary() {
    const st = loadDaily();
    if (!st || !st.daysDone) return null;
    const today = todayStr();
    const alive = st.lastDoneDate === today || st.lastDoneDate === prevDayStr(today);
    return {
      todayDone: st.lastDoneDate === today,
      streak: alive ? st.streak || 0 : 0,
      bestStreak: st.bestStreak || 0,
      daysDone: st.daysDone || 0,
      lastScore: st.lastScore,
      lastTotal: st.lastTotal,
    };
  }

  // --- mini-board rendering (isolated canvas, theme-neutral) ---
  function drawBoard(marks) {
    const cv = document.getElementById("practice-board");
    if (!cv || !cur) return;
    const dpr = window.devicePixelRatio || 1;
    const cssW = cv.clientWidth || 360;
    cv.width = Math.round(cssW * dpr);
    cv.height = Math.round(cssW * dpr);
    const g = cv.getContext("2d");
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, cssW, cssW);
    const pad = cssW * 0.04;
    const step = (cssW - pad * 2) / (SIZE - 1);
    const css = getComputedStyle(document.documentElement);
    const lineCol = css.getPropertyValue("--muted").trim() || "#999";
    g.strokeStyle = lineCol;
    g.globalAlpha = 0.55;
    g.lineWidth = 1;
    for (let i = 0; i < SIZE; i++) {
      const t = pad + i * step;
      g.beginPath(); g.moveTo(pad, t); g.lineTo(cssW - pad, t); g.stroke();
      g.beginPath(); g.moveTo(t, pad); g.lineTo(t, cssW - pad); g.stroke();
    }
    g.globalAlpha = 1;
    const rr = step * 0.42;
    for (let r = 0; r < SIZE; r++) for (let c = 0; c < SIZE; c++) {
      const s = cur.board[r][c];
      if (!s) continue;
      const x = pad + c * step, y = pad + r * step;
      g.beginPath();
      g.arc(x, y, rr, 0, Math.PI * 2);
      g.fillStyle = s === "b" ? "#1a1a1a" : "#f2f2f2";
      g.fill();
      g.strokeStyle = s === "b" ? "rgba(255,255,255,0.25)" : "rgba(0,0,0,0.35)";
      g.lineWidth = 1;
      g.stroke();
    }
    if (marks) {
      for (const m of marks) {
        const x = pad + m.c * step, y = pad + m.r * step;
        g.beginPath();
        g.arc(x, y, step * 0.2, 0, Math.PI * 2);
        g.fillStyle = m.color;
        g.fill();
      }
    }
  }

  function taskText() {
    const who = cur.side === "b" ? "黑" : "白";
    return cur.type === "win1"
      ? who + "先 · 找出一步成五的制胜点"
      : who + "先 · 挡住对方的成五威胁";
  }

  function setFeedback(html, cls) {
    const el = document.getElementById("practice-feedback");
    if (el) { el.innerHTML = html; el.className = "practice-feedback " + (cls || ""); }
  }

  function setProgress() {
    const el = document.getElementById("practice-progress");
    if (el) el.textContent = "第 " + (idx + 1) + " / " + pool.length + " 题 · 答对 " + score;
    const src = document.getElementById("practice-source");
    if (src) src.textContent = cur ? (cur.source === "对局" ? "来自你的对局" : "内置题") : "";
  }

  function setTitle(text) {
    const el = document.getElementById("practice-title");
    if (el) el.textContent = text;
  }

  function showPuzzle() {
    cur = pool[idx];
    answered = false;
    const task = document.getElementById("practice-task");
    if (task) task.textContent = taskText();
    setFeedback("", "");
    const next = document.getElementById("practice-next");
    if (next) next.hidden = true;
    setProgress();
    requestAnimationFrame(() => drawBoard(null));
  }

  function clearMiniBoard() {
    const cv = document.getElementById("practice-board");
    if (cv) { const g = cv.getContext("2d"); g && g.clearRect(0, 0, cv.width, cv.height); }
  }

  function finishRun() {
    cur = null;
    const task = document.getElementById("practice-task");
    const next = document.getElementById("practice-next");
    if (runMode === "daily") {
      // advanceDaily is idempotent per day — a replayed round shows the
      // streak but never re-counts it.
      const st = advanceDaily(loadDaily() || {}, dailyDate, score, pool.length);
      saveDaily(st);
      if (task) task.textContent = "今日挑战完成";
      setFeedback(
        "答对 " + score + " / " + pool.length + " · 连续打卡 " + (st.streak || 1) + " 天 🔥",
        "good");
      if (next) { next.hidden = false; next.textContent = "再练一遍"; }
    } else {
      if (task) task.textContent = "本轮完成";
      setFeedback("答对 " + score + " / " + pool.length + " 题 🎉", "good");
      if (next) { next.hidden = false; next.textContent = "再来一轮"; }
    }
    clearMiniBoard();
  }

  function onBoardClick(ev) {
    if (!cur || answered) return;
    const cv = document.getElementById("practice-board");
    const rect = cv.getBoundingClientRect();
    const cssW = rect.width;
    const pad = cssW * 0.04;
    const step = (cssW - pad * 2) / (SIZE - 1);
    const c = Math.round((ev.clientX - rect.left - pad) / step);
    const r = Math.round((ev.clientY - rect.top - pad) / step);
    if (r < 0 || r >= SIZE || c < 0 || c >= SIZE || cur.board[r][c]) return;
    answered = true;
    const good = cur.solutions.some((s) => s.r === r && s.c === c);
    if (good) score++;
    setProgress(); // reflect the score immediately, not only on the next puzzle
    const marks = [{ r, c, color: good ? "rgba(47,158,94,0.95)" : "rgba(192,57,43,0.95)" }];
    if (!good) {
      for (const s of cur.solutions) marks.push({ r: s.r, c: s.c, color: "rgba(47,158,94,0.8)" });
    }
    drawBoard(marks);
    if (good) {
      setFeedback("✓ 正解！", "good");
    } else {
      setFeedback(
        cur.type === "win1"
          ? "✗ 这一点不能一步成五。绿色点位可直接连五。"
          : "✗ 对方下一手就会成五。必须挡在成五点上（或自己抢先成五）——绿色点位。",
        "bad");
    }
    const next = document.getElementById("practice-next");
    if (next) { next.hidden = false; next.textContent = idx + 1 < pool.length ? "下一题" : "看结果"; }
  }

  function onNext() {
    if (!cur) { // "再来一轮" / "再练一遍"
      if (runMode === "daily") { replayDaily(); } else { start(); }
      return;
    }
    idx++;
    if (idx < pool.length) showPuzzle();
    else finishRun();
  }

  function start() {
    runMode = "free";
    pool = buildPool();
    idx = 0;
    score = 0;
    if (!pool.length) {
      const task = document.getElementById("practice-task");
      if (task) task.textContent = "暂无可用题目";
      return;
    }
    showPuzzle();
  }

  /** Re-run today's set (after finishing); completion stays counted once. */
  function replayDaily() {
    idx = 0;
    score = 0;
    if (pool.length) showPuzzle();
  }

  function startDaily() {
    runMode = "daily";
    dailyDate = todayStr();
    const r = dailyPoolFor(dailyDate);
    pool = r.pool;
    idx = 0;
    score = 0;
    if (!pool.length) {
      const task = document.getElementById("practice-task");
      if (task) task.textContent = "暂无可用题目";
      return;
    }
    if (r.state.lastDoneDate === dailyDate) {
      // already checked in today: summary first, replay on demand
      cur = null;
      const task = document.getElementById("practice-task");
      if (task) task.textContent = "今日挑战已完成";
      setFeedback(
        "今天答对 " + (r.state.lastScore != null ? r.state.lastScore : 0) + " / " +
          (r.state.lastTotal || pool.length) + " · 连续打卡 " + (r.state.streak || 1) + " 天",
        "good");
      const next = document.getElementById("practice-next");
      if (next) { next.hidden = false; next.textContent = "再练一遍"; }
      setProgress();
      clearMiniBoard();
      return;
    }
    showPuzzle();
  }

  function open() {
    const m = document.getElementById("practice-modal");
    if (m) m.classList.add("show");
    setTitle("战术练习");
    start();
  }

  function openDaily() {
    const m = document.getElementById("practice-modal");
    if (m) m.classList.add("show");
    setTitle("每日挑战");
    startDaily();
  }

  function close() {
    const m = document.getElementById("practice-modal");
    if (m) m.classList.remove("show");
    cur = null;
  }

  function isOpen() {
    const m = document.getElementById("practice-modal");
    return !!(m && m.classList.contains("show"));
  }

  function wire() {
    const cv = document.getElementById("practice-board");
    if (cv) cv.addEventListener("click", onBoardClick);
    const next = document.getElementById("practice-next");
    if (next) next.addEventListener("click", onNext);
    const closeBtn = document.getElementById("practice-close");
    if (closeBtn) closeBtn.addEventListener("click", close);
    const m = document.getElementById("practice-modal");
    if (m) m.addEventListener("click", (ev) => { if (ev.target === m) close(); });
  }

  global.GobanPractice = {
    init, wire, open, openDaily, close, isOpen, dailySummary,
    // pure daily helpers, exposed for unit tests
    daily: { pickForDate, advanceDaily, prevDayStr, seededRng },
  };
})(typeof window !== "undefined" ? window : globalThis);
