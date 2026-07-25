/**
 * SGF build / parse (FF4-ish, 15×15 gomoku).
 * @module sgf
 */
(function (global) {
  const t = (k, p) => (global.GobanI18n ? global.GobanI18n.t(k, p) : k);
  const Core = global.GobanCore;
  const SIZE = Core.SIZE;

  /** FF4 point: first letter = column, second = row, both from top-left ("aa"). */
  function sgfCoord(r, c) {
    return String.fromCharCode(97 + c) + String.fromCharCode(97 + r);
  }

  function parseSgfCoord(s) {
    if (!s || s.length < 2) return null;
    const c = s.charCodeAt(0) - 97;
    const r = s.charCodeAt(1) - 97;
    if (r < 0 || r >= SIZE || c < 0 || c >= SIZE) return null;
    return { r, c };
  }

  /** Escape SGF text so ] and \ inside C[] don't terminate the property. */
  function sgfText(s) {
    return String(s).replace(/\\/g, "\\\\").replace(/\]/g, "\\]");
  }

  /**
   * @param {object} opts
   * @param {{r:number,c:number}[]} opts.history
   * @param {string} opts.result play|b|w|draw
   * @param {string} opts.mode
   * @param {string} opts.humanColor
   * @param {number} opts.originalStartedAt
   * @param {Object<number,string>} [opts.comments] 0-based move index → C[] note
   * @param {string} [opts.rootComment] C[] note on the game-info (root) node
   */
  function buildSgf(opts) {
    const history = opts.history || [];
    const result = opts.result || "play";
    const mode = opts.mode || "ai";
    const humanColor = opts.humanColor || "b";
    const comments = opts.comments || null;
    const rootComment = opts.rootComment || "";
    const dt = new Date(opts.originalStartedAt || Date.now());
    const pad = (n) => String(n).padStart(2, "0");
    const dtStr =
      dt.getFullYear() + "-" + pad(dt.getMonth() + 1) + "-" + pad(dt.getDate());
    const re =
      result === "b" ? "B+R" : result === "w" ? "W+R" : result === "draw" ? "0" : "Void";
    let s =
      "(;FF[4]GM[4]SZ[" +
      SIZE +
      "]AP[Goban:" + (global.GOBAN_VERSION || "0.0.0") + "]DT[" +
      dtStr +
      "]RE[" +
      re +
      "]";
    if (mode === "ai") {
      s += "PB[" + (humanColor === "b" ? "Human" : "Computer") + "]";
      s += "PW[" + (humanColor === "w" ? "Human" : "Computer") + "]";
    } else {
      s += "PB[Black]PW[White]";
    }
    if (rootComment) s += "C[" + sgfText(rootComment) + "]";
    for (let i = 0; i < history.length; i++) {
      const p = history[i];
      const tag = i % 2 === 0 ? "B" : "W";
      s += ";" + tag + "[" + sgfCoord(p.r, p.c) + "]";
      if (comments && comments[i] != null) s += "C[" + sgfText(comments[i]) + "]";
    }
    s += ")";
    return s;
  }

  /**
   * Keep only the first game's main line. Sibling variations and later games
   * in a collection are dropped so a flat B[]/W[] scan cannot stitch branches.
   */
  function extractMainline(src) {
    let i = 0;
    while (i < src.length && src[i] !== "(") i++;
    if (i >= src.length) return src;
    let out = "";
    function skipPropValue() {
      i++; // past '['
      while (i < src.length) {
        if (src[i] === "\\") {
          i += 2;
          continue;
        }
        if (src[i] === "]") {
          i++;
          return;
        }
        i++;
      }
    }
    function walkTree(emit) {
      if (src[i] !== "(") return;
      if (emit) out += "(";
      i++;
      while (i < src.length) {
        const c = src[i];
        if (c === ";") {
          const start = i;
          i++;
          while (i < src.length && src[i] !== ";" && src[i] !== "(" && src[i] !== ")") {
            if (src[i] === "[") skipPropValue();
            else i++;
          }
          if (emit) out += src.slice(start, i);
        } else if (c === "(") {
          walkTree(emit);
          while (i < src.length && src[i] === "(") walkTree(false);
        } else if (c === ")") {
          if (emit) out += ")";
          i++;
          return;
        } else {
          if (emit) out += c;
          i++;
        }
      }
    }
    walkTree(true);
    return out || src;
  }

  /**
   * Minimal SGF parser: collect B[]/W[] along the main line only
   * (first variation at each fork; first game in a collection).
   * @returns {{ history: {r:number,c:number}[], error?: string }}
   */
  function parseSgf(text) {
    if (text == null) return { history: [], error: t("sgf.err.noContent") };
    if (typeof text !== "string") return { history: [], error: t("sgf.err.invalid") };
    let src = text.replace(/\uFEFF/g, "").replace(/\s+/g, " ").trim();
    if (!src) return { history: [], error: t("sgf.err.empty") };
    if (src.length > 200000) return { history: [], error: t("sgf.err.tooBig") };
    // Drop comment-style text properties first — their free text can contain
    // move lookalikes such as "B[ii]" (escaped \] respected).
    src = src.replace(/(^|[^A-Za-z])(?:GC|C)\[(?:\\[\s\S]|[^\]\\])*\]/g, "$1 ");
    src = extractMainline(src);
    if (!/[;\s]*[BW]\s*\[/i.test(src) && !/\(/.test(src)) {
      return { history: [], error: t("sgf.err.notSgf") };
    }
    const sz = src.match(/SZ\[(\d+)\]/i);
    if (sz && Number(sz[1]) !== SIZE) {
      return { history: [], error: t("sgf.err.size", { want: SIZE, got: sz[1] }) };
    }
    const history = [];
    const occupied = Core.emptyBoard();
    // Boundary required before B/W so setup props (AB[]/AW[]) and idents
    // ending in B/W never read as moves.
    const re = /(?:^|[;()\s])([BW])\s*\[([a-z]{0,2})\]/gi;
    let m;
    let skipped = 0;
    while ((m = re.exec(src))) {
      const color = m[1].toUpperCase() === "B" ? "b" : "w";
      const coord = m[2];
      if (!coord) { skipped++; continue; }
      const p = parseSgfCoord(coord.toLowerCase());
      if (!p) {
        return { history: [], error: t("sgf.err.coord", { raw: coord }) };
      }
      if (occupied[p.r][p.c]) {
        return {
          history: [],
          error: t("sgf.err.overlap", { n: history.length + 1, coord: coord }),
        };
      }
      const want = history.length % 2 === 0 ? "b" : "w";
      if (color !== want) {
        return {
          history: [],
          error: t("sgf.err.color", { n: history.length + 1, color: t(want === "b" ? "side.black" : "side.white") }),
        };
      }
      occupied[p.r][p.c] = color;
      history.push({ r: p.r, c: p.c });
    }
    if (!history.length) {
      return {
        history: [],
        error: t(skipped ? "sgf.err.onlyPass" : "sgf.err.noMoves"),
      };
    }
    return { history: history, skippedPasses: skipped };
  }

  function fileNameFromDate(ts) {
    // local wall-clock, not UTC — late-night exports should carry today's date
    const d = new Date(ts || Date.now());
    const p = (n) => String(n).padStart(2, "0");
    return (
      "goban-" +
      d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) +
      p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds()) +
      ".sgf"
    );
  }

  global.GobanSgf = {
    sgfCoord,
    parseSgfCoord,
    buildSgf,
    parseSgf,
    fileNameFromDate,
  };
})(typeof window !== "undefined" ? window : globalThis);
