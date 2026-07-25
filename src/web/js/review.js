/**
 * Whole-game review: per-ply advantage curve + blunder detection + the review
 * modal's curve/list rendering. Pure over deps injected via init() — reads
 * game state through getters, never mutates it. Jump/export glue and the
 * modal open/close remain in app.js.
 * @module review
 */
(function (global) {
  const t = (k, p) => (global.GobanI18n ? global.GobanI18n.t(k, p) : k);
  const SQUASH = 1200;      // static-eval scale → tanh spread
  const BLUNDER_DROP = 0.3; // squashed-advantage loss that flags a mistake

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

  /** Signed advantage from Black's perspective at ply i, squashed to [-1,1]. */
  function advAt(i) {
    if (i > 0 && deps.winLineAt(i)) return (i - 1) % 2 === 0 ? 1 : -1; // someone just won
    const raw = deps.evaluateBoard(deps.boardAfter(i), "b");
    return Math.tanh(raw / SQUASH);
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
    const blunders = [];
    let bCount = 0, wCount = 0;
    for (let i = 1; i <= N; i++) {
      const color = (i - 1) % 2 === 0 ? "b" : "w";
      const hard = deps.coachFacts(deps.boardAfter(i - 1), color, history[i - 1]);
      let reason = null;
      if (hard && hard.grade === "blunder") reason = hard.text;
      else {
        // advantage from the mover's own perspective before vs after
        const before = color === "b" ? adv[i - 1] : -adv[i - 1];
        const after = color === "b" ? adv[i] : -adv[i];
        if (before - after >= BLUNDER_DROP) reason = t("review.blunderReason");
      }
      if (reason) {
        blunders.push({ i, color, reason });
        if (color === "b") bCount++; else wCount++;
      }
    }
    data = { adv, blunders, summary: { b: bCount, w: wCount }, gen, len: N };
    return data;
  }

  function drawCurve() {
    const cv = document.getElementById("review-curve");
    if (!cv || !data) return;
    const dpr = window.devicePixelRatio || 1;
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
    // zero (even) midline
    g.strokeStyle = mid; g.lineWidth = 1;
    g.beginPath(); g.moveTo(pad, y(0)); g.lineTo(pad + w, y(0)); g.stroke();
    // advantage area
    g.beginPath();
    g.moveTo(x(0), y(adv[0]));
    for (let i = 1; i < n; i++) g.lineTo(x(i), y(adv[i]));
    g.lineTo(x(n - 1), y(0)); g.lineTo(x(0), y(0)); g.closePath();
    g.fillStyle = (line || "#3b82f6") + "22";
    g.fill();
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
