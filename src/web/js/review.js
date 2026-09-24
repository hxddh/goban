/**
 * Whole-game review: per-ply advantage curve + blunder detection + the review
 * modal's curve/list rendering + the persistent sidebar panel (v1.63).
 * Pure over deps injected via init() — reads game state through getters,
 * never mutates it. Jump/export glue and the modal open/close remain in app.js.
 *
 * v1.63 把失着分成三档证据,并且说出来:
 *   hard    可证明的战术事实:错失一步成五 / 漏防对手成五(coachFacts,按规则算)
 *   engine  引擎比较:同一局面同一预算,引擎的首选与实际着不同,且静态分差可见
 *   soft    局势波动:只有静态评估在对手应手后下滑,没有确定性证据
 * 第一遍(compute)是静态的、立即出;第二遍(deepen)在后台对每条 soft 失着跑一次
 * 引擎,把它升成 engine、或者撤掉(引擎也这么走)。曲线负责定位,关键手负责解释。
 * @module review
 */
(function (global) {
  const t = (k, p) => (global.GobanI18n ? global.GobanI18n.t(k, p) : k);
  const KNEE = 120;         // eval magnitude where the curve still has slope
  const DECISIVE = 20000;   // beyond this the position is won — clamp to ±1
  /** Advantage handed to the opponent by one move. */
  const BLUNDER_DROP = 0.45;
  /** 引擎比较:实际着与引擎首选的静态分差(压缩后)至少这么大才算「引擎更优」。 */
  const ENGINE_GAP = 0.08;
  /** …and at most this many, worst first: the flag rate scales with game
   *  length, so a loose 70-move game hit fourteen. A wall of red dots says
   *  no more than a blank curve did. */
  const MAX_BLUNDERS = 8;
  /** 后台引擎比较每次调用的预算(ms)。8 条失着 × 2 次 ≈ 8 秒上限,可取消。 */
  const DEEPEN_MS = 500;

  let deps = null;
  let data = null;
  /** 后台引擎比较的代际:invalidate() 递增,过期的结果一律丢弃。 */
  let deepenGen = 0;
  let deepenPromise = null;

  /**
   * @param {object} d
   * @param {() => {r:number,c:number}[]} d.getHistory
   * @param {() => number} d.getGameGen
   * @param {() => number} d.getViewIndex
   * @param {(n:number) => string[][]} d.boardAfter
   * @param {(n:number) => object|null} d.winLineAt
   * @param {(pre:string[][], color:string, played:object) => object|null} d.coachFacts
   * @param {(board:string[][], me:string) => number} d.evaluateBoard
   * @param {(board:string[][], color:string) => {r,c}[]} [d.winCells] 规则版成五点
   * @param {(opts:object) => Promise<{r,c}|null>} [d.aiMoveAsync]
   */
  function init(d) { deps = d; }

  function invalidate() { data = null; deepenGen++; deepenPromise = null; }

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

  function sameCell(a, b) { return !!(a && b && a.r === b.r && a.c === b.c); }

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
      const pre = deps.boardAfter(i - 1);
      const played = history[i - 1];
      const hard = deps.coachFacts(pre, color, played);
      let reasonKey = null;
      let drop = 0;
      let best = null;
      let punish = null;
      let kind = null;
      if (hard && hard.grade === "blunder") {
        kind = hard.kind || null;
        reasonKey = "coach." + kind;
        best = hard.best || null;
        // 漏防:对手下一手就能成五的那个点,既是「对手怎样惩罚」,也是「本该挡的点」
        if (!best && deps.winCells) {
          const after = pre.map((row) => row.slice());
          after[played.r][played.c] = color;
          const w = deps.winCells(after, color === "b" ? "w" : "b");
          if (w.length) { punish = w[0]; best = w[0]; }
        }
      } else {
        // Measured AFTER the opponent has answered, not immediately after the
        // move. Placing your own stone almost never lowers your own eval — the
        // cost of a bad move shows up in what the opponent gets to do next, so
        // comparing i-1 with i (as this did through v1.30) reported a change of
        // exactly 0.000 for 90 of 91 plies and never flagged anything.
        const sgn = color === "b" ? 1 : -1;
        const before = sgn * adv[i - 1];
        const after = sgn * adv[Math.min(i + 1, N)];
        drop = before - after;
        if (drop >= BLUNDER_DROP) reasonKey = "review.blunderReason";
      }
      if (reasonKey) {
        blunders.push({
          i, color, reasonKey, drop,
          // 存键不存译文:这份数据会活过一次语言切换(终局卡、侧栏、导出都读它)
          get reason() { return t(this.reasonKey); },
          hard: !!(hard && hard.grade === "blunder"),
          tier: hard && hard.grade === "blunder" ? "hard" : "soft",
          kind: kind, best: best, punish: punish, gap: 0,
        });
      }
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
    data = { adv, blunders, summary: { b: bCount, w: wCount }, gen, len: N, deepened: false, deepening: false };
    return data;
  }

  /** 某一着之后,从 color 视角的压缩评估。 */
  function scoreAfter(board, mv, color) {
    const b = board.map((row) => row.slice());
    b[mv.r][mv.c] = color;
    return squash(deps.evaluateBoard(b, color));
  }

  /**
   * 第二遍:对每条 soft 失着问一次引擎。返回 Promise,进行中可被 invalidate()
   * 取消(结果按代际丢弃,不会写进一份已经换掉的数据)。同一份数据只跑一次。
   */
  function deepen(opts) {
    const d = compute();
    if (!deps.aiMoveAsync || d.deepened || d.deepening) return deepenPromise || Promise.resolve(d);
    const gen = deepenGen;
    const difficulty = (opts && opts.difficulty) || "hard";
    const onProgress = (opts && opts.onProgress) || function () {};
    d.deepening = true;
    const history = deps.getHistory();
    const soft = d.blunders.filter((b) => !b.asked && (b.tier === "soft" || (b.tier === "hard" && !b.best)));
    let done = 0;
    let unresolved = 0;
    const run = async () => {
      for (const b of soft) {
        if (gen !== deepenGen) return d;
        const pre = deps.boardAfter(b.i - 1);
        const played = history[b.i - 1];
        let best = null;
        try {
          best = await deps.aiMoveAsync({ board: pre, side: b.color, difficulty: difficulty, timeMs: DEEPEN_MS });
        } catch (_) { best = null; }
        if (gen !== deepenGen) return d;
        // null 不是「引擎也这么走」:另一路引擎请求(提示、单手分析)会重建 worker,
        // 把这里悬着的请求以 null 了结。当作没问到,留在原档,下次打开复盘再问。
        if (!best) { unresolved++; done++; onProgress(done, soft.length); continue; }
        b.asked = true;
        if (b.tier === "soft") {
          if (sameCell(best, played)) {
            // 引擎也这么走:不是失着。当场撤掉 —— 进行中的每次 render 都读这份列表
            d.blunders = d.blunders.filter((x) => x !== b);
          } else {
            const gap = scoreAfter(pre, best, b.color) - scoreAfter(pre, played, b.color);
            b.gap = gap;
            if (gap >= ENGINE_GAP) {
              b.tier = "engine";
              b.best = best;
              b.reasonKey = "review.engineReason";
              // 对手怎样惩罚:实际着之后对手的首选
              const after = pre.map((row) => row.slice());
              after[played.r][played.c] = b.color;
              try {
                const reply = await deps.aiMoveAsync({ board: after, side: b.color === "b" ? "w" : "b", difficulty: difficulty, timeMs: DEEPEN_MS });
                if (gen !== deepenGen) return d;
                b.punish = reply || null;
              } catch (_) { b.punish = null; }
            }
          }
        } else if (!sameCell(best, played)) {
          b.best = best;
        }
        done++;
        onProgress(done, soft.length);
      }
      if (gen !== deepenGen) return d;
      d.summary = { b: d.blunders.filter((b) => b.color === "b").length, w: d.blunders.filter((b) => b.color === "w").length };
      d.deepened = unresolved === 0;
      d.deepening = false;
      return d;
    };
    deepenPromise = run().catch(() => { d.deepening = false; return d; });
    return deepenPromise;
  }

  function tierLabel(b) {
    if (b.tier === "hard") return t("review.tier.hard");
    if (b.tier === "engine") return t("review.tier.engine");
    return t(data && (data.deepened || !deps.aiMoveAsync) ? "review.tier.soft" : "review.tier.pending");
  }

  function coord(p) {
    return p ? String.fromCharCode(65 + p.c) + (15 - p.r) : "";
  }

  /**
   * 一条失着的结构化解释:当时的威胁 → 你的落点 → 对手可以怎样惩罚 → 可行替代。
   * 每一句都来自可验证的事实(成五点 / 引擎首选),不由自由文本模型编造。
   */
  function explain(i) {
    const d = compute();
    const b = d.blunders.find((x) => x.i === i);
    if (!b) return null;
    const history = deps.getHistory();
    const played = history[i - 1];
    const who = t(b.color === "b" ? "side.black" : "side.white");
    const oppo = t(b.color === "b" ? "side.white" : "side.black");
    const lines = [];
    if (b.kind === "missedWin") {
      lines.push(t("review.ex.threatWin", { who: who, cell: coord(b.best) }));
      lines.push(t("review.ex.played", { cell: coord(played) }));
      lines.push(t("review.ex.altWin", { cell: coord(b.best) }));
    } else if (b.kind === "missedBlock") {
      lines.push(t("review.ex.threatBlock", { oppo: oppo, cell: coord(b.punish || b.best) }));
      lines.push(t("review.ex.played", { cell: coord(played) }));
      lines.push(t("review.ex.punishWin", { oppo: oppo, cell: coord(b.punish || b.best) }));
      lines.push(t("review.ex.altBlock", { cell: coord(b.best) }));
    } else if (b.tier === "engine") {
      lines.push(t("review.ex.played", { cell: coord(played) }));
      if (b.punish) lines.push(t("review.ex.punishEngine", { oppo: oppo, cell: coord(b.punish) }));
      lines.push(t("review.ex.altEngine", { cell: coord(b.best) }));
    } else {
      lines.push(t("review.ex.played", { cell: coord(played) }));
      lines.push(t("review.ex.soft"));
    }
    return { i: i, color: b.color, tier: b.tier, label: tierLabel(b), reason: b.reason, lines: lines, best: b.best, punish: b.punish };
  }

  /** 本局「值得记住的一手」:优先可证明战术,其次引擎比较,再次分差最大。 */
  function keyMoves(color) {
    const d = compute();
    // 只从站得住的两档里挑(v1.64):「局势波动」只有静态分差,自己都不算结论,
    // 不该被终局卡说成「本局值得记住的一手」
    const rank = { hard: 0, engine: 1 };
    return d.blunders
      .filter((b) => (!color || b.color === color) && b.tier in rank)
      .sort((a, b) => (rank[a.tier] - rank[b.tier]) || (b.drop - a.drop) || (b.gap - a.gap))
      .slice(0, 3);
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
    // blunder dots: 可证明的实心,待确认/局势波动的空心 —— 证据强度不只靠列表文字
    for (const b of data.blunders) {
      g.beginPath();
      g.arc(x(b.i), y(adv[b.i]), 3, 0, Math.PI * 2);
      // --bad,不是 --win:弹层文案写着「红点为失着」,而借用 --win 时它在四套主题
      // 里分别是金 / 薄荷绿 / 棕 / 红 —— 只有练习本那一套碰巧对得上。
      if (b.tier === "soft") {
        g.strokeStyle = css.getPropertyValue("--bad").trim() || "#c0392b";
        g.lineWidth = 1.5; g.stroke();
      } else {
        g.fillStyle = css.getPropertyValue("--bad").trim() || "#c0392b";
        g.fill();
      }
    }
    // 零线两侧各是谁占优 —— v1.63 时这句只写在弹层标题里,曲线本身读不出方向
    g.fillStyle = css.getPropertyValue("--muted").trim() || "#888";
    g.font = "10px " + (getComputedStyle(document.body).fontFamily || "sans-serif");
    g.textBaseline = "top";
    g.fillText(t("review.curve.black"), pad + 2, pad);
    g.textBaseline = "bottom";
    g.fillText(t("review.curve.white"), pad + 2, pad + h);
    // current view marker
    const viewIndex = deps.getViewIndex();
    if (viewIndex >= 0 && viewIndex < n) {
      g.strokeStyle = line; g.globalAlpha = 0.4; g.lineWidth = 1;
      g.beginPath(); g.moveTo(x(viewIndex), pad); g.lineTo(x(viewIndex), pad + h); g.stroke();
      g.globalAlpha = 1;
    }
  }

  /**
   * 复盘面板(v1.64 起是唯一的复盘面):曲线、失着、当前查看那一手的解释。
   * app.js 在 sync() 里调用;只在复盘已算过且面板被打开时显示。
   */
  let sideOpen = false;
  /** 「局势波动」一档默认折叠;展开是这一次复盘里的临时状态 */
  let softOpen = false;
  function setSideOpen(v) { sideOpen = !!v; if (!sideOpen) softOpen = false; }
  function isSideOpen() { return sideOpen; }
  function toggleSoft() { softOpen = !softOpen; }

  function chip(b, viewIndex) {
    const el = document.createElement("button");
    el.type = "button";
    el.className = "review-chip tier-" + b.tier + (b.i === viewIndex ? " cur" : "");
    el.dataset.i = b.i;
    el.title = b.reason + " · " + tierLabel(b);
    el.textContent = String(b.i);
    return el;
  }

  function renderSide() {
    const el = document.getElementById("review-side");
    if (!el) return;
    const show = sideOpen && !!data && deps.getHistory().length >= 2;
    el.hidden = !show;
    if (!show) return;
    const stat = document.getElementById("review-stat");
    // 头上的数只数站得住的两档;折叠着的「局势波动」由它自己那枚芯片说
    const firmOf = (c) => data.blunders.filter((b) => b.color === c && b.tier !== "soft").length;
    if (stat) stat.textContent = t("review.side.stat", { b: firmOf("b"), w: firmOf("w") });
    const prog = document.getElementById("review-progress");
    if (prog) prog.hidden = !data.deepening;
    const note = document.getElementById("review-renju-note");
    if (note) note.hidden = !(deps.getRenju && deps.getRenju());
    const chips = document.getElementById("review-side-chips");
    const viewIndex = deps.getViewIndex();
    if (chips) {
      chips.innerHTML = "";
      const firm = data.blunders.filter((b) => b.tier !== "soft");
      const soft = data.blunders.filter((b) => b.tier === "soft");
      for (const b of firm) chips.appendChild(chip(b, viewIndex));
      // 正在看的那一手若是软失着,不折叠它 —— 否则解释在,芯片却不见了
      const showSoft = softOpen || soft.some((b) => b.i === viewIndex);
      if (showSoft) for (const b of soft) chips.appendChild(chip(b, viewIndex));
      if (soft.length && !soft.some((b) => b.i === viewIndex)) {
        const more = document.createElement("button");
        more.type = "button";
        more.className = "review-chip more";
        more.dataset.more = "1";
        more.textContent = softOpen
          ? t("review.side.softLess")
          : t(data.deepened || !deps.aiMoveAsync ? "review.side.softMore" : "review.side.pendingMore", { n: soft.length });
        chips.appendChild(more);
      }
      if (!firm.length && !showSoft && !soft.length) {
        const p = document.createElement("span");
        p.className = "muted";
        p.textContent = t("review.none");
        chips.appendChild(p);
      }
    }
    const ex = document.getElementById("review-side-explain");
    const actions = document.getElementById("review-side-actions");
    const info = explain(viewIndex);
    if (ex) {
      ex.innerHTML = "";
      if (!info) {
        const p = document.createElement("div");
        p.className = "muted";
        p.textContent = data.blunders.length ? t("review.side.pick") : t("review.side.clean");
        ex.appendChild(p);
      } else {
        const head = document.createElement("div");
        head.className = "rs-head";
        const who = t(info.color === "b" ? "side.black" : "side.white");
        head.textContent = t("review.blunderRow", { n: info.i, color: who }) + " · " + info.reason;
        const tier = document.createElement("span");
        tier.className = "rb-tier";
        tier.textContent = info.label;
        head.appendChild(tier);
        ex.appendChild(head);
        const ol = document.createElement("ol");
        ol.className = "rs-lines";
        for (const line of info.lines) {
          const li = document.createElement("li");
          li.textContent = line;
          ol.appendChild(li);
        }
        ex.appendChild(ol);
      }
    }
    if (actions) actions.hidden = !info;
    // draw after layout so clientWidth is real
    requestAnimationFrame(drawCurve);
  }

  global.GobanReview = {
    init, invalidate, getData, compute, deepen, explain, keyMoves,
    render: renderSide, renderSide, setSideOpen, isSideOpen, toggleSoft,
    ENGINE_GAP,
  };
})(typeof window !== "undefined" ? window : globalThis);
