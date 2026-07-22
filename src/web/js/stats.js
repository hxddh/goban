/**
 * Game statistics: localStorage-backed record of finished games + aggregate
 * rendering. app.js records finished live games; replays/imports viewed
 * without finishing are never counted.
 * @module stats
 */
(function (global) {
  const Host = global.GobanHost;
  const KEY = "goban.v12.stats";
  const MAX = 200; // newest first; enough history for aggregates + future use

  function load() {
    try {
      const raw = Host.storageGet(KEY);
      if (!raw) return [];
      const arr = JSON.parse(raw);
      return Array.isArray(arr) ? arr : [];
    } catch (_) {
      return [];
    }
  }

  function persist(arr) {
    try {
      Host.storageSet(KEY, JSON.stringify(arr.slice(0, MAX)));
      return true;
    } catch (_) {
      return false;
    }
  }

  /**
   * @param {object} e { mode, difficulty, humanColor, result, moves,
   *                     durationMs, endedAt } — difficulty/humanColor are
   *                     meaningful in AI mode only.
   */
  function record(e) {
    const arr = load();
    arr.unshift(e);
    persist(arr);
  }

  function clear() {
    Host.storageRemove(KEY);
  }

  /** Aggregates for display. AI results are from the human's perspective. */
  function aggregate() {
    const arr = load();
    const diffs = ["easy", "normal", "hard", "extreme"];
    const ai = {};
    for (const d of diffs) ai[d] = { w: 0, l: 0, d: 0 };
    let pvp = { games: 0, b: 0, w: 0, d: 0 };
    let curStreak = 0, bestStreak = 0, streakOpen = true;
    let totalMoves = 0, totalMs = 0;
    // arr is newest-first: the current streak counts from the front until the
    // first non-win AI game; the best streak scans the whole list.
    let run = 0;
    for (const e of arr) {
      totalMoves += e.moves || 0;
      totalMs += e.durationMs || 0;
      if (e.mode === "ai") {
        const bucket = ai[e.difficulty] || (ai[e.difficulty] = { w: 0, l: 0, d: 0 });
        const won = e.result === e.humanColor;
        const drew = e.result === "draw";
        if (won) bucket.w++; else if (drew) bucket.d++; else bucket.l++;
        if (won) { run++; if (run > bestStreak) bestStreak = run; }
        else run = 0;
        if (streakOpen) {
          if (won) curStreak++;
          else streakOpen = false;
        }
      } else {
        pvp.games++;
        if (e.result === "b") pvp.b++; else if (e.result === "w") pvp.w++; else pvp.d++;
      }
    }
    return { games: arr.length, ai, pvp, curStreak, bestStreak, totalMoves, totalMs };
  }

  function fmtDuration(ms) {
    const m = Math.floor(ms / 60000);
    if (m < 60) return m + " 分钟";
    return (m / 60).toFixed(1) + " 小时";
  }

  /** Fill #stats-body with the aggregate tables. */
  function render() {
    const body = document.getElementById("stats-body");
    const empty = document.getElementById("stats-empty");
    if (!body) return;
    const a = aggregate();
    if (empty) empty.hidden = a.games > 0;
    body.hidden = a.games === 0;
    if (a.games === 0) { body.innerHTML = ""; return; }
    const names = { easy: "简单", normal: "普通", hard: "困难", extreme: "极难" };
    let rows = "";
    for (const d of ["easy", "normal", "hard", "extreme"]) {
      const b = a.ai[d];
      if (!b || b.w + b.l + b.d === 0) continue;
      const total = b.w + b.l + b.d;
      const rate = Math.round((b.w / total) * 100);
      rows +=
        "<tr><td>" + names[d] + "</td><td class='num'>" + b.w + "</td><td class='num'>" +
        b.l + "</td><td class='num'>" + b.d + "</td><td class='num'>" + rate + "%</td></tr>";
    }
    const aiTable = rows
      ? "<table class='stats-table'><tr><th>人机</th><th>胜</th><th>负</th><th>平</th><th>胜率</th></tr>" + rows + "</table>"
      : "";
    const pvpLine = a.pvp.games
      ? "<div class='stats-line'>双人 " + a.pvp.games + " 局 · 黑胜 " + a.pvp.b + " · 白胜 " + a.pvp.w + " · 平 " + a.pvp.d + "</div>"
      : "";
    body.innerHTML =
      aiTable + pvpLine +
      "<div class='stats-line'>连胜（人机）当前 <strong>" + a.curStreak + "</strong> · 最佳 <strong>" + a.bestStreak + "</strong></div>" +
      "<div class='stats-line muted2'>共 " + a.games + " 局 · " + a.totalMoves + " 手 · " + fmtDuration(a.totalMs) + "</div>";
  }

  global.GobanStats = { record, clear, aggregate, render };
})(typeof window !== "undefined" ? window : globalThis);
