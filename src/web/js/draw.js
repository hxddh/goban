/**
 * Canvas board rendering (themes + paint).
 * Model via attach(canvas, ctx, modelFn):
 *   board, history, viewIndex, themeId, placeAnim, winLine, winFlashUntil,
 *   clearPlaceAnim, hover {r,c,color}|null, hint {r,c}|null
 */
(function (global) {
  const SIZE = (global.GobanCore && global.GobanCore.SIZE) || 15;

  /** Rendered board luminance per theme, measured off the painted base.
   *  Drives how much edge a stone needs to keep its silhouette. */
  const BOARD_LUM = { wood: 188, night: 41, day: 227 };

  /** Stone radius as a fraction of the grid pitch. THE radius — see paintStone. */
  const STONE_R = 0.46;
  /** A preview stone is the real stone muted toward neutral grey by this much.
   *  Not made transparent: see paintStone. */
  const GHOST_GREY = "#8a8a8a";
  const GHOST_MIX = 0.42;

  const STARS = [
    [3, 3], [3, 7], [3, 11],
    [7, 3], [7, 7], [7, 11],
    [11, 3], [11, 7], [11, 11],
  ];

  const THEMES = {
    wood: {
      /* Matches the CSS --win token; before v1.36 the board used its own
         muted brick while the status pill and the frame glow used this, so a
         win wore two different colours in one app. */
      winGlow: "#ffe08a",
      boardTop: "#e8c49a", boardMid: "#d4a574", boardBot: "#c28b52",
      grain: true, line: "#3d2914", star: "#3d2914",
      style: "stone",
      lastB: "rgba(255,255,255,0.4)",
      lastW: "rgba(30,22,14,0.32)",
      win: "rgba(160, 70, 50, 0.55)",
      hint: "rgba(40, 110, 180, 0.75)",
      analysis: "rgba(210, 150, 30, 0.9)",
      forbid: "rgba(122, 38, 24, 0.85)",
    },
    night: {
      /* Matches the CSS --win token; before v1.36 the board used its own
         muted brick while the status pill and the frame glow used this, so a
         win wore two different colours in one app. */
      winGlow: "#a8e6cf",
      boardTop: "#1e332c", boardMid: "#172822", boardBot: "#101c18",
      grain: false, line: "#5a7a6c", star: "#7dcea0",
      style: "stone",
      lastB: "rgba(220,230,225,0.38)",
      lastW: "rgba(10,16,14,0.4)",
      win: "rgba(125, 206, 160, 0.55)",
      hint: "rgba(120, 220, 180, 0.8)",
      analysis: "rgba(240, 190, 90, 0.95)",
      forbid: "rgba(232, 119, 106, 0.85)",
    },
    day: {
      /* Matches the CSS --win token; before v1.36 the board used its own
         muted brick while the status pill and the frame glow used this, so a
         win wore two different colours in one app. */
      winGlow: "#a65d2e",
      boardTop: "#f6ead4", boardMid: "#ecd9b5", boardBot: "#e2cba0",
      grain: true, line: "#6b5344", star: "#6b5344",
      style: "stone",
      lastB: "rgba(255,255,255,0.45)",
      lastW: "rgba(40,35,28,0.3)",
      win: "rgba(140, 90, 50, 0.5)",
      hint: "rgba(50, 100, 170, 0.75)",
      analysis: "rgba(190, 130, 20, 0.9)",
      forbid: "rgba(160, 58, 36, 0.85)",
    },
    notebook: {
      /* Matches the CSS --win token; before v1.36 the board used its own
         muted brick while the status pill and the frame glow used this, so a
         win wore two different colours in one app. */
      winGlow: "#c0392b",
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
      forbid: "rgba(192, 57, 43, 0.85)",
    },
  };

  let _canvas = null;
  let _ro = null;
  /** dpr actually used for the backing store; line weights are authored in
   *  CSS px and multiplied by this, so a rule is one CSS pixel on every
   *  display and at every board size instead of drifting with the bitmap. */
  let _dpr = 1;
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
    observeSize(canvas);
  }

  /**
   * #board-wrap animates its width/height for .28s on every layout change and
   * the canvas is 100% of it, so the element's real size arrives frame by
   * frame — not at the instant the resize event fires. The window listener
   * sampled frame 0 and never looked again: after any window resize the
   * bitmap kept the OLD size while CSS showed the new one (measured: a 1576px
   * bitmap in an 828px box — a 1.90x resample that softened every line and
   * every stone, and only healed if something happened to toggle the panel,
   * whose own rAF loop re-measures for 340ms).
   *
   * Observing the element itself covers every cause — window resize, panel
   * toggle, browser zoom — and fires once per animated frame. Assigning
   * canvas.width cannot feed back into layout here, because the canvas is
   * sized width:100%/height:100% by CSS, so there is no observer loop.
   */
  function observeSize(canvas) {
    if (typeof ResizeObserver === "undefined" || _ro || !canvas) return;
    _ro = new ResizeObserver(function () {
      resizeCanvas();
      draw();
    });
    _ro.observe(canvas);
  }

  function getM() {
    return _model ? _model() : null;
  }

  /**
   * Whole-pixel pitch. With the fractional values this used to return
   * (pad 70.92, step 102.44 at w=1576) every one of the 30 grid lines landed
   * off the device-pixel grid: a nominally 3.15px line rendered as two solid
   * rows flanked by two half-tone rows, so the board's entire skeleton came
   * out soft. An integer pitch puts every intersection — and therefore every
   * stone centre, star point and marker — on whole pixels; the origin is
   * recomputed from it so the board stays centred rather than drifting right.
   */
  function geometry() {
    return pitchFor(_canvas.width);
  }

  /**
   * 整数格距,给定位图宽度。抽成独立函数是因为练习棋盘也要用同一条规则 ——
   * 它此前自己算 pad = w*0.04、step = (w-2pad)/14,得到 13.44 / 22.08 两个小数,
   * 30 条线全落在半像素上,正是 v1.35 在主棋盘上修掉的那个缺陷。
   */
  function pitchFor(w) {
    const step = Math.max(1, Math.round((w - 2 * (w * 0.045)) / (SIZE - 1)));
    const pad = Math.round((w - step * (SIZE - 1)) / 2);
    return { pad, step, w };
  }

  /** Stroke widths are rounded so the half-pixel rule below is well defined. */
  function inkW(v) { return Math.max(1, Math.round(v)); }
  /**
   * A stroke straddles its path. Centred on an integer it covers half a pixel
   * either side, which the rasteriser resolves as two grey rows; centred on
   * x.5 an odd width covers whole rows. Even widths want the integer.
   */
  function crisp(v, lineW) { return inkW(lineW) % 2 ? Math.round(v) + 0.5 : Math.round(v); }

  function resizeCanvas() {
    if (!_canvas) return;
    // Measure the canvas itself, not #board-wrap: the wrap's rect includes
    // the wooden frame padding, so sizing the backing store from it left the
    // bitmap ~16px larger than the display size — a fractional downscale
    // that blurred every line and stone.
    const rect = _canvas.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    _dpr = dpr;
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

  function drawOutlineTriangle(ctx, x, y, size, color, lineW) {
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

  function drawOutlineCircle(ctx, x, y, radius, color, lineW) {
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

  /** #rrggbb toward #rrggbb by t (six-digit hex only). Used to mute a stone into its own preview. */
  function mixHex(hex, target, t) {
    const a = parseInt(hex.slice(1), 16);
    const b = parseInt(target.slice(1), 16);
    const ch = (sh) => {
      const v = Math.round((((a >> sh) & 255)) + t * ((((b >> sh) & 255)) - (((a >> sh) & 255))));
      return (v < 16 ? "0" : "") + v.toString(16);
    };
    return "#" + ch(16) + ch(8) + ch(0);
  }

  // One stone, one place. The disc used to be drawn three times over — the
  // board itself, the hover preview, the 推演 variation — each carrying its own
  // radius and its own gradient stops. They drifted: v1.35 raised the board
  // stone from 0.43 to 0.46 and left the other two at 0.40, so the preview of
  // a stone was 13% smaller than the stone it previewed, small enough that the
  // grid line ran out from under it and the thing read as a smudge rather than
  // as "a stone lands here".
  //
  // opts.ghost is a preview: the same stone, muted rather than made
  // transparent. Transparency was the old approach and it could not work —
  // measured at the disc centre, a black stone at 0.38 alpha came out
  // rgb(54,42,29) on the wood board, rgb(66,86,77) on 夜 and rgb(83,68,59) on
  // 日: an olive cast that is neither of the two colours in the game, so the
  // preview could not even tell you WHICH stone was about to land. Muting each
  // gradient stop toward neutral grey keeps the hue honest on every board, and
  // an opaque disc hides the grid under it exactly as the real stone will. What
  // marks it as not-yet-placed is the missing cast shadow and the flattened
  // contrast — the two things that make a real stone sit ON the board.
  function paintStone(ctx, x, y, rr, s, themeId, opts) {
    const ghost = !!(opts && opts.ghost);
    const dpr = (opts && opts.dpr) || 1;
    const mute = ghost ? (c) => mixHex(c, GHOST_GREY, GHOST_MIX) : (c) => c;
    const sg = ctx.createRadialGradient(
      x - rr * 0.38, y - rr * 0.42, rr * 0.08, x, y, rr
    );
    if (s === "b") {
      if (themeId === "night") {
        sg.addColorStop(0, mute("#4a4a4a"));
        sg.addColorStop(0.35, mute("#1c1c1c"));
        sg.addColorStop(1, mute("#050505"));
      } else {
        sg.addColorStop(0, mute("#6a6a6a"));
        sg.addColorStop(0.4, mute("#242424"));
        sg.addColorStop(1, mute("#050505"));
      }
    } else {
      sg.addColorStop(0, mute("#ffffff"));
      sg.addColorStop(0.5, mute("#f2f2f2"));
      sg.addColorStop(1, mute(themeId === "day" ? "#c8c8c8" : "#bcbcbc"));
    }
    // A real shadow, cast by the stone itself. What was here before was a
    // second disc of the same radius offset by a flat 1.2/1.8 bitmap px
    // (0.9 CSS px) and filled solid — a hard-edged crescent that never scaled
    // with the stone, so it read as a printing slip rather than as weight.
    // Blur and offset now derive from rr, so a stone on a 448px board and one
    // on a 788px board sit the same way. Cost of the switch: +0.1ms/113 stones.
    ctx.save();
    if (!ghost) {
      ctx.shadowColor = themeId === "night" ? "rgba(0,0,0,0.5)" : "rgba(0,0,0,0.32)";
      ctx.shadowBlur = rr * 0.36;
      ctx.shadowOffsetX = rr * 0.05;
      ctx.shadowOffsetY = rr * 0.13;
    }
    ctx.beginPath();
    ctx.arc(x, y, rr, 0, Math.PI * 2);
    ctx.fillStyle = sg;
    ctx.fill();
    ctx.restore();

    // Edge definition, sized to how close this stone is to its board. A stone
    // that shares the board's luminance loses its silhouette, and every theme
    // has one such colour — measured edge contrast before this: 木 white 41.0
    // vs black 158.9, 日 white 4.6 vs black 201.2, 夜 black 25.2 vs white
    // 172.8. A shadow cannot fix the dark case (it only darkens, and 夜's board
    // is already at luminance 41) and an outline alone flattens the light case,
    // so each direction gets the treatment that suits it: light stones take a
    // thin dark contour, dark stones take a graded rim-light strongest at the
    // top-left, where the stone's own highlight already is.
    const boardLum = BOARD_LUM[themeId] != null ? BOARD_LUM[themeId] : 188;
    const raw = s === "b" ? 24 : 244;
    // A ghost is muted toward grey, so it needs the edge treatment its ACTUAL
    // luminance calls for, not the placed stone's.
    const stoneLum = ghost ? raw + GHOST_MIX * (138 - raw) : raw;
    const sep = Math.abs(stoneLum - boardLum) / 255;   // 0 = invisible
    const need = Math.max(0, 1 - sep / 0.62);          // 0 when separated
    if (s === "w") {
      ctx.beginPath();
      ctx.arc(x, y, rr, 0, Math.PI * 2);
      ctx.strokeStyle = "rgba(0,0,0," + (0.16 + 0.30 * need).toFixed(3) + ")";
      ctx.lineWidth = Math.max(1, dpr * (0.5 + 0.5 * need));
      ctx.stroke();
    } else if (need > 0.02) {
      const rim = ctx.createLinearGradient(x - rr, y - rr, x + rr, y + rr);
      rim.addColorStop(0, "rgba(255,255,255," + (0.42 * need).toFixed(3) + ")");
      rim.addColorStop(0.45, "rgba(255,255,255," + (0.12 * need).toFixed(3) + ")");
      rim.addColorStop(1, "rgba(255,255,255,0.02)");
      ctx.beginPath();
      ctx.arc(x, y, rr - 0.5, 0, Math.PI * 2);
      ctx.strokeStyle = rim;
      ctx.lineWidth = Math.max(1, dpr);
      ctx.stroke();
    }

    if (ghost) {
      // Without a cast shadow the disc has nothing holding it to the board, so
      // the silhouette has to come from a contour. It leans the way the stone
      // does — dark under a light preview, light under a dark one — so the ring
      // reads as the edge of a stone rather than as an outline drawn around it.
      ctx.beginPath();
      ctx.arc(x, y, rr - dpr * 0.5, 0, Math.PI * 2);
      ctx.strokeStyle = stoneLum > boardLum ? "rgba(0,0,0,0.34)" : "rgba(255,255,255,0.26)";
      ctx.lineWidth = Math.max(1, dpr);
      ctx.stroke();
    }
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

  /**
   * The whole static layer — board fill, grain, grid, stars, coordinate
   * labels, stones — painted into ANY context at ANY size, reading no module
   * state whatsoever.
   *
   * It exists because the app had two board renderers. practice.js carried its
   * own drawBoard(): fractional pitch (pad 13.44 / step 22.08, so all 30 lines
   * sat on half-pixels — the exact defect v1.35 fixed here), a fourth stone
   * radius (0.42 against STONE_R's 0.46), flat discs with no gradient, no
   * shadow and no contrast-adaptive edge, no star points and no board at all.
   * Every refinement v1.35–v1.37 landed stopped at the dialog's edge, and the
   * gap widened with each one. 练习 (130 puzzles) and 每日 are a whole mode
   * rendered by that second painter.
   *
   * Everything the live board needs and a still position does not — the place
   * animation, hover, hint, win glow — stays in draw(). What is shared is
   * exactly what "a position on a board" means.
   *
   * opts: { board, themeId, w, pad, step, dpr, coords, scaleFor }
   *   scaleFor(r, c) -> 1 for a still position; draw() passes stoneScale so the
   *   place animation keeps working.
   */
  function paintPosition(ctx, opts) {
    const board = opts.board;
    const themeId = opts.themeId;
    const w = opts.w;
    const pad = opts.pad;
    const step = opts.step;
    const dpr = opts.dpr || 1;
    const coords = !!opts.coords;
    const scaleFor = opts.scaleFor || function () { return 1; };
    const th = THEMES[themeId] || THEMES.wood;
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
        // This theme's stones are outlines, not fills, so anything drawn
        // underneath shows straight through them: the 天元 cross came up
        // inside the triangle sitting on it and read as noise. A star marks an
        // empty intersection; once a stone owns the point the mark has no job.
        if (board[r][c]) continue;
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
          const sc = scaleFor(r, c);
          ctx.save();
          ctx.translate(x, y);
          ctx.scale(sc, sc);
          ctx.translate(-x, -y);
          if (s === "b") drawOutlineTriangle(ctx, x, y, step * 0.78, inkB, lw);
          else drawOutlineCircle(ctx, x, y, markR, inkW, lw);
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
        // Was 48 evenly spaced straight lines, alternating black and white at
        // 3.5–4%: equal pitch, equal slope, alternating ink — the eye reads
        // that as banding, not as wood. Real grain is irregular in spacing,
        // weight and direction. The jitter is hashed from the band index, not
        // Math.random, so the texture is identical on every repaint (this is
        // the cached base layer; a re-rolled pattern would shimmer whenever
        // the board is rebuilt).
        ctx.save();
        ctx.lineCap = "round";
        const hash = (n) => {
          const v = Math.sin(n * 12.9898) * 43758.5453;
          return v - Math.floor(v); // 0..1, deterministic
        };
        const bands = 34;
        for (let i = 0; i < bands; i++) {
          const a = hash(i), b = hash(i + 91), c = hash(i + 173);
          // uneven pitch: nominal position nudged by up to ±0.6 of a gap
          const y = ((i + 0.5 + (a - 0.5) * 1.2) / bands) * w;
          const dark = b < 0.62;                       // more dark than light
          ctx.strokeStyle = dark ? "#000" : "#fff";
          ctx.globalAlpha = (themeId === "day" ? 0.030 : 0.038) * (0.45 + c);
          ctx.lineWidth = Math.max(1, w / 900) * (0.6 + a * 1.9);
          // a shallow arc rather than a straight rule, drifting up or down
          const drift = (c - 0.5) * w * 0.05;
          const bow = (a - 0.5) * w * 0.03;
          ctx.beginPath();
          ctx.moveTo(-w * 0.02, y);
          ctx.quadraticCurveTo(w * 0.5, y + bow, w * 1.02, y + drift);
          ctx.stroke();
        }
        ctx.restore();
      }

      ctx.strokeStyle = th.line;
      // Authored in CSS pixels. w/500 drifted with the board — 3 device px on
      // a 788px board, 2 on a 448px one — and after inkW() rounding there were
      // really only those two settings anyway. One CSS pixel is the classic
      // hairline and stays that at every size; the border keeps its weight so
      // the frame still reads above the grid.
      const gridW = inkW(dpr);
      ctx.lineWidth = gridW;
      ctx.lineCap = "square";
      const a0 = crisp(pad, gridW);
      const a1 = crisp(pad + step * (SIZE - 1), gridW);
      for (let i = 0; i < SIZE; i++) {
        const p = crisp(pad + i * step, gridW);
        ctx.beginPath();
        ctx.moveTo(a0, p);
        ctx.lineTo(a1, p);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(p, a0);
        ctx.lineTo(p, a1);
        ctx.stroke();
      }
      const edgeW = inkW(dpr * 2);
      ctx.lineWidth = edgeW;
      const e0 = crisp(pad - 1, edgeW);
      const e1 = crisp(pad + step * (SIZE - 1) + 1, edgeW);
      ctx.strokeRect(e0, e0, e1 - e0, e1 - e0);

      ctx.fillStyle = th.star;
      for (const [r, c] of STARS) {
        const x = pad + c * step;
        const y = pad + r * step;
        ctx.beginPath();
        ctx.arc(x, y, Math.max(2.5, step * 0.09), 0, Math.PI * 2);
        ctx.fill();
      }

      // 0.43 left a 7.2px gutter between neighbours at a 51px pitch, so a
      // four-in-a-row read as four separate discs. Real stones sit almost
      // edge to edge; 0.46 lets a line read as a line, which on a gomoku
      // board is the one thing the eye is there to do.
      const radius = step * STONE_R;
      for (let r = 0; r < SIZE; r++) {
        for (let c = 0; c < SIZE; c++) {
          const s = board[r][c];
          if (!s) continue;
          paintStone(
            ctx, pad + c * step, pad + r * step,
            radius * scaleFor(r, c), s, themeId, { dpr: dpr }
          );
        }
      }
    }

    // Coordinate labels: columns A-O along the bottom, rows 15-1 down the left
    if (coords) {
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
      paintPosition(baseCtx, {
        board: board, themeId: themeId, w: w, pad: pad, step: step,
        dpr: _dpr, coords: !!m.coords, scaleFor: stoneScale,
      });
      baseSig = animActive ? "" : sig;
    }

    ctx.clearRect(0, 0, w, w);
    ctx.drawImage(baseCanvas, 0, 0);

    // 禁手点(连珠,黑到手时)。落子前就画出来,规则才是能看见的东西,而不是走
    // 下去才弹出来的一句话。
    //
    // 形状是**空心方框**,不是叉 —— 叉这个形状已经有主了:练习本主题的星位画的
    // 正是同尺寸的叉(见 paintPosition 那一支)。截图里两者并排,只有颜色不同;
    // 而星位就在 (3,3)…(11,11) 九个点上,禁手点完全可能正落在其中一个上,那时
    // 会是两个叉叠在一起。一个形状只该有一个意思,所以换形状,不是换颜色。
    // 方框在四套主题里都没人用:圆点是星位、细圆环是最后一手、虚线圆是提示、
    // 虚线菱形是分析、三角与圆是练习本的棋子。描边而不是填充,是因为它是注记
    // 不是棋子 —— 与提示、分析同一个语域。
    const forbidden = m.forbidden;
    if (forbidden && forbidden.length) {
      ctx.save();
      ctx.strokeStyle = th.forbid || "rgba(150,58,44,0.5)";
      const lw = Math.max(1, step * 0.05);
      ctx.lineWidth = lw;
      ctx.lineJoin = "miter";
      const s2 = Math.max(2.5, step * 0.15);
      for (const p of forbidden) {
        if (board[p.r][p.c]) continue;
        const x = crisp(pad + p.c * step, lw);
        const y = crisp(pad + p.r * step, lw);
        ctx.strokeRect(x - s2, y - s2, s2 * 2, s2 * 2);
      }
      ctx.restore();
    }

    // Hover ghost (next stone preview)
    const hover = m.hover;
    if (hover && hover.r >= 0 && hover.c >= 0 && !board[hover.r][hover.c]) {
      const x = pad + hover.c * step;
      const y = pad + hover.r * step;
      const color = hover.color === "w" ? "w" : "b";
      ctx.save();
      ctx.globalAlpha = th.style === "pencil" ? 0.45 : 1;
      if (th.style === "pencil") {
        const ink = color === "b" ? (th.pencilB || th.pencil) : (th.pencilW || th.pencil);
        const lw = Math.max(1.5, step * 0.07);
        if (color === "b") drawOutlineTriangle(ctx, x, y, step * 0.72, ink, lw);
        else drawOutlineCircle(ctx, x, y, step * 0.34, ink, lw);
      } else {
        paintStone(ctx, x, y, step * STONE_R, color, themeId, { ghost: true, dpr: _dpr });
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

    // 键盘游标(v1.63):棋盘有焦点时方向键移动的那个交叉点。方角框比禁手的小方框
    // 大一圈、实线、用提示色 —— 四套主题里这个尺寸的方框没人用,与禁手不混。
    const cursor = m.cursor;
    if (cursor && cursor.r >= 0 && cursor.c >= 0) {
      const x = pad + cursor.c * step;
      const y = pad + cursor.r * step;
      const s2 = Math.max(6, step * 0.38);
      ctx.save();
      ctx.strokeStyle = th.hint || "rgba(40,110,180,0.75)";
      ctx.lineWidth = Math.max(2, step * 0.08);
      ctx.lineJoin = "round";
      ctx.strokeRect(x - s2, y - s2, s2 * 2, s2 * 2);
      ctx.restore();
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
      const rr = step * STONE_R;
      const fontPx = Math.round(step * 0.34);
      for (const v of variation) {
        if (board[v.r] && board[v.r][v.c]) continue; // occupied — skip
        const x = pad + v.c * step;
        const y = pad + v.r * step;
        ctx.globalAlpha = 1;
        paintStone(ctx, x, y, rr, v.color, themeId, { ghost: true, dpr: _dpr });
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
      // The win used to be one translucent rule drawn THROUGH the stones:
      // its colour carried alpha 0.5–0.55 and was then multiplied by a 0.62
      // globalAlpha, landing at an effective 0.31–0.34 — measured on the wood
      // board as rgb(88,46,28), a dull scratch across the five stones that
      // decided the game. The five stones are the subject, not the line
      // between them, so they get the emphasis: a glow ring around each, in
      // the same --win the status pill and the frame flash already use.
      const glow = th.winGlow || th.win;
      // The ring hugs the stone, so it is the stone's radius — not a copy of
      // today's value of it.
      const rr = step * STONE_R;
      ctx.save();
      ctx.lineCap = "round";
      // Connecting thread first, underneath the rings, so it reads as one
      // group rather than five separate marks.
      ctx.globalAlpha = 0.55;
      ctx.strokeStyle = glow;
      ctx.lineWidth = Math.max(1, step * 0.05);
      ctx.beginPath();
      for (let i = 0; i < winLine.length; i++) {
        const p = winLine[i];
        if (i === 0) ctx.moveTo(pad + p.c * step, pad + p.r * step);
        else ctx.lineTo(pad + p.c * step, pad + p.r * step);
      }
      ctx.stroke();
      ctx.globalAlpha = 1;
      for (const p of winLine) {
        const x = pad + p.c * step;
        const y = pad + p.r * step;
        ctx.save();
        ctx.shadowColor = glow;
        ctx.shadowBlur = rr * 0.75;
        ctx.beginPath();
        ctx.arc(x, y, rr + Math.max(1, _dpr), 0, Math.PI * 2);
        ctx.strokeStyle = glow;
        ctx.lineWidth = Math.max(1.5, _dpr * 1.4);
        ctx.stroke();
        ctx.stroke();  // second pass deepens the bloom without a wider ring
        ctx.restore();
      }
      ctx.restore();
    }
  }

  global.GobanDraw = {
    THEMES: THEMES,
    STARS: STARS,
    /** Exported so the regression gate can measure against the real value
     *  instead of restating 0.46 and passing whatever draw.js drifts to. */
    STONE_R: STONE_R,
    /** 无状态静态层画家。练习/每日的棋盘走的是这一个,而不是自己再写一份 —— 
     *  第二份画家正是 v1.35–v1.37 的每一次改进都停在弹层边缘的原因。 */
    paintPosition: paintPosition,
    /** 一颗棋子。虚影(ghost)与真子共用,见 paintStone 的注释。 */
    paintStone: paintStone,
    /** 整数格距:同一条规则给两块棋盘用,否则又会各算各的。 */
    pitchFor: pitchFor,
    attach: attach,
    geometry: geometry,
    resizeCanvas: resizeCanvas,
    cellAt: cellAt,
    draw: draw,
    ensureAnimLoop: ensureAnimLoop,
  };
})(typeof window !== "undefined" ? window : globalThis);
