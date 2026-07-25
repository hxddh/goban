/**
 * Game statistics: localStorage-backed record of finished games + aggregate
 * rendering. app.js records finished live games; replays/imports viewed
 * without finishing are never counted.
 * @module stats
 */
(function (global) {
  const t = (k, p) => (global.GobanI18n ? global.GobanI18n.t(k, p) : k);
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
    // Host.storageSet returns false on quota/security errors (does not throw).
    return !!Host.storageSet(KEY, JSON.stringify(arr.slice(0, MAX)));
  }

  /**
   * @param {object} e { mode, difficulty, humanColor, result, moves,
   *                     durationMs, endedAt } — difficulty/humanColor are
   *                     meaningful in AI mode only.
   */
  function record(e) {
    const arr = load();
    arr.unshift(e);
    return persist(arr);
  }

  /**
   * Remove the newest entry with matching endedAt (undo-after-win / resume).
   * @returns {boolean} true when an entry was removed and persisted.
   */
  function unrecordByEndedAt(endedAt) {
    if (typeof endedAt !== "number") return false;
    const arr = load();
    const idx = arr.findIndex((e) => e && e.endedAt === endedAt);
    if (idx < 0) return false;
    arr.splice(idx, 1);
    return persist(arr);
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
    if (m < 60) return t("stats.minutes", { n: m });
    return t("stats.hours", { n: (m / 60).toFixed(1) });
  }

  /** 每日挑战 line from practice.js (loaded before us; render runs on click). */
  function dailyLine() {
    const P = global.GobanPractice;
    const d = P && P.dailySummary ? P.dailySummary() : null;
    if (!d) return "";
    return "<div class='stats-line'>" + t("stats.dailyLine", {
      days: d.daysDone, streak: d.streak, best: d.bestStreak,
      today: d.todayDone ? t("stats.dailyToday") : "",
    }) + "</div>";
  }

  /** 战术练习 progress line (per-puzzle memory added in v1.27). */
  function practiceLine() {
    const P = global.GobanPractice;
    const s = P && P.practiceSummary ? P.practiceSummary() : null;
    if (!s || !s.seen) return "";
    return "<div class='stats-line'>" + t("stats.practiceLine", {
      seen: s.seen, total: s.total, mastered: s.mastered,
      wrong: s.wrong ? t("stats.practiceWrong", { n: s.wrong }) : "",
    }) + "</div>";
  }

  /** Fill #stats-body with the aggregate tables. */
  function render() {
    const body = document.getElementById("stats-body");
    const empty = document.getElementById("stats-empty");
    if (!body) return;
    const a = aggregate();
    const daily = dailyLine() + practiceLine();
    const hasAny = a.games > 0 || !!daily;
    if (empty) empty.hidden = hasAny;
    body.hidden = !hasAny;
    if (!hasAny) { body.innerHTML = ""; return; }
    if (a.games === 0) { body.innerHTML = daily; return; }
    const names = {
      easy: t("diff.easy.full"), normal: t("diff.normal.full"),
      hard: t("diff.hard.full"), extreme: t("diff.extreme.full"),
    };
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
      ? "<table class='stats-table'>" + t("stats.aiTable") + rows + "</table>"
      : "";
    const pvpLine = a.pvp.games
      ? "<div class='stats-line'>" +
        t("stats.pvpLine", { games: a.pvp.games, b: a.pvp.b, w: a.pvp.w, d: a.pvp.d }) + "</div>"
      : "";
    body.innerHTML =
      aiTable + pvpLine +
      "<div class='stats-line'>" +
        t("stats.streakLine", { cur: a.curStreak, best: a.bestStreak }) + "</div>" +
      daily +
      "<div class='stats-line muted2'>" + t("stats.totalLine", {
        games: a.games, moves: a.totalMoves, time: fmtDuration(a.totalMs),
      }) + "</div>";
  }

  global.GobanStats = { record, unrecordByEndedAt, clear, aggregate, render };
})(typeof window !== "undefined" ? window : globalThis);
