/**
 * Canvas board rendering (themes + paint).
 * Model via attach(canvas, ctx, modelFn):
 *   board, history, viewIndex, themeId, placeAnim, winLine, winFlashUntil,
 *   clearPlaceAnim, hover {r,c,color}|null, hint {r,c}|null
 */
(function (global) {
  const SIZE = (global.GobanCore && global.GobanCore.SIZE) || 15;

  const STARS = [
    [3, 3], [3, 7], [3, 11],
    [7, 3], [7, 7], [7, 11],
    [11, 3], [11, 7], [11, 11],
  ];

  const THEMES = {
    wood: {
      boardTop: "#e8c49a", boardMid: "#d4a574", boardBot: "#c28b52",
      grain: true, line: "#3d2914", star: "#3d2914",
      style: "stone",
      lastB: "rgba(255,255,255,0.4)",
      lastW: "rgba(30,22,14,0.32)",
      win: "rgba(160, 70, 50, 0.55)",
      hint: "rgba(40, 110, 180, 0.75)",
      analysis: "rgba(210, 150, 30, 0.9)",
    },
    night: {
      boardTop: "#1e332c", boardMid: "#172822", boardBot: "#101c18",
      grain: false, line: "#5a7a6c", star: "#7dcea0",
      style: "stone",
      lastB: "rgba(220,230,225,0.38)",
      lastW: "rgba(10,16,14,0.4)",
      win: "rgba(125, 206, 160, 0.55)",
      hint: "rgba(120, 220, 180, 0.8)",
      analysis: "rgba(240, 190, 90, 0.95)",
    },
    day: {
      boardTop: "#f6ead4", boardMid: "#ecd9b5", boardBot: "#e2cba0",
      grain: true, line: "#6b5344", star: "#6b5344",
      style: "stone",
      lastB: "rgba(255,255,255,0.45)",
      lastW: "rgba(40,35,28,0.3)",
      win: "rgba(140, 90, 50, 0.5)",
      hint: "rgba(50, 100, 170, 0.75)",
      analysis: "rgba(190, 130, 20, 0.9)",
    },
    notebook: {
      paper: "#fffcf5",
      grid: "#c5d4e8",
      gridStrong: "#9db4d0",
      margin: "#e8a0a0",
      line: "#5a6a80",
      pencil: "#2a3140",
      pencilB: "#1e3a5f",
      pencilW: "#9a3412",
      style: "pencil",
      lastB: "rgba(30,58,95,0.45)",
      lastW: "rgba(154,52,18,0.4)",
      win: "rgba(120, 60, 55, 0.5)",
      hint: "rgba(30, 100, 160, 0.85)",
      analysis: "rgba(180, 120, 20, 0.9)",
    },
  };

  let _canvas = null;
  let _ctx = null;
  let _model = null;
  let rafId = 0;
  /** Offscreen base layer: board background + grid + stones. Rebuilt only
   *  when the position/theme/size changes; hover/hint/markers composite on
   *  top so mousemove repaints cost one drawImage, not a full repaint. */
  let baseCanvas = null;
  let baseCtx = null;
  let baseSig = "";

  function attach(canvas, ctx, modelFn) {
    _canvas = canvas;
    _ctx = ctx;
    _model = modelFn;
  }

  function getM() {
    return _model ? _model() : null;
  }

  function geometry() {
    const w = _canvas.width;
    const pad = w * 0.045;
    const span = w - pad * 2;
    const step = span / (SIZE - 1);
    return { pad, step, w };
  }

  function resizeCanvas() {
    if (!_canvas) return;
    // Measure the canvas itself, not #board-wrap: the wrap's rect includes
    // the wooden frame padding, so sizing the backing store from it left the
    // bitmap ~16px larger than the display size — a fractional downscale
    // that blurred every line and stone.
    const rect = _canvas.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const css = Math.max(200, Math.min(rect.width, rect.height));
    const px = Math.round(css * dpr);
    if (_canvas.width !== px) {
      _canvas.width = px;
      _canvas.height = px;
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
    const ctx = _ctx;
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
    const ctx = _ctx;
    ctx.beginPath();
    ctx.arc(x, y, radius, 0, Math.PI * 2);
    ctx.strokeStyle = color;
    ctx.lineWidth = lineW;
    ctx.lineCap = "round";
    ctx.stroke();
  }

  function easeOutCubic(t) {
    const t1 = 1 - t;
    return 1 - t1 * t1 * t1;
  }

  function prefersReducedMotion() {
    try {
      return !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
    } catch (_) {
      return false;
    }
  }

  // Restrained place-in: a small monotonic scale-up (no overshoot/pop) over
  // 120ms, only for the just-placed stone. Honors reduce-motion (no anim), so
  // it never competes with reading the board mid-game.
  function stoneScale(r, c) {
    const m = getM();
    const placeAnim = m && m.placeAnim;
    if (!placeAnim || placeAnim.r !== r || placeAnim.c !== c) return 1;
    if (prefersReducedMotion()) return 1;
    const t = Math.min(1, (performance.now() - placeAnim.t0) / 120);
    if (t >= 1) return 1;
    return 0.88 + 0.12 * easeOutCubic(t);
  }

  function ensureAnimLoop() {
    if (rafId) return;
    const tick = () => {
      rafId = 0;
      let need = false;
      const m = getM();
      if (m && m.placeAnim) {
        if (performance.now() - m.placeAnim.t0 < 140) need = true;
        else if (m.clearPlaceAnim) m.clearPlaceAnim();
      }
      if (m && performance.now() < (m.winFlashUntil || 0)) need = true;
      draw();
      if (need) rafId = requestAnimationFrame(tick);
    };
    rafId = requestAnimationFrame(tick);
  }

  function boardSig(board) {
    let h = 0;
    for (let r = 0; r < SIZE; r++)
      for (let c = 0; c < SIZE; c++) {
        const s = board[r][c];
        if (s) h = (Math.imul(h, 31) + r * 15 + c + (s === "b" ? 300 : 600)) | 0;
      }
    return h;
  }

  function paintBase(m, w) {
    const board = m.board;
    const themeId = m.themeId;
    const ctx = baseCtx;
    const { pad, step } = geometry();
    const th = THEMES[themeId] || THEMES.wood;
    const savedCtx = _ctx;
    _ctx = baseCtx; // outline helpers + stoneScale draw into the base layer
    ctx.clearRect(0, 0, w, w);

    if (th.style === "pencil") {
      ctx.fillStyle = th.paper;
      ctx.fillRect(0, 0, w, w);
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
      ctx.strokeStyle = th.margin;
      ctx.lineWidth = Math.max(1.5, w / 400);
      const marginX = pad - step * 0.15;
      if (marginX > 4) {
        ctx.beginPath();
        ctx.moveTo(marginX, pad - step * 0.1);
        ctx.lineTo(marginX, pad + step * (SIZE - 1) + step * 0.1);
        ctx.stroke();
      }
      ctx.strokeStyle = th.line;
      ctx.lineWidth = Math.max(1.5, w / 350);
      ctx.strokeRect(pad - 1, pad - 1, step * (SIZE - 1) + 2, step * (SIZE - 1) + 2);
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
      const markR = step * 0.36;
      const lw = Math.max(1.8, step * 0.08);
      const inkB = th.pencilB || th.pencil;
      const inkW = th.pencilW || th.pencil;
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
          if (s === "b") drawOutlineTriangle(x, y, step * 0.78, inkB, lw);
          else drawOutlineCircle(x, y, markR, inkW, lw);
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

    // Coordinate labels: columns A-O along the bottom, rows 15-1 down the left
    if (m.coords) {
      ctx.save();
      ctx.fillStyle = th.style === "pencil" ? (th.pencil || th.line) : th.line;
      ctx.globalAlpha = 0.5;
      const fs = Math.max(8, step * 0.24);
      ctx.font = "500 " + fs + "px system-ui, -apple-system, sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      for (let i = 0; i < SIZE; i++) {
        const p = pad + i * step;
        ctx.fillText(String.fromCharCode(65 + i), p, pad + step * (SIZE - 1) + pad * 0.55);
        ctx.fillText(String(SIZE - i), pad * 0.42, p);
      }
      ctx.restore();
    }

    _ctx = savedCtx;
  }

  function draw() {
    const m = getM();
    if (!m || !_ctx || !_canvas) return;
    const board = m.board;
    const history = m.history;
    const viewIndex = m.viewIndex;
    const themeId = m.themeId;
    const winLine = m.winLine;
    const ctx = _ctx;
    const { pad, step, w } = geometry();
    const th = THEMES[themeId] || THEMES.wood;

    if (!baseCanvas) {
      baseCanvas = document.createElement("canvas");
      baseCtx = baseCanvas.getContext("2d");
    }
    if (baseCanvas.width !== w) {
      baseCanvas.width = w;
      baseCanvas.height = w;
      baseSig = "";
    }
    // While the place animation runs the animated stone lives in the base,
    // so keep repainting it; otherwise repaint only on real changes.
    const animActive = !!m.placeAnim;
    const sig = themeId + "|" + (m.coords ? 1 : 0) + "|" + boardSig(board);
    if (animActive || sig !== baseSig) {
      paintBase(m, w);
      baseSig = animActive ? "" : sig;
    }

    ctx.clearRect(0, 0, w, w);
    ctx.drawImage(baseCanvas, 0, 0);

    // Hover ghost (next stone preview)
    const hover = m.hover;
    if (hover && hover.r >= 0 && hover.c >= 0 && !board[hover.r][hover.c]) {
      const x = pad + hover.c * step;
      const y = pad + hover.r * step;
      const color = hover.color === "w" ? "w" : "b";
      ctx.save();
      ctx.globalAlpha = th.style === "pencil" ? 0.45 : 0.38;
      if (th.style === "pencil") {
        const ink = color === "b" ? (th.pencilB || th.pencil) : (th.pencilW || th.pencil);
        const lw = Math.max(1.5, step * 0.07);
        if (color === "b") drawOutlineTriangle(x, y, step * 0.72, ink, lw);
        else drawOutlineCircle(x, y, step * 0.34, ink, lw);
      } else {
        const rr = step * 0.4;
        const sg = ctx.createRadialGradient(
          x - rr * 0.35, y - rr * 0.4, rr * 0.1, x, y, rr
        );
        if (color === "b") {
          sg.addColorStop(0, "#5a5a5a");
          sg.addColorStop(1, "#111");
        } else {
          sg.addColorStop(0, "#fff");
          sg.addColorStop(1, "#c8c8c8");
        }
        ctx.beginPath();
        ctx.arc(x, y, rr, 0, Math.PI * 2);
        ctx.fillStyle = sg;
        ctx.fill();
        if (color === "w") {
          ctx.strokeStyle = "rgba(0,0,0,0.2)";
          ctx.lineWidth = 1;
          ctx.stroke();
        }
      }
      ctx.restore();
    }

    if (viewIndex > 0 && history[viewIndex - 1]) {
      const last = history[viewIndex - 1];
      const x = pad + last.c * step;
      const y = pad + last.r * step;
      const markR = Math.max(2.2, step * 0.105);
      ctx.beginPath();
      ctx.arc(x, y, markR, 0, Math.PI * 2);
      ctx.strokeStyle = board[last.r][last.c] === "b" ? th.lastB : th.lastW;
      ctx.lineWidth = Math.max(1.05, step * 0.032);
      ctx.stroke();
    }

    // Hint marker (suggested move, not placed)
    const hint = m.hint;
    if (hint && hint.r >= 0 && hint.c >= 0 && !board[hint.r][hint.c]) {
      const x = pad + hint.c * step;
      const y = pad + hint.r * step;
      const rr = Math.max(4, step * 0.28);
      ctx.save();
      ctx.strokeStyle = th.hint || "rgba(40,110,180,0.75)";
      ctx.lineWidth = Math.max(1.8, step * 0.07);
      ctx.setLineDash([Math.max(3, step * 0.12), Math.max(2.5, step * 0.09)]);
      ctx.beginPath();
      ctx.arc(x, y, rr, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
      // small cross
      const s = Math.max(3, step * 0.12);
      ctx.lineWidth = Math.max(1.4, step * 0.05);
      ctx.beginPath();
      ctx.moveTo(x - s, y);
      ctx.lineTo(x + s, y);
      ctx.moveTo(x, y - s);
      ctx.lineTo(x, y + s);
      ctx.stroke();
      ctx.restore();
    }

    // Analysis marker (replay coach's better move) — a dashed diamond, gold,
    // distinct from the blue hint ring so review vs live-hint never blur.
    const analysis = m.analysis;
    if (analysis && analysis.r >= 0 && analysis.c >= 0 && !board[analysis.r][analysis.c]) {
      const x = pad + analysis.c * step;
      const y = pad + analysis.r * step;
      const rr = Math.max(5, step * 0.32);
      ctx.save();
      ctx.strokeStyle = th.analysis || "rgba(210,150,30,0.9)";
      ctx.lineWidth = Math.max(1.8, step * 0.07);
      ctx.setLineDash([Math.max(3, step * 0.12), Math.max(2.5, step * 0.09)]);
      ctx.beginPath();
      ctx.moveTo(x, y - rr);
      ctx.lineTo(x + rr, y);
      ctx.lineTo(x, y + rr);
      ctx.lineTo(x - rr, y);
      ctx.closePath();
      ctx.stroke();
      ctx.restore();
    }

    // Principal-variation preview (推演): translucent numbered ghost stones
    const variation = m.variation;
    if (variation && variation.length) {
      ctx.save();
      const rr = step * 0.4;
      const fontPx = Math.round(step * 0.34);
      for (const v of variation) {
        if (board[v.r] && board[v.r][v.c]) continue; // occupied — skip
        const x = pad + v.c * step;
        const y = pad + v.r * step;
        ctx.globalAlpha = 0.5;
        const sg = ctx.createRadialGradient(x - rr * 0.35, y - rr * 0.4, rr * 0.1, x, y, rr);
        if (v.color === "b") { sg.addColorStop(0, "#5a5a5a"); sg.addColorStop(1, "#111"); }
        else { sg.addColorStop(0, "#fff"); sg.addColorStop(1, "#c8c8c8"); }
        ctx.beginPath();
        ctx.arc(x, y, rr, 0, Math.PI * 2);
        ctx.fillStyle = sg;
        ctx.fill();
        ctx.globalAlpha = 0.7;
        ctx.strokeStyle = v.color === "b" ? "rgba(255,255,255,0.35)" : "rgba(0,0,0,0.3)";
        ctx.lineWidth = 1;
        ctx.stroke();
        // move number
        ctx.globalAlpha = 0.95;
        ctx.fillStyle = v.color === "b" ? "#fff" : "#1a1a1a";
        ctx.font = "600 " + fontPx + "px -apple-system, system-ui, sans-serif";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(String(v.n), x, y + step * 0.02);
      }
      ctx.restore();
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

  global.GobanDraw = {
    THEMES: THEMES,
    STARS: STARS,
    attach: attach,
    geometry: geometry,
    resizeCanvas: resizeCanvas,
    cellAt: cellAt,
    draw: draw,
    ensureAnimLoop: ensureAnimLoop,
  };
})(typeof window !== "undefined" ? window : globalThis);
