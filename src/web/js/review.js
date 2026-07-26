/**
 * Whole-game review: per-ply advantage curve + blunder detection + the review
 * modal's curve/list rendering. Pure over deps injected via init() — reads
 * game state through getters, never mutates it. Jump/export glue and the
 * modal open/close remain in app.js.
 * @module review
 */
(function (global) {
  const t = (k, p) => (global.GobanI18n ? global.GobanI18n.t(k, p) : k);
  const KNEE = 120;         // eval magnitude where the curve still has slope
  const DECISIVE = 20000;   // beyond this the position is won — clamp to ±1
  /** Advantage handed to the opponent by one move. */
  const BLUNDER_DROP = 0.45;
  /** …and at most this many, worst first: the flag rate scales with game
   *  length, so a loose 70-move game hit fourteen. A wall of red dots says
   *  no more than a blank curve did. */
  const MAX_BLUNDERS = 8;

  let deps = null;
  let data = null;

  /**
   * @param {object} d
   * @param {() => {r:number,c:number}[]} d.getHistory
   * @param {() => number} d.getGameGen
   * @param {() => number} d.getViewIndex
   * @param {(n:number) => string[][]} d.boardAfter
   * @param {(n:number) => object|null} d.winLineAt
   * @param {(pre:string[][], color:string, played:object) => object|null} d.coachFacts
   * @param {(board:string[][], me:string) => number} d.evaluateBoard
   */
  function init(d) { deps = d; }

  function invalidate() { data = null; }

  function getData() { return data; }

  /**
   * Signed advantage from Black's perspective at ply i, compressed to [-1,1].
   *
   * Not tanh(raw/1200) any more. That saturated: evalStatic reaches 10^5 once
   * either side has a real threat and 10^10 near a five, so from about ply 7
   * every game read exactly 1.000000 to the end. Measured over 91 plies, 90
   * of them had a per-move change of exactly 0.000 — the curve was a flat
   * line at the ceiling and the blunder detector below it could never fire.
   *
   * A signed log spreads the range that actually varies (hundreds to a few
   * thousand) and treats anything past DECISIVE as won, which it is.
   */
  function squash(raw) {
    const s = raw < 0 ? -1 : 1;
    const a = Math.abs(raw);
    if (a >= DECISIVE) return s;
    return s * (Math.log1p(a / KNEE) / Math.log1p(DECISIVE / KNEE));
  }

  function advAt(i) {
    if (i > 0 && deps.winLineAt(i)) return (i - 1) % 2 === 0 ? 1 : -1; // someone just won
    return squash(deps.evaluateBoard(deps.boardAfter(i), "b"));
  }

  /** Analyze the whole game: per-ply Black-advantage + flagged blunders. */
  function compute() {
    const history = deps.getHistory();
    const gen = deps.getGameGen();
    const N = history.length;
    // Static-eval sweep over every ply is O(N × evaluateBoard) — noticeable on
    // long games. The result only depends on the game identity, so reuse it
    // when neither the game nor its length changed since last computed.
    if (data && data.gen === gen && data.len === N) return data;
    const adv = [];
    for (let i = 0; i <= N; i++) adv.push(advAt(i));
    let blunders = [];
    let bCount = 0, wCount = 0;
    for (let i = 1; i <= N; i++) {
      const color = (i - 1) % 2 === 0 ? "b" : "w";
      const hard = deps.coachFacts(deps.boardAfter(i - 1), color, history[i - 1]);
      let reason = null;
      let drop = 0;
      if (hard && hard.grade === "blunder") reason = hard.text;
      else {
        // Measured AFTER the opponent has answered, not immediately after the
        // move. Placing your own stone almost never lowers your own eval — the
        // cost of a bad move shows up in what the opponent gets to do next, so
        // comparing i-1 with i (as this did through v1.30) reported a change of
        // exactly 0.000 for 90 of 91 plies and never flagged anything.
        const sgn = color === "b" ? 1 : -1;
        const before = sgn * adv[i - 1];
        const after = sgn * adv[Math.min(i + 1, N)];
        drop = before - after;
        if (drop >= BLUNDER_DROP) reason = t("review.blunderReason");
      }
      if (reason) blunders.push({ i, color, reason, drop, hard: !!(hard && hard.grade === "blunder") });
    }
    // Keep the worst, but list them in playing order — a review is read
    // forwards. Hard verdicts (missed win / missed block) always survive:
    // they are facts about the position, not a score difference.
    if (blunders.length > MAX_BLUNDERS) {
      const keep = blunders.slice().sort((a, b) => (b.hard - a.hard) || (b.drop - a.drop)).slice(0, MAX_BLUNDERS);
      const keepSet = new Set(keep.map((x) => x.i));
      blunders = blunders.filter((x) => keepSet.has(x.i));
    }
    for (const b of blunders) { if (b.color === "b") bCount++; else wCount++; }
    data = { adv, blunders, summary: { b: bCount, w: wCount }, gen, len: N };
    return data;
  }

  function drawCurve() {
    const cv = document.getElementById("review-curve");
    if (!cv || !data) return;
    // 上限与另外两块画布同一条:主棋盘实测 3× 重建 74.2ms(2× 为 33.5ms),
    // 练习棋盘 v1.39 起也封在 2×。这里此前不封顶,实测 dpr=3 时位图 1008×282。
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const cssW = cv.clientWidth || 320;
    const cssH = cv.clientHeight || 96;
    cv.width = Math.round(cssW * dpr);
    cv.height = Math.round(cssH * dpr);
    const g = cv.getContext("2d");
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, cssW, cssH);
    const adv = data.adv;
    const n = adv.length;
    const pad = 6;
    const w = cssW - pad * 2;
    const h = cssH - pad * 2;
    const x = (i) => pad + (n <= 1 ? 0 : (i / (n - 1)) * w);
    const y = (v) => pad + (1 - (v + 1) / 2) * h; // +1 top (black), −1 bottom (white)
    const css = getComputedStyle(document.documentElement);
    const line = css.getPropertyValue("--accent").trim() || "#3b82f6";
    const mid = css.getPropertyValue("--card-border").trim() || "#ccc";
    // 零势中线是水平的,所以它该是清晰的一条。描边跨在路径两侧:落在整数上会被
    // 光栅化成两行半调,落在 x.5 上奇数宽度才盖满整行 —— 与主棋盘 crisp() 同一条规则。
    const snap = (v) => Math.round(v * dpr) / dpr + 0.5 / dpr;
    g.strokeStyle = mid; g.lineWidth = 1 / dpr * Math.max(1, Math.round(dpr));
    g.beginPath(); g.moveTo(pad, snap(y(0))); g.lineTo(pad + w, snap(y(0))); g.stroke();
    // advantage area
    g.beginPath();
    g.moveTo(x(0), y(adv[0]));
    for (let i = 1; i < n; i++) g.lineTo(x(i), y(adv[i]));
    g.lineTo(x(n - 1), y(0)); g.lineTo(x(0), y(0)); g.closePath();
    // 此前是 line + "22" —— 把 alpha 拼到 CSS 颜色字符串后面。四个主题的 --accent
    // 恰好都是 hex 才没出事;写成 rgb() 或色名就会拼出非法值,而 canvas 对非法
    // fillStyle 是静默忽略的 —— 面积填充直接消失,不报任何错。改成用 globalAlpha,
    // 与颜色写法无关。
    g.fillStyle = line;
    g.globalAlpha = 0.13;
    g.fill();
    g.globalAlpha = 1;
    // advantage line
    g.beginPath();
    g.moveTo(x(0), y(adv[0]));
    for (let i = 1; i < n; i++) g.lineTo(x(i), y(adv[i]));
    g.strokeStyle = line; g.lineWidth = 1.8; g.lineJoin = "round";
    g.stroke();
    // blunder dots
    for (const b of data.blunders) {
      g.beginPath();
      g.arc(x(b.i), y(adv[b.i]), 3, 0, Math.PI * 2);
      g.fillStyle = css.getPropertyValue("--win").trim() || "#c0392b";
      g.fill();
    }
    // current view marker
    const viewIndex = deps.getViewIndex();
    if (viewIndex >= 0 && viewIndex < n) {
      g.strokeStyle = line; g.globalAlpha = 0.4; g.lineWidth = 1;
      g.beginPath(); g.moveTo(x(viewIndex), pad); g.lineTo(x(viewIndex), pad + h); g.stroke();
      g.globalAlpha = 1;
    }
  }

  /** Fill the review modal (stat line, blunder list, curve). */
  function render() {
    const empty = document.getElementById("review-empty");
    const body = document.getElementById("review-body");
    if (deps.getHistory().length < 2) {
      if (empty) empty.hidden = false;
      if (body) body.hidden = true;
      return;
    }
    compute();
    if (empty) empty.hidden = true;
    if (body) body.hidden = false;
    const stat = document.getElementById("review-stat");
    if (stat) {
      const s = data.summary;
      stat.textContent = t(s.b + s.w === 0 ? "review.statClean" : "review.stat", { b: s.b, w: s.w });
    }
    const list = document.getElementById("review-blunders");
    if (list) {
      list.innerHTML = "";
      if (!data.blunders.length) {
        const p = document.createElement("div");
        p.className = "muted review-none";
        p.textContent = t("review.none");
        list.appendChild(p);
      }
      for (const b of data.blunders) {
        const row = document.createElement("button");
        row.type = "button";
        row.className = "review-blunder-row";
        row.dataset.i = b.i;
        const who = t(b.color === "b" ? "side.black" : "side.white");
        const reason = document.createElement("span");
        reason.className = "rb-reason";
        reason.textContent = b.reason; // textContent — never HTML-inject reasons
        const move = document.createElement("span");
        move.className = "rb-move";
        move.textContent = t("review.blunderRow", { n: b.i, color: who });
        row.appendChild(move);
        row.appendChild(reason);
        list.appendChild(row);
      }
    }
    // draw after layout so clientWidth is real
    requestAnimationFrame(drawCurve);
  }

  global.GobanReview = { init, invalidate, getData, compute, render };
})(typeof window !== "undefined" ? window : globalThis);
