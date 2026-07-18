/**
 * SGF build / parse (FF4-ish, 15×15 gomoku).
 * @module sgf
 */
(function (global) {
  const Core = global.GobanCore;
  const SIZE = Core.SIZE;

  function sgfCoord(r, c) {
    return String.fromCharCode(97 + c) + String.fromCharCode(97 + (SIZE - 1 - r));
  }

  function parseSgfCoord(s) {
    if (!s || s.length < 2) return null;
    const c = s.charCodeAt(0) - 97;
    const rowFromBottom = s.charCodeAt(1) - 97;
    const r = SIZE - 1 - rowFromBottom;
    if (r < 0 || r >= SIZE || c < 0 || c >= SIZE) return null;
    return { r, c };
  }

  /**
   * @param {object} opts
   * @param {{r:number,c:number}[]} opts.history
   * @param {string} opts.result play|b|w|draw
   * @param {string} opts.mode
   * @param {string} opts.humanColor
   * @param {number} opts.originalStartedAt
   */
  function buildSgf(opts) {
    const history = opts.history || [];
    const result = opts.result || "play";
    const mode = opts.mode || "ai";
    const humanColor = opts.humanColor || "b";
    const dt = new Date(opts.originalStartedAt || Date.now());
    const pad = (n) => String(n).padStart(2, "0");
    const dtStr =
      dt.getFullYear() + "-" + pad(dt.getMonth() + 1) + "-" + pad(dt.getDate());
    const re =
      result === "b" ? "B+R" : result === "w" ? "W+R" : result === "draw" ? "0" : "Void";
    let s =
      "(;FF[4]GM[4]SZ[" +
      SIZE +
      "]AP[Goban:1.9]DT[" +
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
    for (let i = 0; i < history.length; i++) {
      const p = history[i];
      const tag = i % 2 === 0 ? "B" : "W";
      s += ";" + tag + "[" + sgfCoord(p.r, p.c) + "]";
    }
    s += ")";
    return s;
  }

  /**
   * Minimal SGF parser: collect B[]/W[] in order. Ignores branches (takes first path).
   * @returns {{ history: {r:number,c:number}[], error?: string }}
   */
  function parseSgf(text) {
    if (!text || typeof text !== "string") return { history: [], error: "空棋谱" };
    const src = text.replace(/\s+/g, " ").trim();
    // strip size if present; we only support 15
    const sz = src.match(/SZ\[(\d+)\]/i);
    if (sz && Number(sz[1]) !== SIZE) {
      return { history: [], error: "仅支持 " + SIZE + " 路棋盘" };
    }
    const history = [];
    const occupied = Core.emptyBoard();
    // Match ;B[xx] or ;W[xx] (empty pass [] skipped)
    const re = /;?\s*([BW])\[([a-s]{0,2})\]/gi;
    let m;
    let expect = "b";
    while ((m = re.exec(src))) {
      const color = m[1].toUpperCase() === "B" ? "b" : "w";
      const coord = m[2];
      if (!coord) continue; // pass
      const p = parseSgfCoord(coord.toLowerCase());
      if (!p) continue;
      if (occupied[p.r][p.c]) {
        return { history: [], error: "棋谱含重复落点" };
      }
      // Allow out-of-order colors but warn by forcing sequential alternate if mismatch
      if (color !== expect && history.length > 0) {
        // still accept if it's the right stone for history length
        const want = history.length % 2 === 0 ? "b" : "w";
        if (color !== want) {
          return { history: [], error: "棋谱黑白顺序异常" };
        }
      }
      occupied[p.r][p.c] = color;
      history.push({ r: p.r, c: p.c });
      expect = Core.opp(color);
    }
    if (!history.length) return { history: [], error: "未找到落子" };
    return { history };
  }

  function fileNameFromDate(ts) {
    return (
      "goban-" +
      new Date(ts || Date.now()).toISOString().slice(0, 19).replace(/[:T]/g, "") +
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
