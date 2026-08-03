/**
 * Game statistics: localStorage-backed record of finished games + aggregate
 * rendering. app.js records finished live games; replays/imports viewed
 * without finishing are never counted.
 *
 * **Two stores, and the split is the point.**
 *
 * Until v1.44 every displayed number was recomputed from the game list, and
 * that list is capped at 200 entries. So from game 201 the panel quietly
 * became "your last 200 games" while still reading as "a total" — and one
 * number did worse than stall, it went *backwards*. Measured: 12 straight
 * wins, then 200 losses, and 「最佳连胜」 read 12 → 12 → **0**, because the
 * dozen wins had been pushed out of storage. A record that forgets is worse
 * than no record.
 *
 *   `TOTALS_KEY`  — lifetime counters. Only `record` / `unrecord` move them,
 *                   never a recomputation. Everything on screen reads here.
 *   `KEY`         — the newest 200 games. Now only used to match an
 *                   `endedAt` for undo-after-win, and to seed totals once.
 *
 * 每日打卡 in practice.js has always stored its streak this way
 * (`if (st.streak > st.bestStreak) st.bestStreak = st.streak`). This module
 * was the odd one out.
 * @module stats
 */
(function (global) {
  const t = (k, p) => (global.GobanI18n ? global.GobanI18n.t(k, p) : k);
  const Host = global.GobanHost;
  const KEY = "goban.v12.stats";
  const TOTALS_KEY = "goban.v12.totals";
  const MAX = 200; // newest first; matching an endedAt never needs more
  const DIFFS = ["easy", "normal", "hard", "extreme"];

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

  function emptyTotals() {
    const ai = {};
    for (const d of DIFFS) ai[d] = { w: 0, l: 0, d: 0 };
    return {
      games: 0, moves: 0, ms: 0,
      ai: ai,
      pvp: { games: 0, b: 0, w: 0, d: 0 },
      curStreak: 0, bestStreak: 0,
    };
  }

  /**
   * Lifetime counters, seeded once from whatever the game list still holds.
   *
   * The seed is an honest floor, not a reconstruction: a profile already past
   * 200 games lost the overflow long before this key existed, and no amount of
   * arithmetic brings it back. Counting resumes from what survived.
   */
  function loadTotals() {
    let st = null;
    try {
      const raw = Host.storageGet(TOTALS_KEY);
      if (raw) st = JSON.parse(raw);
    } catch (_) { st = null; }
    if (!st || typeof st !== "object") st = null;
    if (st) {
      const out = emptyTotals();
      out.games = st.games || 0; out.moves = st.moves || 0; out.ms = st.ms || 0;
      for (const d of DIFFS) {
        const b = (st.ai && st.ai[d]) || {};
        out.ai[d] = { w: b.w || 0, l: b.l || 0, d: b.d || 0 };
      }
      const p = st.pvp || {};
      out.pvp = { games: p.games || 0, b: p.b || 0, w: p.w || 0, d: p.d || 0 };
      out.curStreak = st.curStreak || 0;
      out.bestStreak = st.bestStreak || 0;
      return out;
    }
    return fromList(load());
  }

  function saveTotals(st) { return !!Host.storageSet(TOTALS_KEY, JSON.stringify(st)); }

  /** Fold the retained list into a totals-shaped object (seeding only). */
  function fromList(arr) {
    const out = emptyTotals();
    let run = 0, streakOpen = true;
    for (const e of arr) {                       // newest-first
      if (!e) continue;
      out.games++;
      out.moves += e.moves || 0;
      out.ms += e.durationMs || 0;
      if (e.mode === "ai") {
        const bucket = out.ai[e.difficulty] || (out.ai[e.difficulty] = { w: 0, l: 0, d: 0 });
        const won = e.result === e.humanColor;
        if (won) bucket.w++; else if (e.result === "draw") bucket.d++; else bucket.l++;
        if (won) { run++; if (run > out.bestStreak) out.bestStreak = run; } else run = 0;
        if (streakOpen) { if (won) out.curStreak++; else streakOpen = false; }
      } else {
        out.pvp.games++;
        if (e.result === "b") out.pvp.b++; else if (e.result === "w") out.pvp.w++; else out.pvp.d++;
      }
    }
    return out;
  }

  /**
   * @param {object} e { mode, difficulty, humanColor, result, moves,
   *                     durationMs, endedAt } — difficulty/humanColor are
   *                     meaningful in AI mode only.
   */
  function record(e) {
    const st = loadTotals();
    st.games++;
    st.moves += e.moves || 0;
    st.ms += e.durationMs || 0;
    if (e.mode === "ai") {
      const bucket = st.ai[e.difficulty] || (st.ai[e.difficulty] = { w: 0, l: 0, d: 0 });
      const won = e.result === e.humanColor;
      if (won) bucket.w++; else if (e.result === "draw") bucket.d++; else bucket.l++;
      if (won) {
        st.curStreak++;
        if (st.curStreak > st.bestStreak) st.bestStreak = st.curStreak;
      } else {
        st.curStreak = 0;
      }
    } else {
      // 对弈局既不算连胜也不打断连胜 —— 那条连胜说的是「对电脑」。
      st.pvp.games++;
      if (e.result === "b") st.pvp.b++; else if (e.result === "w") st.pvp.w++; else st.pvp.d++;
    }
    saveTotals(st);
    const arr = load();
    arr.unshift(e);
    return persist(arr);
  }

  /**
   * Remove the newest entry with matching endedAt (undo-after-win / resume).
   *
   * `bestStreak` is deliberately NOT rolled back. It is a high-water mark, and
   * a record that flickers downward on an undo is the very failure v1.44 set
   * out to fix; being one too high for a moment is the cheaper wrong.
   * @returns {boolean} true when an entry was removed and persisted.
   */
  function unrecordByEndedAt(endedAt) {
    if (typeof endedAt !== "number") return false;
    const arr = load();
    const idx = arr.findIndex((e) => e && e.endedAt === endedAt);
    if (idx < 0) return false;
    const e = arr[idx];
    arr.splice(idx, 1);
    const st = loadTotals();
    st.games = Math.max(0, st.games - 1);
    st.moves = Math.max(0, st.moves - (e.moves || 0));
    st.ms = Math.max(0, st.ms - (e.durationMs || 0));
    if (e.mode === "ai") {
      const bucket = st.ai[e.difficulty];
      const won = e.result === e.humanColor;
      if (bucket) {
        if (won) bucket.w = Math.max(0, bucket.w - 1);
        else if (e.result === "draw") bucket.d = Math.max(0, bucket.d - 1);
        else bucket.l = Math.max(0, bucket.l - 1);
      }
      if (won) st.curStreak = Math.max(0, st.curStreak - 1);
    } else {
      st.pvp.games = Math.max(0, st.pvp.games - 1);
      if (e.result === "b") st.pvp.b = Math.max(0, st.pvp.b - 1);
      else if (e.result === "w") st.pvp.w = Math.max(0, st.pvp.w - 1);
      else st.pvp.d = Math.max(0, st.pvp.d - 1);
    }
    saveTotals(st);
    return persist(arr);
  }

  function clear() {
    Host.storageRemove(KEY);
    Host.storageRemove(TOTALS_KEY);
  }

  /**
   * Aggregates for display. AI results are from the human's perspective.
   *
   * Reads the lifetime counters — **not** the game list. Recomputing from the
   * list is what made every number here silently mean "your last 200 games",
   * and made 「最佳连胜」 fall from 12 to 0 once those wins aged out.
   */
  function aggregate() {
    const st = loadTotals();
    return {
      games: st.games, ai: st.ai, pvp: st.pvp,
      curStreak: st.curStreak, bestStreak: st.bestStreak,
      totalMoves: st.moves, totalMs: st.ms,
    };
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
    // 「清空」清的是**对局统计**,所以它的可用状态要跟对局数走 —— 不是跟 hasAny。
    // v1.39 修掉了「零对局时照样可点」,判据却写成 hasAny(= 有对局 或 有每日打卡),
    // 于是「做过每日挑战、一局没下完」这个很常见的状态下按钮又活了过来:实测点下去、
    // 确认,正文一个字都不变 —— clear() 根本不碰每日打卡。
    const clearBtn = document.getElementById("stats-clear");
    if (clearBtn) clearBtn.disabled = a.games === 0;
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
